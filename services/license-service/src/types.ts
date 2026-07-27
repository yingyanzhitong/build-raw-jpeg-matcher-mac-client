export interface BlobStore {
  setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }): Promise<void>;
  get<T>(
    key: string,
    options: { type: "json"; consistency: "strong" },
  ): Promise<T | null>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    consistency?: "eventual" | "strong";
  }): Promise<{ blobs: Array<{ key: string; etag?: string }> }>;
}

export interface RateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  LICENSE_STORE: BlobStore;
  LICENSE_RATE_LIMITER?: RateLimiter;
  ADMIN_LOGIN_RATE_LIMITER?: RateLimiter;
  TOKEN_PEPPER: string;
  LICENSE_PRIVATE_KEY_PEM: string;
  LICENSE_PUBLIC_KEY_BASE64: string;
  PRODUCT_ID: string;
  CLAIM_SETTLE_MS?: string | number;
}

export interface LicenseRecord {
  id: string;
  token_digest: string;
  token_last4: string;
  note: string;
  status: "active" | "revoked";
  generation: number;
  created_at: number;
  revoked_at: number | null;
  updated_at: number;
}

export interface LicenseClaim {
  license_id: string;
  device_hash: string;
  platform: string;
  generation: number;
  activated_at: number;
  last_renewed_at: number;
  updated_at: number;
  nonce: string;
}

export interface LicenseRow extends LicenseRecord {
  device_hash: string | null;
  platform: string | null;
  activated_at: number | null;
  last_renewed_at: number | null;
}

export interface LicenseEvent {
  id: string;
  licenseId: string;
  eventType: string;
  createdAt: number;
  actor: string;
  requestId: string;
  platform: string | null;
  deviceSuffix: string | null;
  detailJson: string;
}

export interface LeasePayload {
  schema_version: 1;
  license_id: string;
  product: string;
  device_hash: string;
  generation: number;
  issued_at: number;
  renew_after: number;
  expires_at: number;
  grace_until: number;
}

export interface SignedLease {
  payload: string;
  signature: string;
}

export interface AdminIdentity {
  username: string;
}

export interface AdminUserRow {
  username: string;
  password_salt: string;
  password_hash: string;
  password_iterations: number;
  status: "active" | "disabled";
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

export interface AdminSession {
  username: string;
  createdAt: number;
  expiresAt: number;
}
