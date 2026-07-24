import type { Env, LeasePayload, LicenseRow, SignedLease } from "./types";

const TOKEN_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TOKEN_BODY_LENGTH = 25;
const DAY_SECONDS = 24 * 60 * 60;

export function normalizeToken(input: string) {
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  if (!compact.startsWith("RJM")) {
    throw new Error("INVALID_TOKEN");
  }
  const body = compact.slice(3);
  if (
    body.length !== TOKEN_BODY_LENGTH ||
    [...body].some((character) => !TOKEN_ALPHABET.includes(character))
  ) {
    throw new Error("INVALID_TOKEN");
  }
  return `RJM-${body.match(/.{5}/g)?.join("-")}`;
}

export function generateToken() {
  const random = crypto.getRandomValues(new Uint8Array(20));
  let bits = "";
  for (const byte of random) {
    bits += byte.toString(2).padStart(8, "0");
  }
  let body = "";
  for (let index = 0; index < TOKEN_BODY_LENGTH; index += 1) {
    body += TOKEN_ALPHABET[Number.parseInt(bits.slice(index * 5, index * 5 + 5), 2)];
  }
  return normalizeToken(`RJM${body}`);
}

export async function tokenDigest(token: string, pepper: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(normalizeToken(token)),
  );
  return bytesToHex(new Uint8Array(digest));
}

export async function issueLease(env: Env, license: LicenseRow, now: number): Promise<SignedLease> {
  if (!license.device_hash) {
    throw new Error("license is not bound");
  }
  const payload: LeasePayload = {
    schema_version: 1,
    license_id: license.id,
    product: env.PRODUCT_ID,
    device_hash: license.device_hash,
    generation: license.generation,
    issued_at: now,
    renew_after: now + DAY_SECONDS,
    expires_at: now + 30 * DAY_SECONDS,
    grace_until: now + 37 * DAY_SECONDS,
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(env.LICENSE_PRIVATE_KEY_PEM),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("Ed25519", privateKey, payloadBytes);
  return {
    payload: bytesToBase64Url(payloadBytes),
    signature: bytesToBase64Url(new Uint8Array(signature)),
  };
}

export async function verifyLease(env: Env, lease: SignedLease): Promise<LeasePayload> {
  const payloadBytes = base64UrlToBytes(lease.payload);
  const signature = base64UrlToBytes(lease.signature);
  const publicKey = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(env.LICENSE_PUBLIC_KEY_BASE64),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify("Ed25519", publicKey, signature, payloadBytes);
  if (!valid) {
    throw new Error("LICENSE_EXPIRED");
  }
  const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as LeasePayload;
  if (
    payload.schema_version !== 1 ||
    payload.product !== env.PRODUCT_ID ||
    !payload.license_id ||
    !isDeviceHash(payload.device_hash) ||
    !Number.isSafeInteger(payload.generation)
  ) {
    throw new Error("LICENSE_EXPIRED");
  }
  return payload;
}

export function isDeviceHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function bytesToBase64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlToBytes(value: string) {
  return base64ToBytes(value.replace(/-/g, "+").replace(/_/g, "/"));
}

function pemToBytes(pem: string) {
  return base64ToBytes(
    pem
      .replace(/\\n/g, "\n")
      .replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, ""),
  );
}

function base64ToBytes(value: string) {
  const normalized = value.padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
