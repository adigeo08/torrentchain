import { Hono } from "hono";
import type { Env } from "../types";

export const trackerRoutes = new Hono<{ Bindings: Env }>();

// GET /tracker/:infoHash?token=<session JWT> - WebSocket upgrade.
// One Durable Object per swarm (info_hash) handles announce + relay for it.
// Auth is via the SIWE session token as a query param, since browsers can't
// set custom headers on a WebSocket handshake.
trackerRoutes.get("/:infoHash", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket", 426);
  }

  const infoHash = c.req.param("infoHash");
  const id = c.env.TRACKER_ROOM.idFromName(infoHash);
  const stub = c.env.TRACKER_ROOM.get(id);

  return stub.fetch(c.req.raw);
});
