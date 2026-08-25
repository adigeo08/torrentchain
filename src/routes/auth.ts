import { Hono } from "hono";
import { generateNonce, SiweMessage } from "siwe";
import type { Env } from "../types";
import { saveNonce, consumeNonce, upsertUser, createSession, revokeSession, numericEnv } from "../lib/db";
import { generateId } from "../lib/crypto";
import { signSessionToken } from "../lib/jwt";
import { sessionAuth, type SessionVariables } from "../middleware/sessionAuth";

export const authRoutes = new Hono<{ Bindings: Env; Variables: SessionVariables }>();

// GET /auth/nonce - issue a single-use nonce for the client to embed in its SIWE message.
authRoutes.get("/nonce", async (c) => {
  const nonce = generateNonce();
  await saveNonce(c.env.DB, nonce, numericEnv(c.env, "NONCE_TTL_SECONDS", 300));
  return c.text(nonce);
});

// POST /auth/verify - body: { message, signature } - verifies the SIWE message,
// consumes the nonce, upserts the user, and returns a bearer session token.
authRoutes.post("/verify", async (c) => {
  const body = await c.req.json<{ message?: string; signature?: string }>().catch(() => null);
  if (!body?.message || !body?.signature) {
    return c.json({ error: "Expected { message, signature }" }, 400);
  }

  let siweMessage: SiweMessage;
  try {
    siweMessage = new SiweMessage(body.message);
  } catch {
    return c.json({ error: "Malformed SIWE message" }, 400);
  }

  if (siweMessage.domain !== c.env.SIWE_DOMAIN) {
    return c.json({ error: "Domain mismatch" }, 401);
  }

  try {
    const result = await siweMessage.verify({
      signature: body.signature,
      domain: c.env.SIWE_DOMAIN,
    });
    if (!result.success) {
      return c.json({ error: "Signature verification failed" }, 401);
    }
  } catch {
    return c.json({ error: "Signature verification failed" }, 401);
  }

  const nonceOk = await consumeNonce(c.env.DB, siweMessage.nonce);
  if (!nonceOk) {
    return c.json({ error: "Nonce missing, expired, or already used" }, 401);
  }

  const address = siweMessage.address.toLowerCase();
  await upsertUser(c.env.DB, address, siweMessage.chainId);

  const sessionId = generateId();
  const ttl = numericEnv(c.env, "SESSION_TTL_SECONDS", 3600);
  const { expiresAt } = await createSession(c.env.DB, sessionId, address, siweMessage.chainId, ttl);

  const token = await signSessionToken(
    { jti: sessionId, sub: address, chainId: siweMessage.chainId },
    c.env.SESSION_JWT_SECRET,
    expiresAt,
  );

  return c.json({ token, address, chainId: siweMessage.chainId, expiresAt });
});

// GET /auth/session - returns the caller's current session, if valid.
authRoutes.get("/session", sessionAuth, async (c) => {
  const session = c.get("session");
  return c.json({ address: session.address, chainId: session.chainId });
});

// POST /auth/logout - revokes the current session.
authRoutes.post("/logout", sessionAuth, async (c) => {
  const session = c.get("session");
  await revokeSession(c.env.DB, session.jti);
  return c.json({ ok: true });
});
