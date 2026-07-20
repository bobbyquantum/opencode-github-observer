import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@opencode-observer/shared";
import { logger } from "./logger.js";

export type WebSocketClientEvents = {
  connected: [sessionId: string];
  event: [msg: Extract<ServerMessage, { kind: "event" }>];
  error: [message: string];
  disconnected: [];
  reconnecting: [attempt: number];
};

export class WebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  private authed = false;
  private lastConnectedAt: number | null = null;
  private lastDisconnectedAt: number | null = null;

  constructor(
    private url: string,
    private token: string,
    private reconnectIntervalMs = 1000,
    private maxReconnectIntervalMs = 30000,
    private keepaliveIntervalMs = 30000,
  ) {
    super();
  }

  connect(): void {
    this.intentionalClose = false;
    this.doConnect();
  }

  disconnect(): void {
    this.intentionalClose = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }
    this.authed = false;
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  subscribe(repos: string[]): void {
    this.send({ kind: "subscribe", repos });
  }

  unsubscribe(repos: string[]): void {
    this.send({ kind: "unsubscribe", repos });
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.authed;
  }

  private doConnect(): void {
    logger.info(`Connecting to ${this.url}`);

    try {
      this.ws = new WebSocket(this.url);
    } catch (err) {
      logger.error("WebSocket creation failed", err);
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      logger.info("WebSocket connected, authenticating");
      this.reconnectAttempt = 0;
      this.send({ kind: "auth", token: this.token });
    });

    this.ws.on("message", (data: WebSocket.RawData) => {
      const raw = data.toString();
      const msg = parseServerMessage(raw);
      if (!msg) {
        logger.warn("Invalid message from server", raw);
        return;
      }
      this.handleMessage(msg);
    });

    this.ws.on("close", (code: number, reason: Buffer) => {
      const now = Date.now();
      const blindWindowMs = this.lastConnectedAt ? now - this.lastConnectedAt : null;
      // Log the duration since last successful connect — this is the upper
      // bound on any blind window during which broadcast events may have been
      // buffered by the relay DO for replay on reconnect.
      const blindNote = blindWindowMs !== null ? ` (blind window: ${(blindWindowMs / 1000).toFixed(1)}s)` : "";
      logger.info(`WebSocket closed: ${code} ${reason.toString()}${blindNote}`);
      this.lastDisconnectedAt = now;
      this.authed = false;
      this.clearTimers();
      this.emit("disconnected");
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    });

    this.ws.on("error", (err: Error) => {
      logger.error("WebSocket error", err.message);
    });
  }

  private handleMessage(msg: ServerMessage): void {
    switch (msg.kind) {
      case "connected":
        this.authed = true;
        this.lastConnectedAt = Date.now();
        // Log the duration since last disconnect so we know how long the
        // client was offline (and thus how much may have been buffered).
        if (this.lastDisconnectedAt) {
          const offlineMs = Date.now() - this.lastDisconnectedAt;
          logger.info(`Authenticated, session: ${msg.sessionId} (offline: ${(offlineMs / 1000).toFixed(1)}s)`);
        } else {
          logger.info(`Authenticated, session: ${msg.sessionId}`);
        }
        this.emit("connected", msg.sessionId);
        this.startKeepalive();
        break;
      case "event":
        this.emit("event", msg);
        break;
      case "error":
        logger.error(`Server error: ${msg.message}`);
        this.emit("error", msg.message);
        break;
      case "pong":
        break;
    }
  }

  private startKeepalive(): void {
    this.clearKeepalive();
    this.keepaliveTimer = setInterval(() => {
      this.send({ kind: "ping" });
    }, this.keepaliveIntervalMs);
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose) return;

    const delay = Math.min(
      this.reconnectIntervalMs * Math.pow(2, this.reconnectAttempt),
      this.maxReconnectIntervalMs,
    );
    this.reconnectAttempt++;

    logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);
    this.emit("reconnecting", this.reconnectAttempt);

    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
    }, delay);
  }

  private clearTimers(): void {
    this.clearKeepalive();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }
}
