import { WebSocketClient } from "./ws-client.js";
import { SessionManager } from "./session-manager.js";
import { SessionMap } from "./session-map.js";
import { BranchPrCache } from "./branch-pr-cache.js";
import { OpencodeServerManager } from "./server-manager.js";
import { EventWatcher } from "./event-watcher.js";
import { detectStalls, buildDirectoryHints, type StallConfig } from "./stall-detector.js";
import { findFailingPrs, DEFAULT_WATCHDOG_CONFIG, type WatchdogConfig } from "./watchdog.js";
import { loadConfig, loadToken } from "./config.js";
import { logger, setLogLevel } from "./logger.js";
import type { ServerMessage } from "@opencode-observer/shared";

const STALL_CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
const WATCHDOG_INTERVAL_MS = 60 * 60 * 1000; // every hour

export class Daemon {
  private client: WebSocketClient | null = null;
  private sessions: SessionManager | null = null;
  private serverManager: OpencodeServerManager | null = null;
  private watchers: EventWatcher[] = [];
  private sessionMap: SessionMap | null = null;
  private branchPrCache: BranchPrCache | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private config: import("@opencode-observer/shared").ObserverConfig | null = null;
  private running = false;
  private shutdownBound: (() => Promise<void>) | null = null;

  async start(): Promise<void> {
    if (this.running) {
      logger.warn("Daemon already running");
      return;
    }

    const config = await loadConfig();
    setLogLevel(config.logLevel);

    const token = await loadToken();
    if (!token) {
      logger.error("No auth token found. Run 'opencode-observer auth' first.");
      process.exit(1);
    }

    logger.info("Starting daemon", { serverUrl: config.serverUrl, repos: Object.keys(config.repos) });

    this.config = config;

    // Persistent repo+PR -> opencode sessionID map.
    this.sessionMap = new SessionMap();
    await this.sessionMap.load();

    // Persistent branch -> PR cache so CI-failure events (which carry no PR
    // number in the GitHub check_run payload) can be enriched instantly.
    this.branchPrCache = new BranchPrCache();
    await this.branchPrCache.load();

    // Ensures an opencode server is running per watched repo working directory.
    this.serverManager = new OpencodeServerManager(config.opencodeCommand);

    // Start watching opencode event streams to learn which session originated
    // each branch/PR. One watcher per configured repo.
    for (const [repo, repoConfig] of Object.entries(config.repos)) {
      try {
        const server = await this.serverManager.ensure(repoConfig.workdir, repoConfig.serverUrl, repoConfig.serverPassword);
        const watcher = new EventWatcher(repo, server.client, this.sessionMap, this.branchPrCache ?? undefined);
        this.watchers.push(watcher);
        // Fire-and-forget; the watcher runs until stopped.
        watcher.start().catch((err) => logger.warn(`Watcher for ${repo} stopped`, err));
      } catch (err) {
        logger.error(`Could not start opencode server for ${repo}`, err);
      }
    }

    this.sessions = new SessionManager({
      repos: config.repos,
      serverManager: this.serverManager,
      sessionMap: this.sessionMap,
      ...(this.branchPrCache ? { branchPrCache: this.branchPrCache } : {}),
      ...(token ? { githubToken: token } : {}),
    });

    // Start periodic stall detection. Scans opencode sessions for bash tools
    // stuck in "running" state beyond a threshold and aborts them.
    const stallConfig: StallConfig = {
      thresholdMs: 30 * 60 * 1000, // 30 minutes
      directoryHints: buildDirectoryHints(config.repos),
      abort: true,
    };
    this.startStallDetection(stallConfig);

    // Start the watchdog: hourly scan of open PRs for CI failures; re-prompts
    // idle sessions that have a fresh session mapping. Catches cases where a
    // webhook was missed or a session went idle before fully fixing the issue.
    const watchdogConfig: WatchdogConfig = { ...DEFAULT_WATCHDOG_CONFIG };
    this.startWatchdog(watchdogConfig, token);

    this.client = new WebSocketClient(
      config.serverUrl,
      token,
      config.reconnectIntervalMs,
      config.maxReconnectIntervalMs,
      config.keepaliveIntervalMs,
    );

    const repoNames = Object.keys(config.repos);

    this.client.on("connected", (sessionId: string) => {
      logger.info(`Connected to server, session: ${sessionId}`);
      if (repoNames.length > 0) {
        this.client!.subscribe(repoNames);
        logger.info(`Subscribed to repos`, { repoNames });
      } else {
        logger.warn("No repos configured; events will not be routed. Use 'opencode-observer config set repos.{owner/repo}.workdir <path>'.");
      }
    });

    this.client.on("event", (msg: Extract<ServerMessage, { kind: "event" }>) => {
      logger.info(`Received event for ${msg.repo}`, { type: msg.event.type });
      this.sessions!.handleEvent(msg.event).catch((err) => {
        logger.error("Failed to handle event", err);
      });
    });

    this.client.on("error", (message: string) => {
      logger.error(`Server error: ${message}`);
    });

    this.client.on("disconnected", () => {
      logger.info("Disconnected from server");
    });

    this.client.on("reconnecting", (attempt: number) => {
      logger.info(`Reconnecting (attempt ${attempt})`);
    });

    this.client.connect();
    this.running = true;

    this.shutdownBound = async () => {
      logger.info("Shutting down");
      await this.stop();
      process.exit(0);
    };
    process.on("SIGINT", this.shutdownBound);
    process.on("SIGTERM", this.shutdownBound);
  }

