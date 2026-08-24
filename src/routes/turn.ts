import { Hono } from "hono";
import type { Env } from "../types";
import { sessionAuth, type SessionVariables } from "../middleware/sessionAuth";
import { createAccessToken, ttlFromEnv } from "../lib/db";
import { generateId, sha256Hex } from "../lib/crypto";
import { CLOUDFLARE_TURN_SERVICE_ID } from "../lib/constants";

export const turnRoutes = new Hono<{ Bindings: Env; Variables: SessionVariables }>();

interface CloudflareTurnResponse {
  iceServers: {
    urls: string[];
    username: string;
    credential: string;
  };
}

// POST /turn/credentials - issues short-lived Cloudflare Realtime TURN
// credentials for the caller's SIWE session. Requires ADMIN_API_KEY-managed
// secrets TURN_KEY_ID / TURN_KEY_API_TOKEN to be configured for the Worker.
turnRoutes.post("/credentials", sessionAuth, async (c) => {
  if (!c.env.TURN_KEY_ID || !c.env.TURN_KEY_API_TOKEN) {
    return c.json({ error: "TURN service is not configured" }, 503);
  }

  const session = c.get("session");
  const body = await c.req.json<{ ttl?: number }>().catch(() => ({}) as { ttl?: number });

  const defaultTtl = ttlFromEnv(c.env, "TURN_CREDENTIAL_TTL_SECONDS", 3600);
  const maxTtl = ttlFromEnv(c.env, "TURN_CREDENTIAL_MAX_TTL_SECONDS", 86400);
  const ttl = Math.min(body.ttl && body.ttl > 0 ? body.ttl : defaultTtl, maxTtl);

  const upstream = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${c.env.TURN_KEY_ID}/credentials/generate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.env.TURN_KEY_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl, customIdentifier: session.address }),
    },
  );

  if (!upstream.ok) {
    console.error("Cloudflare TURN credential generation failed", await upstream.text());
    return c.json({ error: "Failed to generate TURN credentials" }, 502);
  }

  const data = await upstream.json<CloudflareTurnResponse>();
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;

  // Audit trail only: the credential itself is managed/expired by Cloudflare,
  // we just hash it for traceability (never store it in the clear).
  await createAccessToken(c.env.DB, {
    id: generateId(),
    serviceId: CLOUDFLARE_TURN_SERVICE_ID,
    subject: session.address,
    tokenHash: await sha256Hex(data.iceServers.credential),
    scopes: null,
    issuedBy: `session:${session.jti}`,
    expiresAt,
  });

  return c.json({ iceServers: data.iceServers, ttl, expiresAt });
});
