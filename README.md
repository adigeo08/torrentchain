# TorrentChain — SIWE-as-a-Service API

A Cloudflare Worker that provides Sign-In with Ethereum ([EIP-4361](https://eips.ethereum.org/EIPS/eip-4361),
via [spruceid/siwe](https://github.com/spruceid/siwe)) as a service, backed by D1.

This is the **foundation** of the project:

1. Cloudflare Worker + D1 for storage.
2. A SIWE authentication API (`/auth/*`) — nonce issuance, message verification, sessions.
3. An admin surface (`/admin/*`) for registering 3rd-party services and issuing them
   revocable access tokens, plus `/tokens/introspect` for those services to validate a token.
   Admin secrets live in Cloudflare (`wrangler secret put`), never in the database or repo.

## Project layout

```
src/
  index.ts               Hono app entrypoint, route mounting
  types.ts                Env bindings (D1 + secrets)
  lib/
    crypto.ts              nonce/id/token generation, sha-256 hashing
    jwt.ts                  session JWT sign/verify (jose)
    db.ts                   D1 queries
  middleware/
    sessionAuth.ts          bearer session JWT guard
    adminAuth.ts             ADMIN_API_KEY guard for /admin
  routes/
    auth.ts                 /auth/nonce, /auth/verify, /auth/session, /auth/logout
    admin.ts                 /admin/services, /admin/tokens
    tokens.ts                /tokens/introspect
migrations/
  0001_init.sql            D1 schema: nonces, users, sessions, admins, services, access_tokens
```

## Setup

```bash
npm install

# Create the D1 database (writes the new database_id — paste it into wrangler.toml)
npx wrangler d1 create torrentchain-siwe

# Apply migrations
npm run db:migrations:apply:local     # for `wrangler dev`
npm run db:migrations:apply:remote    # for the deployed Worker

# Local secrets for `wrangler dev`
cp .dev.vars.example .dev.vars
# edit .dev.vars with real values

# Production secrets
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put SESSION_JWT_SECRET
```

Also update `SIWE_DOMAIN` / `SIWE_URI` in `wrangler.toml` `[vars]` to match where this API
is deployed — SIWE verification checks the message's `domain` against `SIWE_DOMAIN`.

To let an admin authenticate as a specific address in the future, insert into the `admins`
table; today `/admin/*` is gated purely by the `ADMIN_API_KEY` bearer secret.

```bash
npm run dev       # wrangler dev
npm run deploy    # wrangler deploy
```

## API

### Auth (public)

- `GET /auth/nonce` → `text/plain` nonce, single-use, expires after `NONCE_TTL_SECONDS`.
- `POST /auth/verify` `{ message, signature }` → `{ token, address, chainId, expiresAt }`.
  `message` is the EIP-4361 SIWE message string the client had the wallet sign, embedding
  the nonce from `/auth/nonce`.
- `GET /auth/session` (bearer session token) → `{ address, chainId }`.
- `POST /auth/logout` (bearer session token) → revokes the session.

### Admin (bearer `ADMIN_API_KEY`)

- `POST /admin/services` `{ name, description? }` → registers a 3rd-party service.
- `GET /admin/services` → list services.
- `POST /admin/tokens` `{ serviceId, subject?, scopes?, expiresInSeconds?, issuedBy? }`
  → issues an access token for that service. The raw `token` is returned **once**; only
  its hash is stored.
- `GET /admin/tokens?serviceId=...` → list issued tokens (hashes/raw values never returned).
- `POST /admin/tokens/:id/revoke` → revokes a token.

### Tokens (public — for 3rd-party services holding a token)

- `POST /tokens/introspect` `{ token }` → `{ active, serviceId?, subject?, scopes?, expiresAt? }`.

## Notes

- Session tokens are HS256 JWTs (`SESSION_JWT_SECRET`) carrying a session id (`jti`); the
  id is also stored in D1 (`sessions` table) so sessions can be revoked before expiry.
- 3rd-party access tokens are opaque random strings (`sk_<serviceId>_<random>`); only their
  SHA-256 hash is persisted, so a stolen database dump doesn't leak usable tokens.
