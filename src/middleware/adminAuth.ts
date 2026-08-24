import type { Context, Next } from "hono";
import type { Env } from "../types";

/**
 * Guards /admin routes with the ADMIN_API_KEY secret (set via
 * `wrangler secret put ADMIN_API_KEY`). Foundation-level auth only;
 * swap for per-admin SIWE-authenticated addresses (see admins table)
 * once multiple admins are needed.
 */
export async function adminAuth(c: Context<{ Bindings: Env }>, next: Next) {
  const header = c.req.header("Authorization");
  const key = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;

  if (!key || !c.env.ADMIN_API_KEY || !timingSafeEqual(key, c.env.ADMIN_API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
}

function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}
