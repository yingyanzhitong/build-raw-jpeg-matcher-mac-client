CREATE TABLE licenses (
  id TEXT PRIMARY KEY,
  token_digest TEXT NOT NULL UNIQUE,
  token_last4 TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  device_hash TEXT,
  platform TEXT,
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  last_renewed_at INTEGER,
  revoked_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_licenses_status_updated
  ON licenses(status, updated_at DESC);

CREATE INDEX idx_licenses_device_hash
  ON licenses(device_hash);

CREATE TABLE license_events (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  actor TEXT NOT NULL,
  request_id TEXT,
  platform TEXT,
  device_suffix TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY (license_id) REFERENCES licenses(id) ON DELETE CASCADE
);

CREATE INDEX idx_license_events_license_created
  ON license_events(license_id, created_at DESC);
