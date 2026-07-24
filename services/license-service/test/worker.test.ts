import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { createPasswordRecord } from "../src/auth";
import { adminLoginResponse, adminUiResponse } from "../src/admin-ui";
import { tokenDigest } from "../src/crypto";
import worker, { licenseServiceTesting } from "../src/index";
import type { Env, SignedLease } from "../src/types";

const TOKEN = "RJM-01234-56789-ABCDE-FGHJK-MNPQR";
const DEVICE_A = "a".repeat(64);
const DEVICE_B = "b".repeat(64);
const ADMIN_PASSWORD = "correct-horse-battery-staple-2026";

beforeEach(async () => {
  await env.LICENSE_DB.batch([
    env.LICENSE_DB.prepare("DELETE FROM license_events"),
    env.LICENSE_DB.prepare("DELETE FROM licenses"),
    env.LICENSE_DB.prepare("DELETE FROM admin_users"),
  ]);
  const sessions = await env.ADMIN_SESSIONS.list();
  await Promise.all(sessions.keys.map((key) => env.ADMIN_SESSIONS.delete(key.name)));
});

describe("公开激活与续签接口", () => {
  it("拒绝非法 token，且数据库不保存明文 token", async () => {
    const invalid = await call("/api/v1/activate", {
      token: "bad-token",
      deviceHash: DEVICE_A,
      platform: "macos",
      version: "1.0.0",
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.body.error.code).toBe("INVALID_TOKEN");

    const id = await seedLicense(TOKEN);
    const row = await env.LICENSE_DB.prepare(
      "SELECT token_digest, token_last4 FROM licenses WHERE id = ?",
    )
      .bind(id)
      .first<{ token_digest: string; token_last4: string }>();
    expect(row?.token_digest).not.toContain("RJM");
    expect(row?.token_digest).not.toContain("MNPQR");
    expect(row?.token_last4).toBe("NPQR");
  });

  it("首台设备原子绑定，同机重复激活幂等，第二台设备被拒绝", async () => {
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
    await seedLicense(TOKEN);
    const results = await Promise.all([activate(TOKEN, DEVICE_A), activate(TOKEN, DEVICE_B)]);
    expect(results.map((result) => result.response.status).sort()).toEqual([200, 409]);
    const row = await env.LICENSE_DB.prepare("SELECT device_hash FROM licenses").first<{
      device_hash: string;
    }>();
    expect([DEVICE_A, DEVICE_B]).toContain(row?.device_hash);
  });

  it("合法租约可以续签，篡改签名会被拒绝", async () => {
    await seedLicense(TOKEN);
    const activated = await activate(TOKEN, DEVICE_A);
    const renewed = await renew(activated.body.lease, DEVICE_A);
    expect(renewed.response.status).toBe(200);

    const tampered = structuredClone(activated.body.lease) as SignedLease;
    tampered.signature = `${tampered.signature.slice(0, -1)}A`;
    const rejected = await renew(tampered, DEVICE_A);
    expect(rejected.response.status).toBe(403);
    expect(rejected.body.error.code).toBe("LICENSE_EXPIRED");
  });

  it("撤销和重置都会让旧设备下次在线失效，重置后原 token 可绑定新机", async () => {
    const id = await seedLicense(TOKEN);
    const activated = await activate(TOKEN, DEVICE_A);
    await env.LICENSE_DB.prepare(
      "UPDATE licenses SET status = 'revoked', revoked_at = unixepoch() WHERE id = ?",
    )
      .bind(id)
      .run();
    const revoked = await renew(activated.body.lease, DEVICE_A);
    expect(revoked.body.error.code).toBe("REVOKED");

    await env.LICENSE_DB.prepare(
      `UPDATE licenses
       SET status = 'active', device_hash = NULL, generation = generation + 1, revoked_at = NULL
       WHERE id = ?`,
    )
      .bind(id)
      .run();
    const rebound = await activate(TOKEN, DEVICE_B);
    expect(rebound.response.status).toBe(200);
    const oldDevice = await renew(activated.body.lease, DEVICE_A);
    expect(oldDevice.body.error.code).toBe("REVOKED");
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

  it("账号密码正确时创建 KV 会话，D1 不保存明文密码", async () => {
    await seedAdmin("admin", ADMIN_PASSWORD);
    const wrong = await call(
      "/admin/api/login",
      { username: "admin", password: "wrong-password-value" },
      true,
      "POST",
      { origin: "https://licensed.example" },
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

    const row = await env.LICENSE_DB.prepare(
      "SELECT password_salt, password_hash FROM admin_users WHERE username = 'admin'",
    ).first<{ password_salt: string; password_hash: string }>();
    expect(row?.password_hash).not.toContain(ADMIN_PASSWORD);
    expect(row?.password_salt).not.toContain(ADMIN_PASSWORD);
  });

  it("登录受同源校验和独立限流保护，登出立即删除会话", async () => {
    await seedAdmin("admin", ADMIN_PASSWORD);
    const crossSite = await call("/admin/api/login", {
      username: "admin",
      password: ADMIN_PASSWORD,
    });
    expect(crossSite.response.status).toBe(401);
    expect(crossSite.body.error.code).toBe("AUTH_REQUIRED");

    const limited = await call(
      "/admin/api/login",
      { username: "admin", password: ADMIN_PASSWORD },
      true,
      "POST",
      { origin: "https://licensed.example" },
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
      { cookie: sessionCookie, origin: "https://licensed.example" },
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
    const database = await env.LICENSE_DB.prepare(
      "SELECT token_digest, token_last4, generation FROM licenses WHERE id = ?",
    )
      .bind(first.id)
      .first<{ token_digest: string; token_last4: string; generation: number }>();
    expect(database?.token_digest).not.toContain(first.token);
    expect(database?.token_last4).toBe(first.token.replaceAll("-", "").slice(-4));

    await env.LICENSE_DB.prepare(
      "UPDATE licenses SET device_hash = ?, activated_at = unixepoch() WHERE id = ?",
    )
      .bind(DEVICE_A, first.id)
      .run();
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
    const reset = await env.LICENSE_DB.prepare(
      "SELECT status, device_hash, generation FROM licenses WHERE id = ?",
    )
      .bind(first.id)
      .first<{ status: string; device_hash: string | null; generation: number }>();
    expect(reset).toMatchObject({ status: "active", device_hash: null, generation: 2 });
    const events = await env.LICENSE_DB.prepare(
      "SELECT event_type FROM license_events WHERE license_id = ? ORDER BY created_at",
    )
      .bind(first.id)
      .all<{ event_type: string }>();
    expect(events.results).toHaveLength(3);
    expect(events.results.map((event) => event.event_type)).toEqual(
      expect.arrayContaining(["generated", "revoked", "binding_reset"]),
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
  await env.LICENSE_DB.prepare(
    `INSERT INTO licenses
     (id, token_digest, token_last4, note, status, generation, created_at, updated_at)
     VALUES (?, ?, ?, 'test', 'active', 1, ?, ?)`,
  )
    .bind(
      id,
      await tokenDigest(token, env.TOKEN_PEPPER),
      token.replaceAll("-", "").slice(-4),
      now,
      now,
    )
    .run();
  return id;
}

async function seedAdmin(username: string, password: string) {
  const record = await createPasswordRecord(password);
  const now = Math.floor(Date.now() / 1000);
  await env.LICENSE_DB.prepare(
    `INSERT INTO admin_users
     (username, password_salt, password_hash, password_iterations, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`,
  )
    .bind(username, record.salt, record.hash, record.iterations, now, now)
    .run();
}

function login() {
  return call(
    "/admin/api/login",
    { username: "admin", password: ADMIN_PASSWORD },
    true,
    "POST",
    { origin: "https://licensed.example" },
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
  path: string,
  body?: unknown,
  rateLimitSuccess = true,
  method = "POST",
  headers: Record<string, string> = {},
  adminLoginRateLimitSuccess = true,
) {
  const context = createExecutionContext();
  const testEnv = serviceEnv(rateLimitSuccess, adminLoginRateLimitSuccess);
  const response = await worker.fetch(
    new Request(`https://licensed.example${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    testEnv,
    context,
  );
  await waitOnExecutionContext(context);
  return {
    response,
    body: (await response.json()) as {
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
    LICENSE_DB: env.LICENSE_DB,
    ADMIN_SESSIONS: env.ADMIN_SESSIONS,
    LICENSE_RATE_LIMITER: {
      limit: async () => ({ success: rateLimitSuccess }),
    },
    ADMIN_LOGIN_RATE_LIMITER: {
      limit: async () => ({ success: adminLoginRateLimitSuccess }),
    },
    TOKEN_PEPPER: env.TOKEN_PEPPER,
    LICENSE_PRIVATE_KEY_PEM: env.LICENSE_PRIVATE_KEY_PEM,
    LICENSE_PUBLIC_KEY_BASE64: env.LICENSE_PUBLIC_KEY_BASE64,
    PRODUCT_ID: env.PRODUCT_ID,
  };
}
