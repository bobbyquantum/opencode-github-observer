import { describe, expect, it } from "vitest";
import { OpencodeClient } from "../../src/opencode/client.js";

function mockFetch(routes: Array<(url: string, init?: RequestInit) => Response | Promise<Response>>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const route of routes) {
      const res = await route(url, init);
      if (res) return res;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sseStream(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

describe("OpencodeClient", () => {
  it("lists sessions", async () => {
    const fetchFn = mockFetch([
      (url) => (url.endsWith("/session") ? json([{ id: "s1", projectID: "p", directory: "/r", title: "t", version: "1", time: { created: 1, updated: 1 } }]) : new Response("", { status: 404 })),
    ]);
    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetch: fetchFn });
    const sessions = await client.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("s1");
  });

  it("creates a session with a title", async () => {
    const fetchFn = mockFetch([
      (url, init) => {
        if (url.endsWith("/session") && init?.method === "POST") {
          const body = JSON.parse(String(init.body)) as { title?: string };
          return json({ id: "new", projectID: "p", directory: "/r", title: body.title ?? "", version: "1", time: { created: 1, updated: 1 } });
        }
        return new Response("", { status: 404 });
      },
    ]);
    const client = new OpencodeClient({ baseUrl: "http://x", fetch: fetchFn });
    const session = await client.createSession("fix CI");
    expect(session.id).toBe("new");
    expect(session.title).toBe("fix CI");
  });

  it("sends an async prompt", async () => {
    const fetchFn = mockFetch([
      (url, init) => {
        if (url.endsWith("/session/s1/prompt_async") && init?.method === "POST") {
          return new Response(null, { status: 204 });
        }
        return new Response("", { status: 404 });
      },
    ]);
    const client = new OpencodeClient({ baseUrl: "http://x", fetch: fetchFn });
    await expect(client.promptAsync("s1", { parts: [{ type: "text", text: "hi" }] })).resolves.toBeUndefined();
  });

  it("throws on non-204 prompt response", async () => {
    const fetchFn = mockFetch([
      (_url, init) => (init?.method === "POST" ? new Response("err", { status: 500 }) : new Response("", { status: 404 })),
    ]);
    const client = new OpencodeClient({ baseUrl: "http://x", fetch: fetchFn });
    await expect(client.promptAsync("s1", { parts: [{ type: "text", text: "hi" }] })).rejects.toThrow("promptAsync failed: 500");
  });

  it("parses SSE events from the event stream", async () => {
    const events = [
      `data: ${JSON.stringify({ type: "vcs.branch.updated", properties: { branch: "feature" } })}\n\n`,
      `data: ${JSON.stringify({ type: "session.created", properties: { info: { id: "s1" } } })}\n\n`,
    ];
    const fetchFn = mockFetch([
      (url) => (url.endsWith("/event") ? sseStream(events) : new Response("", { status: 404 })),
    ]);
    const client = new OpencodeClient({ baseUrl: "http://x", fetch: fetchFn });
    const received: string[] = [];
    for await (const evt of client.subscribeEvents()) received.push(evt.type);
    expect(received).toEqual(["vcs.branch.updated", "session.created"]);
  });

  it("sends basic auth header when password is set", async () => {
    let authHeader = "";
    const fetchFn: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      authHeader = headers.get("Authorization") ?? "";
      return json({ healthy: true, version: "1" });
    }) as typeof fetch;
    const client = new OpencodeClient({ baseUrl: "http://x", password: "secret", fetch: fetchFn });
    await client.health();
    expect(authHeader).toMatch(/^Basic /);
  });
});
