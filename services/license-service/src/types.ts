export interface Env {
  LICENSE_DB: D1Database;
  ADMIN_SESSIONS: KVNamespace;
  LICENSE_RATE_LIMITER: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
  ADMIN_LOGIN_RATE_LIMITER: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
  TOKEN_PEPPER: string;
  LICENSE_PRIVATE_KEY_PEM: string;
  LICENSE_PUBLIC_KEY_BASE64: string;
  PRODUCT_ID: string;
}

export interface LicenseRow {
  id: string;
  token_digest: string;
  token_last4: string;
  note: string;
  status: "active" | "revoked";
  device_hash: string | null;
  platform: string | null;
  generation: number;
  created_at: number;
  activated_at: number | null;
  last_renewed_at: number | null;
  revoked_at: number | null;
  updated_at: number;
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
}
