import { Hono } from "hono";
import type { Env } from "../types";
import { findActiveAccessTokenByHash } from "../lib/db";
import { sha256Hex } from "../lib/crypto";

export const tokenRoutes = new Hono<{ Bindings: Env }>();

// POST /tokens/introspect - body: { token } - lets a 3rd-party service check
// whether a token issued to it by the admin is currently valid.
tokenRoutes.post("/introspect", async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => null);
  if (!body?.token) {
    return c.json({ error: "Expected { token }" }, 400);
  }

  const tokenHash = await sha256Hex(body.token);
  const record = await findActiveAccessTokenByHash(c.env.DB, tokenHash);
  if (!record) {
    return c.json({ active: false });
  }

  return c.json({
    active: true,
    serviceId: record.service_id,
    subject: record.subject,
    scopes: record.scopes ? JSON.parse(record.scopes) : null,
    expiresAt: record.expires_at,
  });
});
