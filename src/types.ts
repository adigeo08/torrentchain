import type { TrackerRoom } from "./durable-objects/TrackerRoom";

export interface Env {
  DB: D1Database;
  TRACKER_ROOM: DurableObjectNamespace<TrackerRoom>;

  // Non-secret vars (wrangler.toml [vars])
  SIWE_DOMAIN: string;
  SIWE_URI: string;
  SESSION_TTL_SECONDS: string;
  NONCE_TTL_SECONDS: string;
  MAX_MESSAGE_BYTES: string;
  MAX_DAILY_BYTES: string;

  // Secrets (set with `wrangler secret put <NAME>`)
  ADMIN_API_KEY: string;
  SESSION_JWT_SECRET: string;
}
