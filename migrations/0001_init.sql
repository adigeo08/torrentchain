-- Foundation schema for the SIWE-as-a-Service API.

CREATE TABLE IF NOT EXISTS nonces (
  nonce       TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_nonces_expires_at ON nonces (expires_at);

CREATE TABLE IF NOT EXISTS users (
  address        TEXT PRIMARY KEY, -- lowercase 0x eth address
  chain_id       INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY, -- jti embedded in the session JWT
  address     TEXT NOT NULL REFERENCES users (address) ON DELETE CASCADE,
  chain_id    INTEGER NOT NULL,
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_address ON sessions (address);

CREATE TABLE IF NOT EXISTS admins (
  address     TEXT PRIMARY KEY, -- lowercase 0x eth address allowed to call /admin
  label       TEXT,
  created_at  INTEGER NOT NULL
);

-- A 3rd-party service the admin has registered to receive access tokens.
CREATE TABLE IF NOT EXISTS services (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  description  TEXT,
  created_at   INTEGER NOT NULL,
  disabled_at  INTEGER
);

-- Access tokens issued (by the admin) for a service. Only the hash is
-- stored; the raw token is returned once at issuance time.
CREATE TABLE IF NOT EXISTS access_tokens (
  id          TEXT PRIMARY KEY,
  service_id  TEXT NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  subject     TEXT,               -- optional: eth address or arbitrary label this token acts as
  token_hash  TEXT NOT NULL UNIQUE, -- sha-256 hex of the raw token
  scopes      TEXT,               -- JSON array of scope strings
  issued_by   TEXT,               -- admin address/label who issued it
  issued_at   INTEGER NOT NULL,
  expires_at  INTEGER,
  revoked_at  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_access_tokens_service ON access_tokens (service_id);
CREATE INDEX IF NOT EXISTS idx_access_tokens_token_hash ON access_tokens (token_hash);
