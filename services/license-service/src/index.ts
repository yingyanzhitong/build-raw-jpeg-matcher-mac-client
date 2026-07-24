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
import type { AdminIdentity, Env, LicenseRow, SignedLease } from "./types";

const PUBLIC_ERROR_CODES = new Set([
  "INVALID_TOKEN",
  "ALREADY_BOUND",
  "REVOKED",
  "RATE_LIMITED",
  "LICENSE_EXPIRED",
  "SERVER_ERROR",
]);
const PLATFORM_VALUES = new Set(["macos", "windows"]);

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
  async fetch(request: Request, env: Env, context: ExecutionContext) {
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        await env.LICENSE_DB.prepare("SELECT 1 AS ok").first();
        return json({ ok: true, service: "raw-jpeg-matcher-license" });
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
  let license = await env.LICENSE_DB.prepare(
    "SELECT * FROM licenses WHERE token_digest = ? LIMIT 1",
  )
    .bind(digest)
    .first<LicenseRow>();
  if (!license) {
    throw new ApiError("INVALID_TOKEN", "token 无效。");
  }
  if (license.status === "revoked") {
    throw new ApiError("REVOKED", "授权已撤销。", 403);
  }

  const now = unixNow();
  if (!license.device_hash) {
    const result = await env.LICENSE_DB.prepare(
      `UPDATE licenses
       SET device_hash = ?, platform = ?, activated_at = ?, last_renewed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'active' AND device_hash IS NULL`,
    )
      .bind(body.deviceHash, body.platform, now, now, now, license.id)
      .run();
    license = await env.LICENSE_DB.prepare("SELECT * FROM licenses WHERE id = ?")
      .bind(license.id)
      .first<LicenseRow>();
    if (!license) {
      throw new ApiError("SERVER_ERROR", "许可证记录读取失败。", 500);
    }
    if ((result.meta.changes ?? 0) > 0) {
      await recordEvent(env, license.id, "activated", "device", requestId, {
        platform: body.platform,
        deviceHash: body.deviceHash,
        version: body.version,
      });
    }
  }
  if (license.device_hash !== body.deviceHash) {
    throw new ApiError("ALREADY_BOUND", "token 已绑定另一台设备。", 409);
  }

  await env.LICENSE_DB.prepare(
    "UPDATE licenses SET last_renewed_at = ?, updated_at = ? WHERE id = ?",
  )
    .bind(now, now, license.id)
    .run();
  const current = { ...license, last_renewed_at: now, updated_at: now };
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
    typeof body.version !== "string"
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

  const license = await env.LICENSE_DB.prepare("SELECT * FROM licenses WHERE id = ?")
    .bind(payload.license_id)
    .first<LicenseRow>();
  if (
    !license ||
    license.status !== "active" ||
    license.device_hash !== body.deviceHash ||
    license.generation !== payload.generation
  ) {
    throw new ApiError("REVOKED", "授权已撤销或绑定已重置。", 403);
  }

  const now = unixNow();
  const update = await env.LICENSE_DB.prepare(
    `UPDATE licenses
     SET last_renewed_at = ?, platform = ?, updated_at = ?
     WHERE id = ? AND status = 'active' AND device_hash = ? AND generation = ?`,
  )
    .bind(now, body.platform, now, license.id, body.deviceHash, payload.generation)
    .run();
  if ((update.meta.changes ?? 0) !== 1) {
    throw new ApiError("REVOKED", "授权状态已变化。", 403);
  }
  const current = { ...license, last_renewed_at: now, platform: body.platform, updated_at: now };
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
      return Response.redirect(`${url.origin}/admin/login`, 302);
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
    const events = await env.LICENSE_DB.prepare(
      `SELECT id, event_type AS eventType, created_at AS createdAt, actor,
              request_id AS requestId, platform, device_suffix AS deviceSuffix,
              detail_json AS detailJson
       FROM license_events WHERE license_id = ? ORDER BY created_at DESC LIMIT 200`,
    )
      .bind(match[1])
      .all();
    return json({ items: events.results });
  }
  if (match && request.method === "POST" && (match[2] === "revoke" || match[2] === "reset")) {
    assertSameOrigin(request);
    return json(await mutateLicense(env, match[1], match[2], identity, requestId));
  }
  throw new ApiError("NOT_FOUND", "管理接口不存在。", 404);
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
      return {
        id: crypto.randomUUID(),
        token,
        digest: await tokenDigest(token, env.TOKEN_PEPPER),
        last4: token.replaceAll("-", "").slice(-4),
        note,
      };
    }),
  );
  const statements: D1PreparedStatement[] = [];
  for (const token of tokens) {
    statements.push(
      env.LICENSE_DB.prepare(
        `INSERT INTO licenses
         (id, token_digest, token_last4, note, status, generation, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 1, ?, ?)`,
      ).bind(token.id, token.digest, token.last4, token.note, now, now),
      eventStatement(env, token.id, "generated", identity.username, requestId, {}),
    );
  }
  await env.LICENSE_DB.batch(statements);
  return {
    tokens: tokens.map(({ id, token, note: itemNote }) => ({ id, token, note: itemNote })),
  };
}

