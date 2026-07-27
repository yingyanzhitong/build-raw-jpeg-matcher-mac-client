import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { createPasswordRecord, PASSWORD_ITERATIONS } from "../src/auth";
import { adminLoginResponse, adminUiResponse } from "../src/admin-ui";
import { tokenDigest } from "../src/crypto";
import worker, { licenseServiceTesting } from "../src/index";
import {
  createLicense,
  getClaim,
  getLicenseById,
  listLicenseEvents,
  putAdminUser,
  updateLicense,
} from "../src/storage";
import type { Env, SignedLease } from "../src/types";
import { MemoryBlobStore } from "./memory-store";

const TOKEN = "RJM-01234-56789-ABCDE-FGHJK-MNPQR";
const DEVICE_A = "a".repeat(64);
const DEVICE_B = "b".repeat(64);
const ADMIN_PASSWORD = "correct-horse-battery-staple-2026";
const PRIVATE_KEY = readFileSync(
  path.join(import.meta.dirname, "fixtures/test-ed25519-private.pem"),
  "utf8",
);

let store: MemoryBlobStore;

beforeEach(() => {
  store = new MemoryBlobStore();
});

describe("公开激活与续签接口", () => {
  it("健康检查确认许可证存储可用", async () => {
    const result = await call("/healthz", undefined, true, "GET");
    expect(result.response.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      version: "1.2.0",
      runtime: "tencent-scf",
    });
  });

  it("根路径跳转到账号密码管理后台", async () => {
    const result = await call("/", undefined, true, "GET");
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get("location")).toBe("/admin/");
  });

  it("未登录的管理后台使用同源相对跳转", async () => {
    const result = await call("/admin/", undefined, true, "GET");
    expect(result.response.status).toBe(302);
    expect(result.response.headers.get("location")).toBe("/admin/login");
  });

  it("拒绝非法 token，且 Blob 不保存明文 token", async () => {
    const invalid = await call("/api/v1/activate", {
      token: "bad-token",
      deviceHash: DEVICE_A,
      platform: "macos",
      version: "1.0.0",
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.error.code).toBe("INVALID_TOKEN");

    const id = await seedLicense(TOKEN);
    const row = await getLicenseById(serviceEnv(), id);
    expect(row?.token_digest).not.toContain("RJM");
    expect(row?.token_digest).not.toContain("MNPQR");
    expect(row?.token_last4).toBe("NPQR");
    expect(JSON.stringify(store.snapshot())).not.toContain(TOKEN);
  });

  it("首台设备绑定，同机重复激活幂等，第二台设备被拒绝", async () => {
    await seedLicense(TOKEN);
    const first = await activate(TOKEN, DEVICE_A);
    expect(first.response.status).toBe(200);
    expect(decodeLease(first.body.lease).device_hash).toBe(DEVICE_A);

    const repeated = await activate(TOKEN, DEVICE_A);
    expect(repeated.response.status).toBe(200);
    expect(decodeLease(repeated.body.lease).device_hash).toBe(DEVICE_A);

    const second = await activate(TOKEN, DEVICE_B);
    expect(second.response.status).toBe(409);
    expect(second.body.error.code).toBe("ALREADY_BOUND");
  });

  it("双设备并发激活只有一个成功", async () => {
    const id = await seedLicense(TOKEN);
    const results = await Promise.all([activate(TOKEN, DEVICE_A), activate(TOKEN, DEVICE_B)]);
    expect(results.map((result) => result.response.status).sort()).toEqual([200, 409]);
    const claim = await getClaim(serviceEnv(), id);
    expect([DEVICE_A, DEVICE_B]).toContain(claim?.device_hash);
  });

  it("合法租约可以续签，篡改签名会被拒绝", async () => {
    await seedLicense(TOKEN);
    const activated = await activate(TOKEN, DEVICE_A);
    const renewed = await renew(activated.body.lease, DEVICE_A);
    expect(renewed.response.status).toBe(200);

    const tampered = structuredClone(activated.body.lease) as SignedLease;
    const replacement = tampered.signature.startsWith("A") ? "B" : "A";
    tampered.signature = `${replacement}${tampered.signature.slice(1)}`;
    const rejected = await renew(tampered, DEVICE_A);
    expect(rejected.response.status).toBe(403);
    expect(rejected.body.error.code).toBe("LICENSE_EXPIRED");
  });

  it("撤销和重置都会让旧设备下次在线失效，重置后原 token 可绑定新机", async () => {
    const id = await seedLicense(TOKEN);
    const activated = await activate(TOKEN, DEVICE_A);
    const license = await getLicenseById(serviceEnv(), id);
    expect(license).not.toBeNull();
    await updateLicense(serviceEnv(), {
      ...license!,
      status: "revoked",
      revoked_at: Math.floor(Date.now() / 1000),
    });
    const revoked = await renew(activated.body.lease, DEVICE_A);
    expect(revoked.body.error.code).toBe("REVOKED");

    await licenseServiceTesting.mutateLicense(
      serviceEnv(),
      id,
      "reset",
      { username: "admin" },
      "request-reset",
    );
    const rebound = await activate(TOKEN, DEVICE_B);
    expect(rebound.response.status).toBe(200);
    const oldDevice = await renew(activated.body.lease, DEVICE_A);
    expect(oldDevice.body.error.code).toBe("LICENSE_EXPIRED");
  });

  it("限流器拒绝时返回稳定 RATE_LIMITED", async () => {
    const result = await call(
      "/api/v1/activate",
      { token: TOKEN, deviceHash: DEVICE_A, platform: "macos", version: "1.0.0" },
      false,
    );
    expect(result.response.status).toBe(429);
    expect(result.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("管理后台安全边界", () => {
  it("没有会话或伪造 Cookie 都无法访问管理 API", async () => {
    const missing = await call("/admin/api/licenses", undefined, true, "GET");
    expect(missing.response.status).toBe(401);
    expect(missing.body.error.code).toBe("AUTH_REQUIRED");

    const forged = await call(
      "/admin/api/licenses",
      undefined,
      true,
      "GET",
      { cookie: "rjm_admin_session=forged-session-token-that-is-long-enough-0000" },
    );
    expect(forged.response.status).toBe(401);
  });

  it("账号密码正确时创建 Blob 会话，且不保存明文密码", async () => {
    expect(PASSWORD_ITERATIONS).toBe(100_000);
    await seedAdmin("admin", ADMIN_PASSWORD);
    const wrong = await call(
      "/admin/api/login",
      { username: "admin", password: "wrong-password-value" },
      true,
      "POST",
      {
        origin:
          "https://1319909213-11o589l07z.ap-guangzhou.tencentscf.com",
      },
    );
    expect(wrong.response.status).toBe(401);
    expect(wrong.body.error.code).toBe("INVALID_CREDENTIALS");

    const loggedIn = await login();
    expect(loggedIn.response.status).toBe(200);
    const cookie = loggedIn.response.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");

    const authenticated = await call(
      "/admin/api/licenses",
      undefined,
      true,
      "GET",
      { cookie: cookie?.split(";")[0] ?? "" },
    );
    expect(authenticated.response.status).toBe(200);
    expect(JSON.stringify(store.snapshot())).not.toContain(ADMIN_PASSWORD);
  });

  it("登录受同源校验和独立限流保护，登出立即删除会话", async () => {
    await seedAdmin("admin", ADMIN_PASSWORD);
    const crossSite = await call("/admin/api/login", {
      username: "admin",
      password: ADMIN_PASSWORD,
    });
    expect(crossSite.response.status).toBe(401);
    expect(crossSite.body.error.code).toBe("AUTH_REQUIRED");

    const malformedOrigin = await call(
      "/admin/api/login",
      { username: "admin", password: ADMIN_PASSWORD },
      true,
      "POST",
      { origin: "::invalid-origin" },
    );
    expect(malformedOrigin.response.status).toBe(401);
    expect(malformedOrigin.body.error.code).toBe("AUTH_REQUIRED");

    const limited = await call(
      "/admin/api/login",
      { username: "admin", password: ADMIN_PASSWORD },
      true,
      "POST",
      {
        origin:
          "https://1319909213-11o589l07z.ap-guangzhou.tencentscf.com",
      },
      false,
    );
    expect(limited.response.status).toBe(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");

    const loggedIn = await login();
    const sessionCookie = loggedIn.response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const logout = await call(
      "/admin/api/logout",
      {},
      true,
      "POST",
      {
        cookie: sessionCookie,
        origin:
          "https://1319909213-11o589l07z.ap-guangzhou.tencentscf.com",
      },
    );
    expect(logout.response.status).toBe(200);
    expect(logout.response.headers.get("set-cookie")).toContain("Max-Age=0");
    const afterLogout = await call(
      "/admin/api/licenses",
      undefined,
      true,
      "GET",
      { cookie: sessionCookie },
    );
    expect(afterLogout.response.status).toBe(401);
  });

  it("批量生成只返回一次明文，审计生成、撤销与重置操作", async () => {
    const testEnv = serviceEnv();
    const generated = await licenseServiceTesting.generateLicenses(
      new Request("https://licensed.example/admin/api/licenses/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ count: 3, note: "订单 A" }),
      }),
      testEnv,
      { username: "admin" },
      "request-generate",
    );
    expect(generated.tokens).toHaveLength(3);
    expect(new Set(generated.tokens.map((item) => item.token)).size).toBe(3);

    const first = generated.tokens[0];
    const stored = await getLicenseById(testEnv, first.id);
    expect(stored?.token_digest).not.toContain(first.token);
    expect(stored?.token_last4).toBe(first.token.replaceAll("-", "").slice(-4));

    await activate(first.token, DEVICE_A);
    await licenseServiceTesting.mutateLicense(
      testEnv,
      first.id,
      "revoke",
      { username: "admin" },
      "request-revoke",
    );
    await licenseServiceTesting.mutateLicense(
      testEnv,
      first.id,
      "reset",
      { username: "admin" },
      "request-reset",
    );
    const reset = await getLicenseById(testEnv, first.id);
    const resetClaim = await getClaim(testEnv, first.id);
    expect(reset).toMatchObject({ status: "active", generation: 2 });
    expect(resetClaim).toBeNull();
    const events = await listLicenseEvents(testEnv, first.id);
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(["generated", "activated", "revoked", "binding_reset"]),
    );
  });

  it("管理页面包含账号密码登录、批量复制、CSV、撤销和重置入口", async () => {
    const loginHtml = await adminLoginResponse("/admin/login").text();
    const html = await adminUiResponse("/admin/").text();
    const script = await adminUiResponse("/admin/app.js").text();
    expect(loginHtml).toContain('type="password"');
    expect(loginHtml).not.toContain("邮箱");
    expect(html).toContain("logout");
    expect(html).toContain("export-csv");
    expect(html).toContain("copy-tokens");
    expect(script).toContain('confirmAction("revoke"');
    expect(script).toContain('confirmAction("reset"');
    expect(script).toContain('"/events"');
  });
});

async function seedLicense(token: string) {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await createLicense(serviceEnv(), {
    id,
    token_digest: await tokenDigest(token, serviceEnv().TOKEN_PEPPER),
    token_last4: token.replaceAll("-", "").slice(-4),
    note: "test",
    status: "active",
    generation: 1,
    created_at: now,
    revoked_at: null,
    updated_at: now,
  });
  return id;
}

async function seedAdmin(username: string, password: string) {
  const record = await createPasswordRecord(password);
  const now = Math.floor(Date.now() / 1000);
  await putAdminUser(serviceEnv(), {
    username,
    password_salt: record.salt,
    password_hash: record.hash,
    password_iterations: record.iterations,
    status: "active",
    created_at: now,
    updated_at: now,
    last_login_at: null,
  });
}

function login() {
  return call(
    "/admin/api/login",
    { username: "admin", password: ADMIN_PASSWORD },
    true,
    "POST",
    {
      origin:
        "https://1319909213-11o589l07z.ap-guangzhou.tencentscf.com",
    },
  );
}

function activate(token: string, deviceHash: string) {
  return call("/api/v1/activate", {
    token,
    deviceHash,
    platform: "macos",
    version: "1.0.0",
  });
}

function renew(lease: SignedLease, deviceHash: string) {
  return call("/api/v1/renew", {
    lease,
    deviceHash,
    platform: "macos",
    version: "1.0.0",
  });
}

async function call(
  requestPath: string,
  body?: unknown,
  rateLimitSuccess = true,
  method = "POST",
  headers: Record<string, string> = {},
  adminLoginRateLimitSuccess = true,
) {
  const pending: Promise<unknown>[] = [];
  const response = await worker.fetch(
    new Request(
      `https://1319909213-11o589l07z.ap-guangzhou.tencentscf.com${requestPath}`,
      {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    ),
    serviceEnv(rateLimitSuccess, adminLoginRateLimitSuccess),
    {
      waitUntil(promise) {
        pending.push(promise);
      },
    },
  );
  await Promise.all(pending);
  const responseText = await response.text();
  return {
    response,
    body: (responseText ? JSON.parse(responseText) : {}) as {
      ok: boolean;
      runtime?: string;
      version?: string;
      lease: SignedLease;
      error: { code: string; message: string };
    },
  };
}

function decodeLease(lease: SignedLease) {
  const encoded = lease.payload.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "="))) as {
    device_hash: string;
  };
}

function serviceEnv(rateLimitSuccess = true, adminLoginRateLimitSuccess = true): Env {
  return {
    LICENSE_STORE: store,
    LICENSE_RATE_LIMITER: {
      limit: async () => ({ success: rateLimitSuccess }),
    },
    ADMIN_LOGIN_RATE_LIMITER: {
      limit: async () => ({ success: adminLoginRateLimitSuccess }),
    },
    TOKEN_PEPPER: "test-only-token-pepper-with-at-least-32-bytes",
    LICENSE_PRIVATE_KEY_PEM: PRIVATE_KEY,
    LICENSE_PUBLIC_KEY_BASE64: "LjLA32R86oUYUpbT7dUyLLllccUyje6OIgpi/ANKdPg=",
    PRODUCT_ID: "raw-jpeg-matcher-licensed",
    CLAIM_SETTLE_MS: 0,
  };
}
