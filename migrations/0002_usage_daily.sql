-- Daily byte-quota ledger for the (wallet, User-Agent) identity model, used
-- by the tracker relay to enforce a per-identity, per-UTC-day byte cap.

CREATE TABLE IF NOT EXISTS usage_daily (
  identity     TEXT NOT NULL, -- sha-256 hex of "<wallet>|<user-agent>"
  day          TEXT NOT NULL, -- UTC date, YYYY-MM-DD
  bytes_total  INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (identity, day)
);
