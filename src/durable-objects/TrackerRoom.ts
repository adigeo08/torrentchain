import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { verifySessionToken } from "../lib/jwt";
import { isSessionActive, tryConsumeDailyQuota, refundDailyQuota } from "../lib/db";
import { computeIdentity } from "../lib/identity";

const MAX_MESSAGE_BYTES = 64 * 1024; // 64 KB per relayed JSON message / static .html
const MAX_DAILY_BYTES = 64 * 1024 * 1024; // 64 MB sent+received per identity per UTC day

interface PeerAttachment {
  peerId: string;
  identity: string;
  infoHash: string;
  relayUsed: boolean;
}

/**
 * One TrackerRoom instance per swarm (info_hash). Doubles as:
 *  1. A minimal WebTorrent-tracker-style announce endpoint (peer discovery).
 *  2. The actual data relay between two peers — there is no WebRTC/ICE
 *     offer-answer exchange; a "relay" message's payload is forwarded
 *     directly, byte for byte, to the target peer's WebSocket.
 *
 * Each connection ("session") may relay at most one payload (one JSON
 * message or one static .html file, capped at MAX_MESSAGE_BYTES). Bytes are
 * charged against both the sender's and the receiver's daily quota
 * (identity = sha256(wallet address + User-Agent)).
 */
export class TrackerRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const url = new URL(request.url);
    const infoHash = url.pathname.split("/").filter(Boolean).pop();
    const token = url.searchParams.get("token");
    if (!infoHash || !token) {
      return new Response("Missing info_hash or token", { status: 400 });
    }

    let claims;
    try {
      claims = await verifySessionToken(token, this.env.SESSION_JWT_SECRET);
    } catch {
      return new Response("Invalid session token", { status: 401 });
    }
    if (!(await isSessionActive(this.env.DB, claims.jti))) {
      return new Response("Session expired or revoked", { status: 401 });
    }

    const userAgent = request.headers.get("User-Agent") ?? "unknown";
    const identity = await computeIdentity(claims.sub, userAgent);
    const peerId = crypto.randomUUID();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    const attachment: PeerAttachment = { peerId, identity, infoHash, relayUsed: false };
    server.serializeAttachment(attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as PeerAttachment | null;
    if (!attachment) {
      ws.close(1011, "No session attached");
      return;
    }

    if (typeof message !== "string") {
      this.sendError(ws, "Only JSON text frames are supported");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      this.sendError(ws, "Malformed JSON");
      return;
    }

    const msg = parsed as Record<string, unknown>;
    if (msg.action === "announce") {
      this.handleAnnounce(ws, attachment);
      return;
    }
    if (msg.action === "relay") {
      await this.handleRelay(ws, attachment, msg);
      return;
    }
    this.sendError(ws, "Unknown action");
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as PeerAttachment | null;
    if (!attachment) return;
    this.broadcast(attachment.infoHash, attachment.peerId, {
      action: "peer_left",
      peer_id: attachment.peerId,
    });
  }

  private handleAnnounce(ws: WebSocket, attachment: PeerAttachment): void {
    const peers = this.peersIn(attachment.infoHash, attachment.peerId).map((p) => p.peerId);

    ws.send(
      JSON.stringify({
        action: "announce",
        info_hash: attachment.infoHash,
        interval: 30,
        complete: peers.length,
        incomplete: 0,
        peers,
      }),
    );

    this.broadcast(attachment.infoHash, attachment.peerId, {
      action: "peer_joined",
      peer_id: attachment.peerId,
    });
  }

  private async handleRelay(
    ws: WebSocket,
    attachment: PeerAttachment,
    msg: Record<string, unknown>,
  ): Promise<void> {
    if (attachment.relayUsed) {
      this.sendError(ws, "This session already relayed its one payload");
      return;
    }

    const toPeerId = msg.to_peer_id;
    const payloadType = msg.payload_type;
    const payload = msg.payload;
    if (
      typeof toPeerId !== "string" ||
      typeof payload !== "string" ||
      (payloadType !== "json" && payloadType !== "html")
    ) {
      this.sendError(ws, "Expected { to_peer_id, payload_type: 'json'|'html', payload }");
      return;
    }

    const byteLength = new TextEncoder().encode(payload).length;
    if (byteLength > MAX_MESSAGE_BYTES) {
      this.sendError(ws, `Payload exceeds ${MAX_MESSAGE_BYTES} bytes`);
      return;
    }

    const target = this.ctx
      .getWebSockets()
      .find((peer) => {
        const a = peer.deserializeAttachment() as PeerAttachment | null;
        return a?.infoHash === attachment.infoHash && a.peerId === toPeerId;
      });
    if (!target) {
      this.sendError(ws, "Target peer is not connected to this swarm");
      return;
    }
    const targetAttachment = target.deserializeAttachment() as PeerAttachment;

    const db = this.env.DB;
    const senderOk = await tryConsumeDailyQuota(db, attachment.identity, byteLength, MAX_DAILY_BYTES);
    if (!senderOk) {
      this.sendError(ws, "Your daily 64MB quota is exhausted");
      return;
    }
    const receiverOk = await tryConsumeDailyQuota(db, targetAttachment.identity, byteLength, MAX_DAILY_BYTES);
    if (!receiverOk) {
      await refundDailyQuota(db, attachment.identity, byteLength);
      this.sendError(ws, "Recipient's daily 64MB quota is exhausted");
      return;
    }

    target.send(
      JSON.stringify({
        action: "relay",
        from_peer_id: attachment.peerId,
        payload_type: payloadType,
        payload,
      }),
    );

    attachment.relayUsed = true;
    ws.serializeAttachment(attachment);

    ws.send(JSON.stringify({ action: "relay_ack", bytes: byteLength }));
  }

  private peersIn(infoHash: string, excludePeerId?: string): PeerAttachment[] {
    return this.ctx
      .getWebSockets()
      .map((peer) => peer.deserializeAttachment() as PeerAttachment | null)
      .filter((a): a is PeerAttachment => !!a && a.infoHash === infoHash && a.peerId !== excludePeerId);
  }

  private broadcast(infoHash: string, excludePeerId: string, payload: unknown): void {
    const message = JSON.stringify(payload);
    for (const peer of this.ctx.getWebSockets()) {
      const a = peer.deserializeAttachment() as PeerAttachment | null;
      if (a && a.infoHash === infoHash && a.peerId !== excludePeerId) {
        peer.send(message);
      }
    }
  }

  private sendError(ws: WebSocket, message: string): void {
    ws.send(JSON.stringify({ action: "error", message }));
  }
}
