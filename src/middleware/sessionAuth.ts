import type { Context, Next } from "hono";
import type { Env } from "../types";
import { verifySessionToken } from "../lib/jwt";
import { isSessionActive } from "../lib/db";

export interface SessionVariables {
  session: { address: string; chainId: number; jti: string };
}

export async function sessionAuth(
  c: Context<{ Bindings: Env; Variables: SessionVariables }>,
  next: Next,
) {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) {
    return c.json({ error: "Missing bearer session token" }, 401);
  }

  try {
    const claims = await verifySessionToken(token, c.env.SESSION_JWT_SECRET);
    const active = await isSessionActive(c.env.DB, claims.jti);
    if (!active) {
      return c.json({ error: "Session expired or revoked" }, 401);
    }
    c.set("session", { address: claims.sub, chainId: claims.chainId, jti: claims.jti });
  } catch {
    return c.json({ error: "Invalid session token" }, 401);
  }

  await next();
}
