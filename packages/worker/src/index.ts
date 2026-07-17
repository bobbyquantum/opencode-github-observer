import { Hono } from "hono";
import { toActionableEvent, type GitHubWebhookEvent } from "@opencode-observer/shared";
import { verifyGitHubSignature } from "./webhook.js";
import { initiateDeviceFlow, pollForToken } from "./oauth.js";
import type { Env } from "./env.js";

export { WebSocketHub } from "./hub.js";

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ status: "ok", service: "opencode-github-observer" }));

app.post("/webhook", async (c) => {
  const signature = c.req.header("x-hub-signature-256") ?? "";
  const body = await c.req.text();

  if (c.env.GITHUB_WEBHOOK_SECRET) {
    const valid = await verifyGitHubSignature(body, signature, c.env.GITHUB_WEBHOOK_SECRET);
    if (!valid) return c.json({ error: "Invalid signature" }, 401);
  }

  const eventHeader = c.req.header("x-github-event");
  if (!eventHeader) return c.json({ error: "Missing X-GitHub-Event header" }, 400);

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name;
  if (!repo) return c.json({ ok: true });

  const webhookEvent = { type: eventHeader, payload } as GitHubWebhookEvent;
  const actionable = toActionableEvent(webhookEvent);
  if (!actionable) return c.json({ ok: true });

  const hubId = c.env.WEBSOCKET_HUB.idFromName("singleton");
  const stub = c.env.WEBSOCKET_HUB.get(hubId);
  try {
    const res = await stub.fetch("http://internal/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: actionable, repo }),
    });
    if (!res.ok) {
      return c.json({ error: "dispatch failed", detail: `DO returned ${res.status}` }, 500);
    }
  } catch (err) {
    return c.json({ error: "dispatch failed", detail: String(err) }, 500);
  }

  return c.json({ ok: true, dispatched: true });
});

app.post("/api/auth/device", async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID;
  if (!clientId) return c.json({ error: "GitHub client ID not configured" }, 500);

  try {
    const response = await initiateDeviceFlow(clientId);
    return c.json(response);
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }
});

app.post("/api/auth/token", async (c) => {
  const body = (await c.req.json()) as { device_code?: string };
  if (!body.device_code) return c.json({ error: "Missing device_code" }, 400);

  const clientId = c.env.GITHUB_CLIENT_ID;
  if (!clientId) return c.json({ error: "GitHub client ID not configured" }, 500);

  try {
    const response = await pollForToken(clientId, body.device_code);
    return c.json(response);
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }
});

app.get("/ws", (c) => {
  const hubId = c.env.WEBSOCKET_HUB.idFromName("singleton");
  const hub = c.env.WEBSOCKET_HUB.get(hubId);
  return hub.fetch(c.req.raw);
});

export default app;
