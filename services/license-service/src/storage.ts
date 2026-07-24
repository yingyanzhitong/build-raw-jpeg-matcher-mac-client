import type {
  AdminSession,
  AdminUserRow,
  Env,
  LicenseClaim,
  LicenseEvent,
  LicenseRecord,
  LicenseRow,
} from "./types";

const LICENSE_PREFIX = "licenses/";
const TOKEN_INDEX_PREFIX = "token-index/";
const CLAIM_PREFIX = "claims/";
const EVENT_PREFIX = "events/";
const ADMIN_PREFIX = "admins/";
const SESSION_PREFIX = "sessions/";
const RATE_PREFIX = "rate/";

export async function getLicenseByDigest(env: Env, digest: string) {
  const index = await getJson<{ id?: unknown }>(env, `${TOKEN_INDEX_PREFIX}${digest}.json`);
  return typeof index?.id === "string" ? getLicenseById(env, index.id) : null;
}

export function getLicenseById(env: Env, id: string) {
  return getJson<LicenseRecord>(env, licenseKey(id));
}

export async function createLicense(env: Env, license: LicenseRecord) {
  await writeNew(env, licenseKey(license.id), license);
  try {
    await writeNew(env, `${TOKEN_INDEX_PREFIX}${license.token_digest}.json`, {
      id: license.id,
    });
  } catch (error) {
    await env.LICENSE_STORE.delete(licenseKey(license.id));
    throw error;
  }
}

export function updateLicense(env: Env, license: LicenseRecord) {
  return env.LICENSE_STORE.setJSON(licenseKey(license.id), license);
}

export async function listLicenseRows(env: Env) {
  const records = await listJson<LicenseRecord>(env, LICENSE_PREFIX);
  return Promise.all(records.map((record) => hydrateLicense(env, record)));
}

export function getClaim(env: Env, licenseId: string) {
  return getJson<LicenseClaim>(env, claimKey(licenseId));
}

export async function claimLicense(env: Env, claim: LicenseClaim) {
  const key = claimKey(claim.license_id);
  const existing = await getClaim(env, claim.license_id);
  if (existing) {
    return { claim: existing, created: false };
  }
  try {
    await env.LICENSE_STORE.setJSON(key, claim, { onlyIfNew: true });
  } catch {
    const winner = await getClaim(env, claim.license_id);
    if (!winner) {
      throw new Error(`BLOB_CLAIM_FAILED:${key}`);
    }
    return { claim: winner, created: false };
  }
  await settleClaim(env);
  const winner = await getClaim(env, claim.license_id);
  if (!winner) {
    throw new Error(`BLOB_CLAIM_FAILED:${key}`);
  }
  return { claim: winner, created: winner.nonce === claim.nonce };
}

export function updateClaim(env: Env, claim: LicenseClaim) {
  return env.LICENSE_STORE.setJSON(claimKey(claim.license_id), claim);
}

export function deleteClaim(env: Env, licenseId: string) {
  return env.LICENSE_STORE.delete(claimKey(licenseId));
}

export async function hydrateLicense(env: Env, license: LicenseRecord): Promise<LicenseRow> {
  const claim = await getClaim(env, license.id);
  const currentClaim = claim?.generation === license.generation ? claim : null;
  return {
    ...license,
    device_hash: currentClaim?.device_hash ?? null,
    platform: currentClaim?.platform ?? null,
    activated_at: currentClaim?.activated_at ?? null,
    last_renewed_at: currentClaim?.last_renewed_at ?? null,
  };
}

export async function recordLicenseEvent(
  env: Env,
  event: LicenseEvent,
) {
  const key = `${EVENT_PREFIX}${event.licenseId}/${String(event.createdAt).padStart(12, "0")}-${event.id}.json`;
  await writeNew(env, key, event);
}

export async function listLicenseEvents(env: Env, licenseId: string) {
  const events = await listJson<LicenseEvent>(env, `${EVENT_PREFIX}${licenseId}/`);
  return events.sort((left, right) => right.createdAt - left.createdAt).slice(0, 200);
}

export function getAdminUser(env: Env, username: string) {
  return getJson<AdminUserRow>(env, `${ADMIN_PREFIX}${username}.json`);
}

export function putAdminUser(env: Env, user: AdminUserRow) {
  return env.LICENSE_STORE.setJSON(`${ADMIN_PREFIX}${user.username}.json`, user);
}

export function putSession(env: Env, key: string, session: AdminSession) {
  return env.LICENSE_STORE.setJSON(`${SESSION_PREFIX}${key}.json`, session);
}

export function getSession(env: Env, key: string) {
  return getJson<AdminSession>(env, `${SESSION_PREFIX}${key}.json`);
}

export function deleteSession(env: Env, key: string) {
  return env.LICENSE_STORE.delete(`${SESSION_PREFIX}${key}.json`);
}

export async function enforceStoredRateLimit(
  env: Env,
  scope: string,
  identifier: string,
  limit: number,
  periodSeconds: number,
) {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / periodSeconds);
  const digest = await sha256Hex(identifier);
  const key = `${RATE_PREFIX}${scope}/${digest}.json`;
  const existing = await getJson<{ window?: unknown; count?: unknown }>(env, key);
  const count =
    existing?.window === window && Number.isSafeInteger(existing.count)
      ? Number(existing.count)
      : 0;
  if (count >= limit) {
    return false;
  }
  await env.LICENSE_STORE.setJSON(key, { window, count: count + 1 });
  return true;
}

async function writeNew(env: Env, key: string, value: unknown) {
  try {
    await env.LICENSE_STORE.setJSON(key, value, { onlyIfNew: true });
  } catch {
    throw new Error(`BLOB_KEY_EXISTS:${key}`);
  }
}

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  return (await env.LICENSE_STORE.get<T>(key, {
    type: "json",
    consistency: "strong",
  })) as T | null;
}

async function listJson<T>(env: Env, prefix: string): Promise<T[]> {
  const { blobs } = await env.LICENSE_STORE.list({ prefix, consistency: "strong" });
  const values: T[] = [];
  for (const blob of blobs) {
    const value = await getJson<T>(env, blob.key);
    if (value !== null) {
      values.push(value);
    }
  }
  return values;
}

function licenseKey(id: string) {
  return `${LICENSE_PREFIX}${id}.json`;
}

function claimKey(id: string) {
  return `${CLAIM_PREFIX}${id}.json`;
}

async function sha256Hex(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function settleClaim(env: Env) {
  const configured = Number(env.CLAIM_SETTLE_MS ?? 750);
  const milliseconds = Number.isFinite(configured)
    ? Math.min(2_000, Math.max(0, configured))
    : 750;
  if (milliseconds > 0) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
