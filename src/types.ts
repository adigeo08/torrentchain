export interface Env {
  DB: D1Database;

  // Non-secret vars (wrangler.toml [vars])
  SIWE_DOMAIN: string;
  SIWE_URI: string;
  SESSION_TTL_SECONDS: string;
  NONCE_TTL_SECONDS: string;
  TURN_CREDENTIAL_TTL_SECONDS: string;
  TURN_CREDENTIAL_MAX_TTL_SECONDS: string;

  // Secrets (set with `wrangler secret put <NAME>`)
  ADMIN_API_KEY: string;
  SESSION_JWT_SECRET: string;
  TURN_KEY_ID: string;
  TURN_KEY_API_TOKEN: string;
}
