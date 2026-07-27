import {
  AdminAuthError,
  assertSameOrigin,
  loginAdmin,
  logoutAdmin,
  requireAdminSession,
} from "./auth";
import { adminLoginResponse, adminUiResponse } from "./admin-ui";
import {
  generateToken,
  isDeviceHash,
  issueLease,
  normalizeToken,
  tokenDigest,
  verifyLease,
} from "./crypto";
import {
  claimLicense,
  createLicense,
  deleteClaim,
  enforceStoredRateLimit,
  getClaim,
  getLicenseByDigest,
  getLicenseById,
  hydrateLicense,
  listLicenseEvents,
  listLicenseRows,
  recordLicenseEvent,
  updateClaim,
  updateLicense,
} from "./storage";
import type {
  AdminIdentity,
  Env,
  LicenseClaim,
  LicenseRecord,
  LicenseRow,
  SignedLease,
} from "./types";

const PUBLIC_ERROR_CODES = new Set([
  "INVALID_TOKEN",
  "ALREADY_BOUND",
  "REVOKED",
  "RATE_LIMITED",
  "LICENSE_EXPIRED",
  "SERVER_ERROR",
]);
const PLATFORM_VALUES = new Set(["macos", "windows"]);

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContextLike) {
    const requestId =
      request.headers.get("eo-request-id") ??
      request.headers.get("x-request-id") ??
      request.headers.get("cf-ray") ??
      randomId();
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        await env.LICENSE_STORE.list({ prefix: "health/", consistency: "strong" });
        return json({
          ok: true,
          service: "raw-jpeg-matcher-license",
          runtime: "edgeone-node",
        });
      }
      if (request.method === "GET" && url.pathname === "/") {
        return redirect("/admin/");
      }
      if (url.pathname.startsWith("/admin")) {
        return await handleAdmin(request, env, url, requestId);
      }
      if (request.method === "POST" && url.pathname === "/api/v1/activate") {
        await enforceRateLimit(request, env);
        return json({ ok: true, lease: await activate(request, env, requestId) });
      }
      if (request.method === "POST" && url.pathname === "/api/v1/renew") {
        await enforceRateLimit(request, env);
        return json({ ok: true, lease: await renew(request, env, requestId) });
      }
      return json({ error: { code: "NOT_FOUND", message: "接口不存在。" } }, 404);
    } catch (error) {
      const apiError = normalizeError(error);
      context.waitUntil(
        Promise.resolve(
          console.log(
            JSON.stringify({
              event: "license_request",
              requestId,
              resultCode: apiError.code,
              status: apiError.status,
            }),
          ),
        ),
      );
      return json(
        { ok: false, error: { code: apiError.code, message: apiError.message } },
        apiError.status,
      );
    }
  },
};

async function activate(request: Request, env: Env, requestId: string): Promise<SignedLease> {
  const body = await readJson<{
    token?: unknown;
    deviceHash?: unknown;
    platform?: unknown;
    version?: unknown;
  }>(request);
  if (
    typeof body.token !== "string" ||
    !isDeviceHash(body.deviceHash) ||
    typeof body.platform !== "string" ||
    !PLATFORM_VALUES.has(body.platform) ||
    typeof body.version !== "string" ||
    body.version.length > 40
  ) {
    throw new ApiError("INVALID_TOKEN", "激活参数无效。");
  }

  let token: string;
  try {
    token = normalizeToken(body.token);
  } catch {
    throw new ApiError("INVALID_TOKEN", "token 无效。");
  }
  const digest = await tokenDigest(token, env.TOKEN_PEPPER);
  let license = await getLicenseByDigest(env, digest);
  if (!license) {
    throw new ApiError("INVALID_TOKEN", "token 无效。");
  }
  assertActiveLicense(license);

  const now = unixNow();
  const candidate: LicenseClaim = {
    license_id: license.id,
    device_hash: body.deviceHash,
    platform: body.platform,
    generation: license.generation,
    activated_at: now,
    last_renewed_at: now,
    updated_at: now,
    nonce: randomId(),
  };
  let outcome = await claimLicense(env, candidate);
  if (outcome.claim.generation !== license.generation) {
    await deleteClaim(env, license.id);
    outcome = await claimLicense(env, candidate);
  }
  let { claim, created } = outcome;
  if (
    claim.generation !== license.generation ||
    claim.device_hash !== body.deviceHash
  ) {
    throw new ApiError("ALREADY_BOUND", "token 已绑定另一台设备。", 409);
  }

  if (!created) {
    claim = {
      ...claim,
      platform: body.platform,
      last_renewed_at: now,
      updated_at: now,
    };
    await updateClaim(env, claim);
  }

  license = await getLicenseById(env, license.id);
  if (!license) {
    throw new ApiError("SERVER_ERROR", "许可证记录读取失败。", 500);
  }
  assertActiveLicense(license);
  if (license.generation !== claim.generation) {
    throw new ApiError("LICENSE_EXPIRED", "绑定已重置，请重新激活。", 403);
  }
  if (created) {
    await recordEvent(env, license.id, "activated", "device", requestId, {
      platform: body.platform,
      deviceHash: body.deviceHash,
      version: body.version,
    });
  }

  const current: LicenseRow = {
    ...license,
    device_hash: claim.device_hash,
    platform: claim.platform,
    activated_at: claim.activated_at,
    last_renewed_at: claim.last_renewed_at,
  };
  logSuccess("activate", requestId, current);
  return issueLease(env, current, now);
}

