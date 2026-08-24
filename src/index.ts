import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { authRoutes } from "./routes/auth";
import { adminRoutes } from "./routes/admin";
import { tokenRoutes } from "./routes/tokens";
import { turnRoutes } from "./routes/turn";

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/", (c) => c.json({ service: "torrentchain-siwe-api", status: "ok" }));

app.route("/auth", authRoutes);
app.route("/admin", adminRoutes);
app.route("/tokens", tokenRoutes);
app.route("/turn", turnRoutes);

app.notFound((c) => c.json({ error: "Not found" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
