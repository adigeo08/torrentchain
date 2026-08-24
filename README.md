# TorrentChain — SIWE-as-a-Service API

A Cloudflare Worker that provides Sign-In with Ethereum ([EIP-4361](https://eips.ethereum.org/EIPS/eip-4361),
via [spruceid/siwe](https://github.com/spruceid/siwe)) as a service, backed by D1.

This is the **foundation** of the project:

1. Cloudflare Worker + D1 for storage (live database: `torrentchain-siwe`).
2. A SIWE authentication API (`/auth/*`) — nonce issuance, message verification, sessions.
3. An admin surface (`/admin/*`) for registering 3rd-party services and issuing them
   revocable access tokens, plus `/tokens/introspect` for those services to validate a token.
   Admin secrets live in Cloudflare (`wrangler secret put`), never in the database or repo.
4. A WebSocket relay for WebTorrent-style peers (`/tracker/*`): a minimal
   tracker (peer discovery / announce) backed by a Durable Object per swarm,
   where the tracker connection **is** the transport — there is no WebRTC/ICE
   offer-answer exchange. Cloudflare is the relay by construction: every byte
   between two authenticated peers passes through the Worker.

## Why no WebRTC/TURN

An earlier iteration of this project used Cloudflare Realtime TURN to relay
WebRTC data channels. That was dropped: TURN only sees traffic when direct
peer-to-peer fails (unless you force `iceTransportPolicy: "relay"`), its
per-credential usage is only visible after the fact via lagged GraphQL
Analytics, and there's no way to hard-cap a single credential's bytes or
revoke it before its TTL. None of that fits a requirement of *exact*,
real-time per-session and per-day byte caps.

Cloudflare Workers also cannot terminate raw inbound TCP/TLS (no way to run
an actual RFC 5766 TURN server in a Worker — `connect()` is outbound-only).
What Workers *can* terminate is a WebSocket (TLS-over-TCP framing via HTTP
Upgrade), so the relay here is a plain WebSocket connection into a Durable
Object, which forwards frames between the two peers in a swarm. This gives
exact, synchronous control over both limits (§ Tracker below) with no
reliance on external analytics.

We did not vendor the `bittorrent-tracker` npm package: its `Server` class
depends on Node's `net`/`dgram`/`http.Server` to accept inbound TCP/UDP
connections, which the Workers runtime does not support (`connect()` is
outbound-only; there is no way to accept a raw inbound socket in a Worker).
`/tracker/*` instead implements a small, hand-rolled announce+relay wire
protocol inspired by the WebTorrent tracker WebSocket protocol.

## Project layout

```
src/
  index.ts                 Hono app entrypoint, route + Durable Object exports
  types.ts                  Env bindings (D1, Durable Object, secrets)
  lib/
    crypto.ts                nonce/id/token generation, sha-256 hashing
    identity.ts               (wallet address, User-Agent) -> identity hash
    jwt.ts                     session JWT sign/verify (jose)
    db.ts                      D1 queries, daily quota ledger
  middleware/
    sessionAuth.ts             bearer session JWT guard
    adminAuth.ts                ADMIN_API_KEY guard for /admin
  routes/
    auth.ts                    /auth/nonce, /auth/verify, /auth/session, /auth/logout
    admin.ts                    /admin/services, /admin/tokens
    tokens.ts                   /tokens/introspect
    tracker.ts                  /tracker/:infoHash WebSocket upgrade -> Durable Object
  durable-objects/
    TrackerRoom.ts               one instance per swarm (info_hash): announce + relay
migrations/
  0001_init.sql             D1 schema: nonces, users, sessions, admins, services, access_tokens
  0002_seed_turn_service.sql    (superseded by 0003, kept for history)
  0003_remove_turn_add_usage.sql   removes the TURN seed, adds usage_daily
```

## Setup

The D1 database (`torrentchain-siwe`, id in `wrangler.toml`) already exists in the
Cloudflare account. To provision from scratch elsewhere:

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

### Tracker + relay (`/tracker/:infoHash`)

`GET /tracker/:infoHash?token=<session JWT>` — WebSocket upgrade. `infoHash` names the
swarm (e.g. the torrent's info hash, or any shared room id two peers agree on). The
session token is passed as a query param because browsers cannot set custom headers on
a WebSocket handshake; the Worker still validates it exactly like `/auth/session` does
(signature + `sessions` table, so a revoked/expired session is rejected).

"Identity" for quota purposes is `sha256(walletAddress + "|" + userAgentHeader)` — the
same wallet on two different clients/browsers counts as two identities (kept for
anti-abuse per the requirements; note a User-Agent string is client-supplied and
trivially spoofable, so treat this as friction, not a hard security boundary).

Once connected, send/receive JSON text frames:

- **Announce** (peer discovery):
  ```json
  { "action": "announce" }
  ```
  → `{ "action": "announce", "info_hash", "interval": 30, "complete", "incomplete": 0, "peers": ["<peerId>", ...] }`.
  Other peers already in the swarm receive `{ "action": "peer_joined", "peer_id" }`;
  on disconnect, everyone still in the swarm receives `{ "action": "peer_left", "peer_id" }`.

- **Relay** (the actual payload — no ICE/SDP involved, this goes straight to the target peer):
  ```json
  { "action": "relay", "to_peer_id": "<peerId>", "payload_type": "json" | "html", "payload": "<string, ≤64KB>" }
  ```
  → sender gets `{ "action": "relay_ack", "bytes" }`; the target peer gets
  `{ "action": "relay", "from_peer_id", "payload_type", "payload" }`.

Two limits are enforced directly in the Durable Object, synchronously, before any byte
is forwarded — no reliance on delayed analytics:

- **64KB per session**: each WebSocket connection may send **at most one** `relay`
  message (one JSON message or one static `.html` file), and its `payload` must be
  ≤ 65536 bytes. A second `relay` attempt on the same connection is rejected; open a
  new connection (new session) to send again.
- **64MB per identity per UTC day**: every relayed payload's byte length is charged to
  *both* the sender's and the receiver's daily total (`usage_daily` table, keyed by
  identity + day) — this is what "send and receive" both count against. The charge
  happens via an atomic conditional `UPDATE ... WHERE bytes_total + ? <= cap`, so it's
  race-free even across swarms/Durable Object instances; if the recipient's quota is
  the one that's exhausted, the sender's reservation is refunded and the relay is
  refused.

## Notes

- Session tokens are HS256 JWTs (`SESSION_JWT_SECRET`) carrying a session id (`jti`); the
  id is also stored in D1 (`sessions` table) so sessions can be revoked before expiry.
- 3rd-party access tokens are opaque random strings (`sk_<serviceId>_<random>`); only their
  SHA-256 hash is persisted, so a stolen database dump doesn't leak usable tokens.
- `TrackerRoom` is a Durable Object (SQLite-backed, `new_sqlite_classes` migration in
  `wrangler.toml`) using the Hibernatable WebSockets API — idle swarms don't incur
  duration charges between messages.
