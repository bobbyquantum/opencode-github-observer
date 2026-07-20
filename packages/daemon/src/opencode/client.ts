import { parseSSEStream } from "./sse.js";
import type {
  Event,
  FileDiff,
  Message,
  PromptBody,
  Session,
  VcsInfo,
} from "./types.js";

export type OpencodeClientOptions = {
  baseUrl: string;
  password?: string;
  username?: string;
  // Worktree directory the opencode server should scope session queries to.
  // Sent as `X-Opencode-Directory` header on every request. The opencode server
  // resolves this to a project ID and returns sessions for that project across
  // all its worktrees (e.g. /data/inkweld returns sessions in merry-gopher,
  // disco-badger, lunar-aardvark, vivid-toucan worktrees too).
  directory?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
};

export class OpencodeClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private fetchFn: typeof fetch;

  constructor(opts: OpencodeClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.headers = { Accept: "application/json", "Content-Type": "application/json" };
    if (opts.password) {
      const user = opts.username ?? "opencode";
      const token = globalThis.btoa
        ? globalThis.btoa(`${user}:${opts.password}`)
        : Buffer.from(`${user}:${opts.password}`).toString("base64");
      this.headers["Authorization"] = `Basic ${token}`;
    }
    if (opts.directory) {
      this.headers["X-Opencode-Directory"] = opts.directory;
    }
  }

  async health(signal?: AbortSignal): Promise<{ healthy: boolean; version: string }> {
    const res = await this.fetchFn(`${this.baseUrl}/global/health`, {
      headers: this.headers,
      signal: signal ?? undefined,
    });
    if (!res.ok) throw new Error(`health failed: ${res.status}`);
    return (await res.json()) as { healthy: boolean; version: string };
  }

  async listSessions(signal?: AbortSignal): Promise<Session[]> {
    const res = await this.fetchFn(`${this.baseUrl}/session`, {
      headers: this.headers,
      signal: signal ?? undefined,
    });
    if (!res.ok) throw new Error(`listSessions failed: ${res.status}`);
    return (await res.json()) as Session[];
  }

  async getSession(id: string, signal?: AbortSignal): Promise<Session> {
    const res = await this.fetchFn(`${this.baseUrl}/session/${id}`, {
      headers: this.headers,
      signal: signal ?? undefined,
    });
    if (!res.ok) throw new Error(`getSession failed: ${res.status}`);
    return (await res.json()) as Session;
  }

  async createSession(title?: string, signal?: AbortSignal): Promise<Session> {
    const res = await this.fetchFn(`${this.baseUrl}/session`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(title ? { title } : {}),
      signal: signal ?? undefined,
    });
    if (!res.ok) throw new Error(`createSession failed: ${res.status}`);
    return (await res.json()) as Session;
  }

  async promptAsync(id: string, body: PromptBody, signal?: AbortSignal): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/session/${id}/prompt_async`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
      signal: signal ?? undefined,
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`promptAsync failed: ${res.status}`);
    }
  }

  async sessionDiff(id: string, signal?: AbortSignal): Promise<Array<FileDiff>> {
    const res = await this.fetchFn(`${this.baseUrl}/session/${id}/diff`, {
      headers: this.headers,
      signal: signal ?? undefined,
    });
    if (!res.ok) throw new Error(`sessionDiff failed: ${res.status}`);
    return (await res.json()) as Array<FileDiff>;
  }

  async sessionStatus(signal?: AbortSignal): Promise<Record<string, { type: string }>> {
    const res = await this.fetchFn(`${this.baseUrl}/session/status`, {
      headers: this.headers,
      signal: signal ?? undefined,
    });
    if (!res.ok) throw new Error(`sessionStatus failed: ${res.status}`);
    return (await res.json()) as Record<string, { type: string }>;
  }

  async abortSession(id: string, signal?: AbortSignal): Promise<void> {
    const res = await this.fetchFn(`${this.baseUrl}/session/${id}/abort`, {
      method: "POST",
      headers: this.headers,
      signal: signal ?? undefined,
    });
    if (!res.ok) throw new Error(`abortSession failed: ${res.status}`);
  }

  async vcsInfo(signal?: AbortSignal): Promise<VcsInfo> {
    const res = await this.fetchFn(`${this.baseUrl}/vcs`, {
      headers: this.headers,
      signal: signal ?? undefined,
    });
    if (!res.ok) throw new Error(`vcsInfo failed: ${res.status}`);
    return (await res.json()) as VcsInfo;
  }

  // Queries VCS info for a specific worktree directory, overriding the
  // client's default directory header for this one call. Used by the session
  // manager to find which session's worktree is on the event's branch.
  async vcsInfoForDirectory(directory: string, signal?: AbortSignal): Promise<VcsInfo> {
    const headers = { ...this.headers, "X-Opencode-Directory": directory };
    const res = await this.fetchFn(`${this.baseUrl}/vcs`, {
      headers,
      signal: signal ?? undefined,
    });
    if (!res.ok) throw new Error(`vcsInfoForDirectory failed: ${res.status}`);
    return (await res.json()) as VcsInfo;
  }

  async messages(id: string, signal?: AbortSignal): Promise<Array<Message>> {
    const res = await this.fetchFn(`${this.baseUrl}/session/${id}/message`, {
      headers: this.headers,
      signal: signal ?? undefined,
    });
    if (!res.ok) throw new Error(`messages failed: ${res.status}`);
    return (await res.json()) as Array<Message>;
  }

  async *subscribeEvents(signal?: AbortSignal): AsyncGenerator<Event, void, unknown> {
    const res = await this.fetchFn(`${this.baseUrl}/event`, {
      headers: { ...this.headers, Accept: "text/event-stream" },
      signal: signal ?? undefined,
    });
    if (!res.ok || !res.body) throw new Error(`subscribeEvents failed: ${res.status}`);
    for await (const sse of parseSSEStream(res.body, signal)) {
      if (!sse.data) continue;
      try {
        yield JSON.parse(sse.data) as Event;
      } catch {
        // Skip malformed event payloads.
      }
    }
  }
}