async function renew(request: Request, env: Env, requestId: string): Promise<SignedLease> {
  const body = await readJson<{
    lease?: unknown;
    deviceHash?: unknown;
    platform?: unknown;
    version?: unknown;
  }>(request);
  if (
    !isSignedLease(body.lease) ||
    !isDeviceHash(body.deviceHash) ||
    typeof body.platform !== "string" ||
    !PLATFORM_VALUES.has(body.platform) ||
    typeof body.version !== "string" ||
    body.version.length > 40
  ) {
    throw new ApiError("LICENSE_EXPIRED", "租约参数无效。");
  }

  let payload;
  try {
    payload = await verifyLease(env, body.lease);
  } catch {
    throw new ApiError("LICENSE_EXPIRED", "租约签名无效。", 403);
  }
  if (payload.device_hash !== body.deviceHash) {
    throw new ApiError("LICENSE_EXPIRED", "租约设备不匹配。", 403);
  }

  let license = await getLicenseById(env, payload.license_id);
  if (!license) {
    throw new ApiError("REVOKED", "授权不存在或已撤销。", 403);
  }
  assertActiveLicense(license);
  if (license.generation !== payload.generation) {
    throw new ApiError("LICENSE_EXPIRED", "绑定已重置，请重新激活。", 403);
  }
  let claim = await getClaim(env, license.id);
  if (
    !claim ||
    claim.generation !== license.generation ||
    claim.device_hash !== body.deviceHash
  ) {
    throw new ApiError("LICENSE_EXPIRED", "租约设备或代次不匹配。", 403);
  }

  const now = unixNow();
  claim = {
    ...claim,
    platform: body.platform,
    last_renewed_at: now,
    updated_at: now,
  };
  await updateClaim(env, claim);

  license = await getLicenseById(env, license.id);
  if (!license) {
    throw new ApiError("REVOKED", "授权不存在或已撤销。", 403);
  }
  assertActiveLicense(license);
  if (license.generation !== payload.generation) {
    throw new ApiError("LICENSE_EXPIRED", "绑定已重置，请重新激活。", 403);
  }
  const current = await hydrateLicense(env, license);
  if (current.device_hash !== body.deviceHash) {
    throw new ApiError("LICENSE_EXPIRED", "绑定状态已变化，请重新激活。", 403);
  }

  await recordEvent(env, license.id, "renewed", "device", requestId, {
    platform: body.platform,
    deviceHash: body.deviceHash,
    version: body.version,
  });
  logSuccess("renew", requestId, current);
  return issueLease(env, current, now);
}

