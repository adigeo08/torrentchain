import type { Env } from "../types";

export interface AccessTokenRecord {
  id: string;
  service_id: string;
  subject: string | null;
  scopes: string | null;
  issued_by: string | null;
  issued_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

export interface ServiceRecord {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  disabled_at: number | null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function saveNonce(db: D1Database, nonce: string, ttlSeconds: number): Promise<void> {
  const now = nowSeconds();
  await db
    .prepare("INSERT INTO nonces (nonce, created_at, expires_at) VALUES (?1, ?2, ?3)")
    .bind(nonce, now, now + ttlSeconds)
    .run();
}

/** Consumes a nonce (single use). Returns false if it was missing, expired, or already used. */
export async function consumeNonce(db: D1Database, nonce: string): Promise<boolean> {
  const now = nowSeconds();
  const result = await db
    .prepare(
      "UPDATE nonces SET used_at = ?1 WHERE nonce = ?2 AND used_at IS NULL AND expires_at > ?1",
    )
    .bind(now, nonce)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function upsertUser(db: D1Database, address: string, chainId: number): Promise<void> {
  const now = nowSeconds();
  await db
    .prepare(
      `INSERT INTO users (address, chain_id, created_at, last_login_at)
       VALUES (?1, ?2, ?3, ?3)
       ON CONFLICT (address) DO UPDATE SET last_login_at = ?3, chain_id = ?2`,
    )
    .bind(address, chainId, now)
    .run();
}

export async function createSession(
  db: D1Database,
  id: string,
  address: string,
  chainId: number,
  ttlSeconds: number,
): Promise<{ issuedAt: number; expiresAt: number }> {
  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + ttlSeconds;
  await db
    .prepare(
      "INSERT INTO sessions (id, address, chain_id, issued_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(id, address, chainId, issuedAt, expiresAt)
    .run();
  return { issuedAt, expiresAt };
}

export async function isSessionActive(db: D1Database, id: string): Promise<boolean> {
  const now = nowSeconds();
  const row = await db
    .prepare(
      "SELECT 1 FROM sessions WHERE id = ?1 AND revoked_at IS NULL AND expires_at > ?2",
    )
    .bind(id, now)
    .first();
  return row !== null;
}

export async function revokeSession(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE sessions SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL")
    .bind(nowSeconds(), id)
    .run();
}

export async function isAdmin(db: D1Database, address: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM admins WHERE address = ?1")
    .bind(address.toLowerCase())
    .first();
  return row !== null;
}

export async function createService(
  db: D1Database,
  id: string,
  name: string,
  description: string | null,
): Promise<void> {
  await db
    .prepare("INSERT INTO services (id, name, description, created_at) VALUES (?1, ?2, ?3, ?4)")
    .bind(id, name, description, nowSeconds())
    .run();
}

export async function listServices(db: D1Database): Promise<ServiceRecord[]> {
  const { results } = await db
    .prepare("SELECT * FROM services ORDER BY created_at DESC")
    .all<ServiceRecord>();
  return results ?? [];
}

export async function getService(db: D1Database, id: string): Promise<ServiceRecord | null> {
  return db.prepare("SELECT * FROM services WHERE id = ?1").bind(id).first<ServiceRecord>();
}

export async function createAccessToken(
  db: D1Database,
  params: {
    id: string;
    serviceId: string;
    subject: string | null;
    tokenHash: string;
    scopes: string[] | null;
    issuedBy: string | null;
    expiresAt: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO access_tokens
        (id, service_id, subject, token_hash, scopes, issued_by, issued_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      params.id,
      params.serviceId,
      params.subject,
      params.tokenHash,
      params.scopes ? JSON.stringify(params.scopes) : null,
      params.issuedBy,
      nowSeconds(),
      params.expiresAt,
    )
    .run();
}

export async function listAccessTokens(
  db: D1Database,
  serviceId?: string,
): Promise<AccessTokenRecord[]> {
  const stmt = serviceId
    ? db
        .prepare(
          "SELECT id, service_id, subject, scopes, issued_by, issued_at, expires_at, revoked_at FROM access_tokens WHERE service_id = ?1 ORDER BY issued_at DESC",
        )
        .bind(serviceId)
    : db.prepare(
        "SELECT id, service_id, subject, scopes, issued_by, issued_at, expires_at, revoked_at FROM access_tokens ORDER BY issued_at DESC",
      );
  const { results } = await stmt.all<AccessTokenRecord>();
  return results ?? [];
}

export async function revokeAccessToken(db: D1Database, id: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE access_tokens SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL")
    .bind(nowSeconds(), id)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Looks up an access token by its raw value's hash and validates it's usable. */
export async function findActiveAccessTokenByHash(
  db: D1Database,
  tokenHash: string,
): Promise<AccessTokenRecord | null> {
  const now = nowSeconds();
  return db
    .prepare(
      `SELECT id, service_id, subject, scopes, issued_by, issued_at, expires_at, revoked_at
       FROM access_tokens
       WHERE token_hash = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)`,
    )
    .bind(tokenHash, now)
    .first<AccessTokenRecord>();
}

export function numericEnv(
  env: Env,
  key: "SESSION_TTL_SECONDS" | "NONCE_TTL_SECONDS" | "MAX_MESSAGE_BYTES" | "MAX_DAILY_BYTES",
  fallback: number,
): number {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Atomically reserves `bytes` of an identity's daily quota. Returns false
 * (reserving nothing) if this would push the identity's UTC-day total over
 * `capBytes`. Safe under concurrent callers: the reservation itself happens
 * in a single conditional UPDATE, so two Durable Objects charging the same
 * identity at once can't both succeed past the cap.
 */
export async function tryConsumeDailyQuota(
  db: D1Database,
  identity: string,
  bytes: number,
  capBytes: number,
): Promise<boolean> {
  const day = utcDay();
  const now = nowSeconds();

  await db
    .prepare(
      "INSERT INTO usage_daily (identity, day, bytes_total, updated_at) VALUES (?1, ?2, 0, ?3) ON CONFLICT (identity, day) DO NOTHING",
    )
    .bind(identity, day, now)
    .run();

  const result = await db
    .prepare(
      `UPDATE usage_daily
       SET bytes_total = bytes_total + ?3, updated_at = ?4
       WHERE identity = ?1 AND day = ?2 AND bytes_total + ?3 <= ?5`,
    )
    .bind(identity, day, bytes, now, capBytes)
    .run();

  return (result.meta.changes ?? 0) > 0;
}

/** Compensates a reservation made by tryConsumeDailyQuota that must be undone (e.g. the other side of a relay rejected it). */
export async function refundDailyQuota(db: D1Database, identity: string, bytes: number): Promise<void> {
  const day = utcDay();
  await db
    .prepare(
      "UPDATE usage_daily SET bytes_total = MAX(0, bytes_total - ?3), updated_at = ?4 WHERE identity = ?1 AND day = ?2",
    )
    .bind(identity, day, bytes, nowSeconds())
    .run();
}
