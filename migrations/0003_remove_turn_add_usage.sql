-- Removes the Cloudflare TURN integration seeded by 0002 (feature dropped in
-- favor of a WebTorrent-style tracker + Durable Object relay) and adds the
-- daily byte-quota ledger for the (wallet, User-Agent) identity model.

DELETE FROM services WHERE id = 'svc_cloudflare_turn';

CREATE TABLE IF NOT EXISTS usage_daily (
  identity     TEXT NOT NULL, -- sha-256 hex of "<wallet>|<user-agent>"
  day          TEXT NOT NULL, -- UTC date, YYYY-MM-DD
  bytes_total  INTEGER NOT NULL DEFAULT 0,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (identity, day)
);
