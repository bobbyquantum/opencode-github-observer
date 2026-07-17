import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config", () => {
  let tempDir: string;
  let origHome: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "oco-test-"));
    origHome = process.env.HOME;
    process.env.HOME = tempDir;
    vi.resetModules();
  });

  afterEach(async () => {
    if (origHome !== undefined) {
      process.env.HOME = origHome;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns default config when no file exists", async () => {
    const { loadConfig } = await import("../src/config.js");
    const config = await loadConfig();
    expect(config.serverUrl).toBe("wss://github.quantum.observer/ws");
    expect(config.logLevel).toBe("info");
  });

  it("saves and loads config", async () => {
    const { saveConfig, loadConfig } = await import("../src/config.js");
    await saveConfig({ logLevel: "debug", githubClientId: "test-client" });
    const config = await loadConfig();
    expect(config.logLevel).toBe("debug");
    expect(config.githubClientId).toBe("test-client");
    expect(config.serverUrl).toBe("wss://github.quantum.observer/ws");
  });

  it("saves and loads token", async () => {
    const { saveToken, loadToken, clearToken } = await import("../src/config.js");
    await saveToken("gho_test123");
    expect(await loadToken()).toBe("gho_test123");
    await clearToken();
    expect(await loadToken()).toBeNull();
  });

  it("deep-merges repos so adding one does not wipe others", async () => {
    const { saveConfig, loadConfig } = await import("../src/config.js");
    await saveConfig({ repos: { "owner/repo": { workdir: "/r1" } } });
    await saveConfig({ repos: { "other/repo": { workdir: "/r2" } } });
    const config = await loadConfig();
    expect(config.repos["owner/repo"]?.workdir).toBe("/r1");
    expect(config.repos["other/repo"]?.workdir).toBe("/r2");
  });

  it("preserves an existing repo's serverUrl when updating its workdir", async () => {
    const { saveConfig, loadConfig } = await import("../src/config.js");
    await saveConfig({ repos: { "owner/repo": { workdir: "/r", serverUrl: "http://x" } } });
    await saveConfig({ repos: { "owner/repo": { workdir: "/r2" } } });
    const config = await loadConfig();
    expect(config.repos["owner/repo"]?.workdir).toBe("/r2");
    expect(config.repos["owner/repo"]?.serverUrl).toBe("http://x");
  });

  it("rejects a repo with an empty workdir", async () => {
    const { saveConfig } = await import("../src/config.js");
    await expect(saveConfig({ repos: { "owner/repo": { workdir: "" } } })).rejects.toThrow("workdir");
  });
});
