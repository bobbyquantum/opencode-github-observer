import type { ActionableEvent } from "@opencode-observer/shared";

// Pure replay-buffer logic, extracted so it can be unit-tested without
// spinning up a Durable Object. The hub delegates to these functions and
// supplies a simple key-value storage adapter.

export type BufferedEvent = { event: ActionableEvent; repo: string; expires: number };

export type ReplayStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

export const REPLAY_TTL_MS = 60 * 60 * 1000; // 1 hour
export const REPLAY_MAX_PER_REPO = 200;

// Returns the storage key for a repo's buffer.
export function replayKey(repo: string): string {
  return `replay:${repo}`;
}

// Adds an event to the repo's buffer, evicting expired entries and trimming
// to the cap. Returns the new buffer (also persists via storage).
export async function bufferEvent(
  storage: ReplayStorage,
  repo: string,
  event: ActionableEvent,
  now: number = Date.now(),
  ttlMs: number = REPLAY_TTL_MS,
  maxPerRepo: number = REPLAY_MAX_PER_REPO,
): Promise<BufferedEvent[]> {
  const key = replayKey(repo);
  const existing = (await storage.get<BufferedEvent[]>(key)) ?? [];
  const fresh = existing.filter((b) => b.expires > now);
  fresh.push({ event, repo, expires: now + ttlMs });
  while (fresh.length > maxPerRepo) fresh.shift();
  await storage.put(key, fresh);
  return fresh;
}

// Returns the buffered events for a repo that haven't expired, and clears
// the buffer (once-per-event delivery semantics).
export async function drainReplayBuffer(
  storage: ReplayStorage,
  repo: string,
  now: number = Date.now(),
): Promise<BufferedEvent[]> {
  const key = replayKey(repo);
  const buf = (await storage.get<BufferedEvent[]>(key)) ?? [];
  if (buf.length === 0) return [];
  const fresh = buf.filter((b) => b.expires > now);
  await storage.put(key, [] as BufferedEvent[]);
  return fresh;
}

// Returns buffered events without clearing (for inspection / debugging).
export async function peekReplayBuffer(
  storage: ReplayStorage,
  repo: string,
  now: number = Date.now(),
): Promise<BufferedEvent[]> {
  const key = replayKey(repo);
  const buf = (await storage.get<BufferedEvent[]>(key)) ?? [];
  return buf.filter((b) => b.expires > now);
}