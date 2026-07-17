/// <reference path="../../../node_modules/@cloudflare/workers-types/index.d.ts" />
import {
  createServerMessage,
  parseClientMessage,
  type ActionableEvent,
} from "@opencode-observer/shared";
import { validateGitHubToken } from "./oauth.js";
import type { Env } from "./env.js";

type AuthInfo = { userId: number; login: string; repos: string[] };

const PING_MSG = JSON.stringify({ kind: "ping" });
const PONG_MSG = JSON.stringify({ kind: "pong" });

export class WebSocketHub implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    // Pings are answered by the platform without waking the DO — zero rows
    // read, zero CPU, for every keepalive.
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_MSG, PONG_MSG));
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader !== "websocket") {
      if (request.method === "POST" && new URL(request.url).pathname === "/broadcast") {
        const body = (await request.json()) as { event: ActionableEvent; repo: string };
        await this.broadcastEvent(body.event, body.repo);
        return new Response(null, { status: 204 });
      }
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    const sessionId = crypto.randomUUID();
    this.state.acceptWebSocket(server, [sessionId]);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.state.getTags(ws);
    const sessionId = tags[0];
    if (!sessionId) return;

    const raw = typeof message === "string" ? message : "";
    const msg = parseClientMessage(raw);
    if (!msg) {
      ws.send(createServerMessage({ kind: "error", message: "Invalid message format" }));
      return;
    }

    if (msg.kind === "auth") {
      const user =
        this.env.DEV_MODE === "true"
          ? { id: 1, login: "dev-user" }
          : await validateGitHubToken(msg.token);
      if (!user) {
        ws.send(createServerMessage({ kind: "error", message: "Invalid token" }));
        ws.close(1008, "Invalid token");
        return;
      }
      await this.state.storage.put(`auth:${sessionId}`, {
        userId: user.id,
        login: user.login,
        repos: [],
      } satisfies AuthInfo);
      ws.send(createServerMessage({ kind: "connected", sessionId }));
      return;
    }

    // All messages below require authentication.
    const auth = await this.state.storage.get<AuthInfo>(`auth:${sessionId}`);
    if (!auth) {
      ws.send(createServerMessage({ kind: "error", message: "Not authenticated" }));
      return;
    }

    if (msg.kind === "subscribe") {
      for (const repo of msg.repos) {
        if (!auth.repos.includes(repo)) auth.repos.push(repo);
        const key = `repo:${repo}`;
        const ids = (await this.state.storage.get<string[]>(key)) ?? [];
        if (!ids.includes(sessionId)) ids.push(sessionId);
        await this.state.storage.put(key, ids);
      }
      await this.state.storage.put(`auth:${sessionId}`, auth);
      return;
    }

    if (msg.kind === "unsubscribe") {
      for (const repo of msg.repos) {
        auth.repos = auth.repos.filter((r) => r !== repo);
        const key = `repo:${repo}`;
        const ids = (await this.state.storage.get<string[]>(key)) ?? [];
        await this.state.storage.put(key, ids.filter((id) => id !== sessionId));
      }
      await this.state.storage.put(`auth:${sessionId}`, auth);
      return;
    }

    // ping is handled by auto-response; if we get here it's an unknown kind.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    await this.cleanup(ws);
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.cleanup(ws);
  }

  private async cleanup(ws: WebSocket): Promise<void> {
    const tags = this.state.getTags(ws);
    const sessionId = tags[0];
    if (!sessionId) return;

    const auth = await this.state.storage.get<AuthInfo>(`auth:${sessionId}`);
    if (auth) {
      for (const repo of auth.repos) {
        const key = `repo:${repo}`;
        const ids = (await this.state.storage.get<string[]>(key)) ?? [];
        await this.state.storage.put(key, ids.filter((id) => id !== sessionId));
      }
    }
    await this.state.storage.delete(`auth:${sessionId}`);
    try { ws.close(); } catch {}
  }

  async broadcastEvent(event: ActionableEvent, repo: string): Promise<void> {
    const ids = await this.state.storage.get<string[]>(`repo:${repo}`);
    if (!ids || ids.length === 0) return;

    const msg = createServerMessage({ kind: "event", event, repo });
    for (const sessionId of ids) {
      const sockets = this.state.getWebSockets(sessionId);
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(msg); } catch {}
        }
      }
    }
  }
}