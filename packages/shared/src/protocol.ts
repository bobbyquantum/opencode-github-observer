import type { ActionableEvent } from "./events.js";

export type ClientMessage =
  | { kind: "auth"; token: string }
  | { kind: "subscribe"; repos: string[] }
  | { kind: "unsubscribe"; repos: string[] }
  | { kind: "ping" };

export type ServerMessage =
  | { kind: "connected"; sessionId: string }
  | { kind: "event"; event: ActionableEvent; repo: string }
  | { kind: "error"; message: string }
  | { kind: "pong" };

export function isClientMessage(value: unknown): value is ClientMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  switch (msg.kind) {
    case "auth":
      return typeof msg.token === "string";
    case "subscribe":
    case "unsubscribe":
      return Array.isArray(msg.repos) && (msg.repos as unknown[]).every((r) => typeof r === "string");
    case "ping":
      return true;
    default:
      return false;
  }
}

export function isServerMessage(value: unknown): value is ServerMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  switch (msg.kind) {
    case "connected":
      return typeof msg.sessionId === "string";
    case "event":
      return typeof msg.repo === "string" && typeof msg.event === "object" && msg.event !== null;
    case "error":
      return typeof msg.message === "string";
    case "pong":
      return true;
    default:
      return false;
  }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isClientMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isServerMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}

export function createClientMessage(msg: ClientMessage): string {
  return JSON.stringify(msg);
}