async function listLicenses(env: Env, url: URL) {
  const limit = clampInteger(url.searchParams.get("limit"), 25, 1, 100);
  const offset = clampInteger(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const query = (url.searchParams.get("query") ?? "").trim().slice(0, 120);
  const status = url.searchParams.get("status") ?? "";
  const conditions: string[] = [];
  const parameters: unknown[] = [];
  if (query) {
    conditions.push("(id LIKE ? OR note LIKE ? OR token_last4 LIKE ?)");
    const pattern = `%${query}%`;
    parameters.push(pattern, pattern, pattern);
  }
  if (status === "active" || status === "revoked") {
    conditions.push("status = ?");
    parameters.push(status);
  } else if (status === "bound") {
    conditions.push("status = 'active' AND device_hash IS NOT NULL");
  } else if (status === "unbound") {
    conditions.push("status = 'active' AND device_hash IS NULL");
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const [items, count, total, bound, revoked] = await env.LICENSE_DB.batch([
    env.LICENSE_DB.prepare(
      `SELECT id, token_last4 AS tokenLast4, note, status,
              CASE WHEN device_hash IS NULL THEN NULL ELSE substr(device_hash, -8) END AS deviceSuffix,
              platform, generation, created_at AS createdAt, activated_at AS activatedAt,
              last_renewed_at AS lastRenewedAt, updated_at AS updatedAt
       FROM licenses ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ).bind(...parameters, limit, offset),
    env.LICENSE_DB.prepare(`SELECT COUNT(*) AS value FROM licenses ${where}`).bind(...parameters),
    env.LICENSE_DB.prepare("SELECT COUNT(*) AS value FROM licenses"),
    env.LICENSE_DB.prepare(
      "SELECT COUNT(*) AS value FROM licenses WHERE status = 'active' AND device_hash IS NOT NULL",
    ),
    env.LICENSE_DB.prepare("SELECT COUNT(*) AS value FROM licenses WHERE status = 'revoked'"),
  ]);
  const totalValue = metricValue(total);
  const boundValue = metricValue(bound);
  const revokedValue = metricValue(revoked);
  return {
    items: items.results,
    total: metricValue(count),
    metrics: {
      total: totalValue,
      bound: boundValue,
      unbound: Math.max(0, totalValue - boundValue - revokedValue),
      revoked: revokedValue,
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
  const now = unixNow();
  const result =
    action === "revoke"
      ? await env.LICENSE_DB.prepare(
          `UPDATE licenses SET status = 'revoked', revoked_at = ?, updated_at = ?
           WHERE id = ? AND status != 'revoked'`,
        )
          .bind(now, now, id)
          .run()
      : await env.LICENSE_DB.prepare(
          `UPDATE licenses
           SET status = 'active', device_hash = NULL, platform = NULL, generation = generation + 1,
               activated_at = NULL, last_renewed_at = NULL, revoked_at = NULL, updated_at = ?
           WHERE id = ?`,
        )
          .bind(now, id)
          .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ApiError("NOT_FOUND", "许可证不存在或状态未变化。", 404);
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
  await eventStatement(env, licenseId, eventType, actor, requestId, detail).run();
}

function eventStatement(
  env: Env,
  licenseId: string,
  eventType: string,
  actor: string,
  requestId: string,
  detail: { platform?: string; deviceHash?: string; version?: string },
) {
  const safeDetail = detail.version ? JSON.stringify({ version: detail.version }) : "{}";
  return env.LICENSE_DB.prepare(
    `INSERT INTO license_events
     (id, license_id, event_type, created_at, actor, request_id, platform, device_suffix, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    licenseId,
    eventType,
    unixNow(),
    actor,
    requestId,
    detail.platform ?? null,
    detail.deviceHash?.slice(-8) ?? null,
    safeDetail,
  );
}

async function enforceRateLimit(request: Request, env: Env) {
  const key =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const result = await env.LICENSE_RATE_LIMITER.limit({ key });
  if (!result.success) {
    throw new ApiError("RATE_LIMITED", "请求过于频繁，请稍后重试。", 429);
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

function metricValue(result: D1Result) {
  return Number((result.results[0] as { value?: unknown } | undefined)?.value ?? 0);
}

function clampInteger(value: string | null, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
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
  return Response.json(body, {
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