async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  requestId: string,
) {
  if (
    request.method === "GET" &&
    (url.pathname === "/admin/login" ||
      url.pathname === "/admin/login.css" ||
      url.pathname === "/admin/login.js")
  ) {
    return adminLoginResponse(url.pathname);
  }
  if (request.method === "POST" && url.pathname === "/admin/api/login") {
    assertSameOrigin(request);
    const result = await loginAdmin(request, env);
    return json(
      { ok: true, username: result.identity.username },
      200,
      { "set-cookie": result.cookie },
    );
  }
  if (request.method === "POST" && url.pathname === "/admin/api/logout") {
    assertSameOrigin(request);
    const cookie = await logoutAdmin(request, env);
    return json({ ok: true }, 200, { "set-cookie": cookie });
  }

  let identity: AdminIdentity;
  try {
    identity = await requireAdminSession(request, env);
  } catch {
    if (
      request.method === "GET" &&
      (url.pathname === "/admin" || url.pathname === "/admin/")
    ) {
      return redirect("/admin/login");
    }
    throw new ApiError("AUTH_REQUIRED", "请先登录管理后台。", 401);
  }

  if (
    request.method === "GET" &&
    (url.pathname === "/admin" ||
      url.pathname === "/admin/" ||
      url.pathname === "/admin/app.css" ||
      url.pathname === "/admin/app.js")
  ) {
    return adminUiResponse(url.pathname);
  }
  if (request.method === "GET" && url.pathname === "/admin/api/session") {
    return json({ ok: true, username: identity.username });
  }
  if (request.method === "GET" && url.pathname === "/admin/api/licenses") {
    return json(await listLicenses(env, url));
  }
  if (request.method === "POST" && url.pathname === "/admin/api/licenses/generate") {
    assertSameOrigin(request);
    return json(await generateLicenses(request, env, identity, requestId), 201);
  }
  const match = url.pathname.match(
    /^\/admin\/api\/licenses\/([0-9a-f-]+)\/(events|revoke|reset)$/,
  );
  if (match?.[2] === "events" && request.method === "GET") {
    return json({ items: await listLicenseEvents(env, match[1]) });
  }
  if (match && request.method === "POST" && (match[2] === "revoke" || match[2] === "reset")) {
    assertSameOrigin(request);
    return json(await mutateLicense(env, match[1], match[2], identity, requestId));
  }
  throw new ApiError("NOT_FOUND", "管理接口不存在。", 404);
}

function redirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store",
      location,
    },
  });
}

async function generateLicenses(
  request: Request,
  env: Env,
  identity: AdminIdentity,
  requestId: string,
) {
  const body = await readJson<{ count?: unknown; note?: unknown }>(request);
  if (
    !Number.isInteger(body.count) ||
    Number(body.count) < 1 ||
    Number(body.count) > 100 ||
    (body.note !== undefined && typeof body.note !== "string")
  ) {
    throw new ApiError("BAD_REQUEST", "生成数量必须为 1 到 100。");
  }
  const count = Number(body.count);
  const note = String(body.note ?? "").trim().slice(0, 120);
  const now = unixNow();
  const tokens = await Promise.all(
    Array.from({ length: count }, async () => {
      const token = generateToken();
      const license: LicenseRecord = {
        id: randomId(),
        token_digest: await tokenDigest(token, env.TOKEN_PEPPER),
        token_last4: token.replaceAll("-", "").slice(-4),
        note,
        status: "active",
        generation: 1,
        created_at: now,
        revoked_at: null,
        updated_at: now,
      };
      await createLicense(env, license);
      await recordEvent(env, license.id, "generated", identity.username, requestId, {});
      return { id: license.id, token, note };
    }),
  );
  return { tokens };
}

