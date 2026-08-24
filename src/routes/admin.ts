import { Hono } from "hono";
import type { Env } from "../types";
import {
  createService,
  listServices,
  getService,
  createAccessToken,
  listAccessTokens,
  revokeAccessToken,
} from "../lib/db";
import { generateId, generateOpaqueToken, sha256Hex } from "../lib/crypto";
import { adminAuth } from "../middleware/adminAuth";

export const adminRoutes = new Hono<{ Bindings: Env }>();

adminRoutes.use("*", adminAuth);

// POST /admin/services - register a 3rd-party service that can receive access tokens.
adminRoutes.post("/services", async (c) => {
  const body = await c.req.json<{ name?: string; description?: string }>().catch(() => null);
  if (!body?.name) {
    return c.json({ error: "Expected { name, description? }" }, 400);
  }

  const id = generateId();
  await createService(c.env.DB, id, body.name, body.description ?? null);
  return c.json({ id, name: body.name, description: body.description ?? null }, 201);
});

// GET /admin/services - list registered services.
adminRoutes.get("/services", async (c) => {
  const services = await listServices(c.env.DB);
  return c.json({ services });
});

// POST /admin/tokens - issue a new access token for a service. The raw token
// is returned once; only its hash is persisted.
adminRoutes.post("/tokens", async (c) => {
  const body = await c.req
    .json<{
      serviceId?: string;
      subject?: string;
      scopes?: string[];
      expiresInSeconds?: number;
      issuedBy?: string;
    }>()
    .catch(() => null);

  if (!body?.serviceId) {
    return c.json({ error: "Expected { serviceId, subject?, scopes?, expiresInSeconds?, issuedBy? }" }, 400);
  }

  const service = await getService(c.env.DB, body.serviceId);
  if (!service) {
    return c.json({ error: "Unknown serviceId" }, 404);
  }

  const id = generateId();
  const rawToken = generateOpaqueToken(`sk_${service.id}`);
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = body.expiresInSeconds
    ? Math.floor(Date.now() / 1000) + body.expiresInSeconds
    : null;

  await createAccessToken(c.env.DB, {
    id,
    serviceId: service.id,
    subject: body.subject ?? null,
    tokenHash,
    scopes: body.scopes ?? null,
    issuedBy: body.issuedBy ?? null,
    expiresAt,
  });

  return c.json(
    {
      id,
      token: rawToken,
      serviceId: service.id,
      subject: body.subject ?? null,
      scopes: body.scopes ?? null,
      expiresAt,
    },
    201,
  );
});

// GET /admin/tokens?serviceId=... - list issued tokens (never returns raw values).
adminRoutes.get("/tokens", async (c) => {
  const serviceId = c.req.query("serviceId");
  const tokens = await listAccessTokens(c.env.DB, serviceId);
  return c.json({ tokens });
});

// POST /admin/tokens/:id/revoke
adminRoutes.post("/tokens/:id/revoke", async (c) => {
  const id = c.req.param("id");
  const revoked = await revokeAccessToken(c.env.DB, id);
  if (!revoked) {
    return c.json({ error: "Token not found or already revoked" }, 404);
  }
  return c.json({ ok: true });
});
