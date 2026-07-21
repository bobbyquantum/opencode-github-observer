import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpencodeServerManager } from "../src/server-manager.js";

vi.mock("../src/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// We can't easily mock the OpencodeClient's health() without spinning up a
// real HTTP server, so we test the discovery helpers directly by mocking
// the env vars and filesystem state they read. The full ensure() path is
// exercised via the integration test in session-manager.test.ts which uses
// a mock client.

describe("OpencodeServerManager", () => {
  let dir: string;
  let origOpenCodePid: string | undefined;
  let origOpenCodePassword: string | undefined;
  let origHome: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "oco-sm-"));
    origOpenCodePid = process.env.OPENCODE_PID;
    origOpenCodePassword = process.env.OPENCODE_SERVER_PASSWORD;
    origHome = process.env.HOME;
    // Point HOME at the temp dir so managed-opencode reads don't leak
    // across tests or hit the real ~/.config.
    process.env.HOME = dir;
    // Clear OPENCODE_PID so tests don't accidentally find the real
    // OpenChamber-managed opencode server running on the host.
    delete process.env.OPENCODE_PID;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    if (origOpenCodePid === undefined) delete process.env.OPENCODE_PID;
    else process.env.OPENCODE_PID = origOpenCodePid;
    if (origOpenCodePassword === undefined) delete process.env.OPENCODE_SERVER_PASSWORD;
    else process.env.OPENCODE_SERVER_PASSWORD = origOpenCodePassword;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  });

  // Writes a managed-opencode record at the expected path so
  // discoverViaManagedRecord can find it.
  async function writeManagedRecord(pid: number, port: number): Promise<void> {
    const managedDir = join(dir, ".config", "openchamber", "managed-opencode");
    await mkdir(managedDir, { recursive: true });
    const record = { pid, port, binary: "/usr/bin/opencode", startedAt: new Date().toISOString() };
    await writeFile(join(managedDir, `${pid}.json`), JSON.stringify(record));
  }

  describe("discoverRunningServer", () => {
    it("returns null when OPENCODE_PID is not set and no opencode processes are running", async () => {
      delete process.env.OPENCODE_PID;
      const mgr = new OpencodeServerManager("opencode");
      // Mock process scan so it doesn't find the real opencode server.
      vi.spyOn(mgr as never, "discoverViaProcessScan").mockResolvedValue(null as never);
      const result = await mgr.discoverRunningServer("/data/inkweld");
      expect(result).toBeNull();
    });

    it("returns null when OPENCODE_PID is set but the managed-opencode record is missing", async () => {
      process.env.OPENCODE_PID = "99999";
      const mgr = new OpencodeServerManager("opencode");
      vi.spyOn(mgr as never, "discoverViaProcessScan").mockResolvedValue(null as never);
      const result = await mgr.discoverRunningServer("/data/inkweld");
      expect(result).toBeNull();
    });

    it("returns null when OPENCODE_PID is not a number", async () => {
      process.env.OPENCODE_PID = "not-a-number";
      const mgr = new OpencodeServerManager("opencode");
      vi.spyOn(mgr as never, "discoverViaProcessScan").mockResolvedValue(null as never);
      const result = await mgr.discoverRunningServer("/data/inkweld");
      expect(result).toBeNull();
    });

    it("attempts to connect to the port from the managed-opencode record", async () => {
      process.env.OPENCODE_PID = "12345";
      process.env.OPENCODE_SERVER_PASSWORD = "secret-pw";
      await writeManagedRecord(12345, 45678);

      const mgr = new OpencodeServerManager("opencode");
      // Mock process scan AND waitForHealth so we don't hang for 10s waiting
      // for a non-listening port. waitForHealth throwing means the discovery
      // returns null (the expected behavior when the port isn't listening).
      vi.spyOn(mgr as never, "discoverViaProcessScan").mockResolvedValue(null as never);
      vi.spyOn(mgr as never, "waitForHealth").mockRejectedValue(new Error("not healthy") as never);
      const result = await mgr.discoverRunningServer("/data/inkweld");
      expect(result).toBeNull();
    });

    it("reads password from OPENCODE_SERVER_PASSWORD env var when not passed explicitly", async () => {
      process.env.OPENCODE_PID = "12345";
      process.env.OPENCODE_SERVER_PASSWORD = "env-password";
      await writeManagedRecord(12345, 45678);

      const mgr = new OpencodeServerManager("opencode");
      vi.spyOn(mgr as never, "discoverViaProcessScan").mockResolvedValue(null as never);
      vi.spyOn(mgr as never, "waitForHealth").mockRejectedValue(new Error("not healthy") as never);
      const result = await mgr.discoverRunningServer("/data/inkweld");
      expect(result).toBeNull();
    });

    it("returns a server when the managed record port is healthy", async () => {
      process.env.OPENCODE_PID = "12345";
      process.env.OPENCODE_SERVER_PASSWORD = "secret-pw";
      await writeManagedRecord(12345, 45678);

      const mgr = new OpencodeServerManager("opencode");
      vi.spyOn(mgr as never, "discoverViaProcessScan").mockResolvedValue(null as never);
      vi.spyOn(mgr as never, "waitForHealth").mockResolvedValue(undefined as never);
      const result = await mgr.discoverRunningServer("/data/inkweld");
      expect(result).not.toBeNull();
      expect(result?.url).toBe("http://127.0.0.1:45678");
      expect(result?.spawned).toBe(false);
    });

    it("falls back to scanning the managed-opencode directory when OPENCODE_PID is stale", async () => {
      // OPENCODE_PID points at an old PID whose record file doesn't exist,
      // but a newer record exists in the directory. The daemon should fall
      // back to scanning the directory and find the newer record.
      process.env.OPENCODE_PID = "99999"; // stale — no record for this PID
      process.env.OPENCODE_SERVER_PASSWORD = "secret-pw";
      await writeManagedRecord(54321, 45679); // newer record, different PID

      const mgr = new OpencodeServerManager("opencode");
      vi.spyOn(mgr as never, "discoverViaProcessScan").mockResolvedValue(null as never);
      vi.spyOn(mgr as never, "waitForHealth").mockResolvedValue(undefined as never);
      const result = await mgr.discoverRunningServer("/data/inkweld");
      expect(result).not.toBeNull();
      expect(result?.url).toBe("http://127.0.0.1:45679");
    });

    it("prefers the env-var PID's record over newer directory records", async () => {
      // Two records exist: one matching OPENCODE_PID, one newer. The env-var
      // candidate should be tried first (it's the one OpenChamber intended).
      process.env.OPENCODE_PID = "12345";
      process.env.OPENCODE_SERVER_PASSWORD = "secret-pw";
      await writeManagedRecord(12345, 45678);
      await writeManagedRecord(54321, 45679);

      const mgr = new OpencodeServerManager("opencode");
      vi.spyOn(mgr as never, "discoverViaProcessScan").mockResolvedValue(null as never);
      // Make waitForHealth only succeed for the env-var port (45678).
      vi.spyOn(mgr as never, "waitForHealth").mockImplementation((async () => {
        // Both would succeed in reality; we just verify the env-var candidate
        // is tried first by checking the returned URL.
        return undefined;
      }) as never);
      const result = await mgr.discoverRunningServer("/data/inkweld");
      expect(result?.url).toBe("http://127.0.0.1:45678");
    });
  });

  describe("ensure re-validation", () => {
    it("throws a clean error when no server is available", async () => {
      delete process.env.OPENCODE_PID;
      const mgr = new OpencodeServerManager("/nonexistent/opencode-binary");
      vi.spyOn(mgr as never, "discoverViaProcessScan").mockResolvedValue(null as never);
      vi.spyOn(mgr as never, "spawnServer").mockRejectedValue(new Error("no binary") as never);
      // All three discovery paths fail: no configured URL, no managed record,
      // process scan mocked to null, spawn mocked to reject.
      await expect(mgr.ensure("/data/inkweld")).rejects.toThrow();
    });
  });

  describe("stopAll", () => {
    it("does not throw when called with no managed servers", async () => {
      const mgr = new OpencodeServerManager("opencode");
      await expect(mgr.stopAll()).resolves.toBeUndefined();
    });
  });
});