async function listLicenses(env: Env, url: URL) {
  const limit = clampInteger(url.searchParams.get("limit"), 25, 1, 100);
  const offset = clampInteger(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const query = (url.searchParams.get("query") ?? "").trim().toLowerCase().slice(0, 120);
  const status = url.searchParams.get("status") ?? "";
  const allRows = await listLicenseRows(env);
  const filteredRows = allRows.filter((row) => {
    const matchesQuery =
      !query ||
      row.id.toLowerCase().includes(query) ||
      row.note.toLowerCase().includes(query) ||
      row.token_last4.toLowerCase().includes(query);
    const matchesStatus =
      !status ||
      (status === "active" && row.status === "active") ||
      (status === "revoked" && row.status === "revoked") ||
      (status === "bound" && row.status === "active" && row.device_hash !== null) ||
      (status === "unbound" && row.status === "active" && row.device_hash === null);
    return matchesQuery && matchesStatus;
  });
  filteredRows.sort((left, right) => right.updated_at - left.updated_at);
  const bound = allRows.filter(
    (row) => row.status === "active" && row.device_hash !== null,
  ).length;
  const revoked = allRows.filter((row) => row.status === "revoked").length;
  return {
    items: filteredRows.slice(offset, offset + limit).map(toAdminLicense),
    total: filteredRows.length,
    metrics: {
      total: allRows.length,
      bound,
      unbound: Math.max(0, allRows.length - bound - revoked),
      revoked,
    },
  };
}

async function mutateLicense(
  env: Env,
  id: string,
  action: "revoke" | "reset",
  identity: AdminIdentity,
  requestId: string,
) {
  const license = await getLicenseById(env, id);
  if (!license || (action === "revoke" && license.status === "revoked")) {
    throw new ApiError("NOT_FOUND", "许可证不存在或状态未变化。", 404);
  }
  const now = unixNow();
  if (action === "revoke") {
    await updateLicense(env, {
      ...license,
      status: "revoked",
      revoked_at: now,
      updated_at: now,
    });
  } else {
    await updateLicense(env, {
      ...license,
      status: "active",
      generation: license.generation + 1,
      revoked_at: null,
      updated_at: now,
    });
    await deleteClaim(env, id);
  }
  await recordEvent(
    env,
    id,
    action === "revoke" ? "revoked" : "binding_reset",
    identity.username,
    requestId,
    {},
  );
  return { ok: true };
}

async function recordEvent(
  env: Env,
  licenseId: string,
  eventType: string,
  actor: string,
  requestId: string,
  detail: { platform?: string; deviceHash?: string; version?: string },
) {
  await recordLicenseEvent(env, {
    id: randomId(),
    licenseId,
    eventType,
    createdAt: unixNow(),
    actor,
    requestId,
    platform: detail.platform ?? null,
    deviceSuffix: detail.deviceHash?.slice(-8) ?? null,
    detailJson: detail.version ? JSON.stringify({ version: detail.version }) : "{}",
  });
}

async function enforceRateLimit(request: Request, env: Env) {
  const key =
    request.headers.get("EO-Client-IP") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("CF-Connecting-IP") ??
    "unknown";
  const success = env.LICENSE_RATE_LIMITER
    ? (await env.LICENSE_RATE_LIMITER.limit({ key })).success
    : await enforceStoredRateLimit(env, "public-api", key, 20, 60);
  if (!success) {
    throw new ApiError("RATE_LIMITED", "请求过于频繁，请稍后重试。", 429);
  }
}

function assertActiveLicense(license: LicenseRecord) {
  if (license.status === "revoked") {
    throw new ApiError("REVOKED", "授权已撤销。", 403);
  }
}

async function readJson<T>(request: Request): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 64 * 1024) {
    throw new ApiError("SERVER_ERROR", "请求体过大。", 413);
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError("SERVER_ERROR", "请求体必须是 JSON。");
  }
}

function isSignedLease(value: unknown): value is SignedLease {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { payload?: unknown; signature?: unknown };
  return (
    typeof candidate.payload === "string" &&
    candidate.payload.length < 4096 &&
    typeof candidate.signature === "string" &&
    candidate.signature.length < 512
  );
}

function toAdminLicense(row: LicenseRow) {
  return {
    id: row.id,
    tokenLast4: row.token_last4,
    note: row.note,
    status: row.status,
    deviceSuffix: row.device_hash?.slice(-8) ?? null,
    platform: row.platform,
    generation: row.generation,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    lastRenewedAt: row.last_renewed_at,
    updatedAt: row.updated_at,
  };
}

function clampInteger(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function logSuccess(operation: string, requestId: string, license: LicenseRow) {
  console.log(
    JSON.stringify({
      event: "license_request",
      operation,
      requestId,
      resultCode: "OK",
      licenseId: license.id,
      deviceSuffix: license.device_hash?.slice(-8),
    }),
  );
}

function normalizeError(error: unknown) {
  if (error instanceof AdminAuthError) {
    if (error.code === "RATE_LIMITED") {
      return new ApiError("RATE_LIMITED", "登录尝试过于频繁，请稍后重试。", 429);
    }
    if (error.code === "INVALID_CREDENTIALS") {
      return new ApiError("INVALID_CREDENTIALS", "账号或密码错误。", 401);
    }
    return new ApiError("AUTH_REQUIRED", "请先登录管理后台。", 401);
  }
  if (error instanceof ApiError) {
    if (
      PUBLIC_ERROR_CODES.has(error.code) ||
      error.code.startsWith("AUTH_") ||
      error.code === "INVALID_CREDENTIALS" ||
      error.code === "NOT_FOUND" ||
      error.code === "BAD_REQUEST"
    ) {
      return error;
    }
  }
  console.error(
    JSON.stringify({
      event: "license_internal_error",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  return new ApiError("SERVER_ERROR", "服务暂时不可用，请稍后重试。", 500);
}

function json(body: unknown, status = 200, extraHeaders: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

export const licenseServiceTesting = {
  generateLicenses,
  listLicenses,
  mutateLicense,
};
