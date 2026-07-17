import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadConfig, saveConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock("@opencode-observer/daemon/config", () => ({
  loadConfig,
  saveConfig,
}));

import { configCommand } from "../src/config-cmd.js";

describe("config command", () => {
  beforeEach(() => {
    loadConfig.mockReset();
    saveConfig.mockReset();
    saveConfig.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("set builds a nested patch from a dotted key", async () => {
    await configCommand(["set", "repos.owner/repo.workdir", "/code/repo"]);
    expect(saveConfig).toHaveBeenCalledWith({
      repos: { "owner/repo": { workdir: "/code/repo" } },
    });
  });

  it("set parses JSON values", async () => {
    await configCommand(["set", "keepaliveIntervalMs", "15000"]);
    expect(saveConfig).toHaveBeenCalledWith({ keepaliveIntervalMs: 15000 });
  });

  it("set falls back to string when value is not JSON", async () => {
    await configCommand(["set", "githubClientId", "abc123"]);
    expect(saveConfig).toHaveBeenCalledWith({ githubClientId: "abc123" });
  });

  it("get reads a nested key", async () => {
    loadConfig.mockResolvedValue({
      repos: { "owner/repo": { workdir: "/code/repo" } },
    });
    await configCommand(["get", "repos.owner/repo.workdir"]);
    expect(console.log).toHaveBeenCalledWith('repos.owner/repo.workdir: "/code/repo"');
  });

  it("get prints the whole config when no key", async () => {
    const cfg = { serverUrl: "wss://x/ws", repos: {} };
    loadConfig.mockResolvedValue(cfg);
    await configCommand(["get"]);
    expect(console.log).toHaveBeenCalledWith(JSON.stringify(cfg, null, 2));
  });

  it("set without a value prints usage", async () => {
    await configCommand(["set", "githubClientId"]);
    expect(saveConfig).not.toHaveBeenCalled();
  });
});
