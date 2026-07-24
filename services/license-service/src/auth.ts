import type { AdminIdentity, AdminUserRow, Env } from "./types";

const SESSION_COOKIE = "rjm_admin_session";
const SESSION_TTL_SECONDS = 12 * 60 * 60;
export const PASSWORD_ITERATIONS = 310_000;

export class AdminAuthError extends Error {
  constructor(readonly code: "AUTH_REQUIRED" | "INVALID_CREDENTIALS" | "RATE_LIMITED") {
    super(code);
  }
}

export async function loginAdmin(
  request: Request,
  env: Env,
): Promise<{ identity: AdminIdentity; cookie: string }> {
  const body = await readCredentials(request);
  const username = normalizeUsername(body.username);
  const password = body.password;
  await enforceLoginRateLimit(request, env, username);

  const user = await env.LICENSE_DB.prepare(
    `SELECT username, password_salt, password_hash, password_iterations, status
     FROM admin_users WHERE username = ? LIMIT 1`,
  )
    .bind(username)
    .first<AdminUserRow>();
  const validHash = await verifyPassword(
    password,
    user?.password_salt ?? "c29tZS1ub25zZW5zaXRpdmUtc2FsdA",
    user?.password_hash ?? "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    user?.password_iterations ?? PASSWORD_ITERATIONS,
  );
  const valid = user?.status === "active" && validHash;
  if (!valid) {
    throw new AdminAuthError("INVALID_CREDENTIALS");
  }

  const token = randomBase64Url(32);
  const sessionKey = await sessionStorageKey(token);
  const now = Math.floor(Date.now() / 1000);
  await Promise.all([
    env.ADMIN_SESSIONS.put(
      sessionKey,
      JSON.stringify({ username: user.username, createdAt: now }),
      { expirationTtl: SESSION_TTL_SECONDS },
    ),
    env.LICENSE_DB.prepare(
      "UPDATE admin_users SET last_login_at = ?, updated_at = ? WHERE username = ?",
    )
      .bind(now, now, user.username)
      .run(),
  ]);
  return {
    identity: { username: user.username },
    cookie: serializeSessionCookie(token, SESSION_TTL_SECONDS),
  };
}

export async function requireAdminSession(
  request: Request,
  env: Pick<Env, "ADMIN_SESSIONS">,
): Promise<AdminIdentity> {
  const token = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
    throw new AdminAuthError("AUTH_REQUIRED");
  }
  const session = await env.ADMIN_SESSIONS.get<{ username?: unknown }>(
    await sessionStorageKey(token),
    "json",
  );
  if (!session || typeof session.username !== "string") {
    throw new AdminAuthError("AUTH_REQUIRED");
  }
  return { username: session.username };
}

export async function logoutAdmin(request: Request, env: Pick<Env, "ADMIN_SESSIONS">) {
  const token = parseCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (token) {
    await env.ADMIN_SESSIONS.delete(await sessionStorageKey(token));
  }
  return serializeSessionCookie("", 0);
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    throw new AdminAuthError("AUTH_REQUIRED");
  }
}

export async function createPasswordRecord(password: string, salt = randomBase64Url(16)) {
  validatePassword(password);
  return {
    salt,
    hash: await derivePasswordHash(password, salt, PASSWORD_ITERATIONS),
    iterations: PASSWORD_ITERATIONS,
  };
}

async function readCredentials(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AdminAuthError("INVALID_CREDENTIALS");
  }
  const candidate = body as { username?: unknown; password?: unknown };
  if (typeof candidate.username !== "string" || typeof candidate.password !== "string") {
    throw new AdminAuthError("INVALID_CREDENTIALS");
  }
  validatePassword(candidate.password);
  return { username: candidate.username, password: candidate.password };
}

function normalizeUsername(value: string) {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) {
    throw new AdminAuthError("INVALID_CREDENTIALS");
  }
  return username;
}

function validatePassword(password: string) {
  if (password.length < 12 || password.length > 256) {
    throw new AdminAuthError("INVALID_CREDENTIALS");
  }
}

async function enforceLoginRateLimit(request: Request, env: Env, username: string) {
  const ip =
    request.headers.get("CF-Connecting-IP") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const result = await env.ADMIN_LOGIN_RATE_LIMITER.limit({ key: `${ip}:${username}` });
  if (!result.success) {
    throw new AdminAuthError("RATE_LIMITED");
  }
}

async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
  iterations: number,
) {
  if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) {
    return false;
  }
  const actualHash = await derivePasswordHash(password, salt, iterations);
  return constantTimeEqual(actualHash, expectedHash);
}

async function derivePasswordHash(password: string, salt: string, iterations: number) {
  let saltBytes: Uint8Array;
  try {
    saltBytes = base64UrlToBytes(salt);
  } catch {
    return "";
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: saltBytes,
      iterations,
    },
    key,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

async function sessionStorageKey(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return `admin-session:${bytesToHex(new Uint8Array(digest))}`;
}

function serializeSessionCookie(token: string, maxAge: number) {
  return [
    `${SESSION_COOKIE}=${token}`,
    "Path=/admin",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

function parseCookie(header: string | null, name: string) {
  for (const item of header?.split(";") ?? []) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) {
      return value.join("=");
    }
  }
  return null;
}

function randomBase64Url(length: number) {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