  private startStallDetection(config: StallConfig): void {
    const run = async () => {
      for (const [repo, repoConfig] of Object.entries(this.config?.repos ?? {})) {
        try {
          const server = await this.serverManager!.ensure(repoConfig.workdir, repoConfig.serverUrl, repoConfig.serverPassword);
          const result = await detectStalls(server.client, config);
          if (result.findings.length > 0) {
            logger.info(`[${repo}] stall detection: ${result.findings.length} stalled, ${result.aborted.length} aborted`);
          }
        } catch (err) {
          logger.debug(`[${repo}] stall detection failed`, err);
        }
      }
    };

    // Run once after a short delay, then periodically.
    setTimeout(run, 10_000);
    this.stallTimer = setInterval(run, STALL_CHECK_INTERVAL_MS);
  }

  private startWatchdog(config: WatchdogConfig, token: string): void {
    const run = async () => {
      if (!this.sessions || !this.branchPrCache || !token) return;

      // Proactive cleanup: remove session map entries whose sessions no longer
      // exist (deleted/archived in OpenChamber). Without this, stale entries
      // accumulate forever if no events arrive for their PRs.
      await this.cleanupStaleMappings();

      for (const [repo, _repoConfig] of Object.entries(this.config?.repos ?? {})) {
        try {
          const result = await findFailingPrs(repo, token, this.branchPrCache!, config);
          // Log every run so we can confirm the watchdog is alive (even when
          // there's nothing to do — shows "watchdog: 0 failing, 0 unmapped, 0 conflicting").
          logger.info(`[${repo}] watchdog: ${result.failingPrs.length} failing PRs with sessions, ${result.unmappedPrs.length} unmapped failing PRs, ${result.conflictingPrs.length} conflicting PRs`);

          // Re-prompt idle sessions for failing PRs that have a session mapping.
          for (const pr of result.failingPrs) {
            const outcome = await this.sessions!.repromptIfIdle(
              repo,
              pr.prNumber,
              pr.branch,
              pr.headSha,
              pr.failNames,
              config.idleThresholdMs,
            );
            if (outcome === "prompted") {
              logger.info(`[${repo}] watchdog: re-prompted #${pr.prNumber} (failures: ${pr.failNames.join(", ")})`);
            }
          }

          // Re-prompt idle sessions for PRs with merge conflicts — ask them
          // to rebase on the base branch and resolve conflicts.
          for (const pr of result.conflictingPrs) {
            const outcome = await this.sessions!.repromptForMergeConflict(
              repo,
              pr.prNumber,
              pr.branch,
              pr.headSha,
              pr.baseRef,
              config.idleThresholdMs,
            );
            if (outcome === "prompted") {
              logger.info(`[${repo}] watchdog: re-prompted #${pr.prNumber} for merge conflict (base: ${pr.baseRef})`);
            }
          }

          // Log unmapped failing PRs at debug — these need an initial webhook
          // event to create a session; the watchdog deliberately doesn't
          // auto-create sessions to avoid spinning up work for renovate PRs etc.
          if (result.unmappedPrs.length > 0) {
            logger.debug(`[${repo}] watchdog: unmapped failing PRs (no session map entry):`, {
              prs: result.unmappedPrs.map((p) => `#${p.prNumber} (${p.failNames.join(",")})`),
            });
          }
        } catch (err) {
          logger.debug(`[${repo}] watchdog run failed`, err);
        }
      }
    };

    // Run once after a short delay (so the daemon settles first), then hourly.
    setTimeout(run, 30_000);
    this.watchdogTimer = setInterval(run, WATCHDOG_INTERVAL_MS);
  }

  // Removes session map entries whose sessions no longer exist in the opencode
  // server (deleted or archived in OpenChamber). Runs on every watchdog tick
  // so stale entries don't accumulate when no events arrive for their PRs.
  private async cleanupStaleMappings(): Promise<void> {
    if (!this.sessionMap || !this.serverManager || !this.config) return;
    const entries = this.sessionMap.list();
    if (entries.length === 0) return;

    let removed = 0;
    for (const entry of entries) {
      const repoConfig = this.config.repos[entry.repo];
      if (!repoConfig) continue;
      try {
        const server = await this.serverManager.ensure(repoConfig.workdir, repoConfig.serverUrl, repoConfig.serverPassword);
        const session = await server.client.getSession(entry.sessionID);
        // Also remove mappings for archived sessions — the agent is no longer
        // working on them, so routing events there is pointless.
        if (session.time?.archived) {
          this.sessionMap.delete(entry.sessionID);
          removed++;
          logger.info(`watchdog: removed mapping for ${entry.repo}#${entry.prNumber ?? entry.branch} (session ${entry.sessionID} is archived)`);
        }
      } catch {
        // Session is gone (deleted). Remove the stale mapping.
        this.sessionMap.delete(entry.sessionID);
        removed++;
        logger.info(`watchdog: removed stale mapping for ${entry.repo}#${entry.prNumber ?? entry.branch} (session ${entry.sessionID} no longer exists)`);
      }
    }
    if (removed > 0) {
      await this.sessionMap.persist();
      logger.info(`watchdog: cleaned up ${removed} stale session mapping(s)`);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    for (const watcher of this.watchers) watcher.stop();
    this.watchers = [];
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    await this.sessions?.shutdown();
    await this.serverManager?.stopAll();
    logger.info("Daemon stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  getSessions() {
    return this.sessions?.getAll() ?? [];
  }

  isConnected(): boolean {
    return this.client?.isConnected() ?? false;
  }
}
