import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";

const WEBHOOK_SECRET = "test-webhook-secret";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

type ServerMessage = { kind: string; [key: string]: unknown };

function nextMessage(
  ws: WebSocket,
  pred: (m: ServerMessage) => boolean,
  timeoutMs = 5000,
  received?: ServerMessage[],
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "timed out waiting for server message; received so far: " +
              JSON.stringify(received ?? []),
          ),
        ),
      timeoutMs,
    );
    const handler = (ev: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      received?.push(msg);
      if (pred(msg)) {
        clearTimeout(timer);
        ws.removeEventListener("message", handler);
        resolve(msg);
      }
    };
    ws.addEventListener("message", handler);
  });
}

test.describe("Worker HTTP endpoints", () => {
  test("health check returns service info", async ({ request }) => {
    const res = await request.get("/");
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.service).toBe("opencode-github-observer");
  });

  test("rejects webhook without signature", async ({ request }) => {
    const res = await request.post("/webhook", {
      data: JSON.stringify({ action: "completed" }),
      headers: { "Content-Type": "application/json", "X-GitHub-Event": "check_run" },
    });
    expect(res.status()).toBe(401);
  });

  test("rejects webhook with invalid signature", async ({ request }) => {
    const res = await request.post("/webhook", {
      data: JSON.stringify({ action: "completed" }),
      headers: {
        "Content-Type": "application/json",
        "X-GitHub-Event": "check_run",
        "X-Hub-Signature-256": "sha256=invalid",
      },
    });
    expect(res.status()).toBe(401);
  });

  test("returns 400 for auth token without device_code", async ({ request }) => {
    const res = await request.post("/api/auth/token", {
      data: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status()).toBe(400);
  });

  test("rejects non-websocket request to /ws", async ({ request }) => {
    const res = await request.get("/ws");
    expect(res.status()).toBe(426);
  });
});

test("full flow: signed webhook -> Durable Object -> WebSocket client", async ({ request }) => {
  const ws = new WebSocket("ws://127.0.0.1:8787/ws");
  const received: ServerMessage[] = [];

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("WebSocket connection failed")),
      { once: true },
    );
  });

  // DEV_MODE makes the hub accept any token as a dev user.
  ws.send(JSON.stringify({ kind: "auth", token: "dev-token" }));
  const connected = await nextMessage(ws, (m) => m.kind === "connected", 5000, received);
  expect(typeof connected.sessionId).toBe("string");
  expect(connected.sessionId).toBeTruthy();

  ws.send(JSON.stringify({ kind: "subscribe", repos: ["owner/repo"] }));
  // Allow the Durable Object to register the subscription before posting.
  await new Promise((r) => setTimeout(r, 100));

  const payload = {
    action: "completed",
    check_run: {
      id: 1,
      name: "CI",
      status: "completed",
      conclusion: "failure",
      html_url: "https://github.com/owner/repo/runs/1",
      head_sha: "abc123",
    },
    repository: {
      id: 1,
      name: "repo",
      full_name: "owner/repo",
      owner: { id: 1, login: "owner", avatar_url: "", html_url: "" },
      private: false,
      html_url: "https://github.com/owner/repo",
    },
    sender: { id: 2, login: "sender", avatar_url: "", html_url: "" },
  };
  const body = JSON.stringify(payload);

  const eventPromise = nextMessage(ws, (m) => m.kind === "event", 5000, received);

  const res = await request.post("/webhook", {
    data: body,
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "check_run",
      "X-Hub-Signature-256": sign(body),
    },
  });
  const resBody = await res.text();
  expect(res.status()).toBe(200);
  const json = JSON.parse(resBody) as { dispatched?: boolean };
  expect(json.dispatched).toBe(true);

  const event = await eventPromise;
  expect(event.repo).toBe("owner/repo");
  expect(event.event).toMatchObject({
    type: "ci_failure",
    repoFullName: "owner/repo",
    headSha: "abc123",
  });

  ws.close();
});
