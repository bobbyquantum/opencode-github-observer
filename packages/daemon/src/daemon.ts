import { WebSocketClient } from "./ws-client.js";
import { SessionManager } from "./session-manager.js";
import { SessionMap } from "./session-map.js";
import { OpencodeServerManager } from "./server-manager.js";
import { EventWatcher } from "./event-watcher.js";
import { detectStalls, buildDirectoryHints, type StallConfig } from "./stall-detector.js";
import { loadConfig, loadToken } from "./config.js";
import { logger, setLogLevel } from "./logger.js";
import type { ServerMessage } from "@opencode-observer/shared";

const STALL_CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

export class Daemon {
  private client: WebSocketClient | null = null;
  private sessions: SessionManager | null = null;
  private serverManager: OpencodeServerManager | null = null;
  private watchers: EventWatcher[] = [];
  private sessionMap: SessionMap | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
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

    // Ensures an opencode server is running per watched repo working directory.
    this.serverManager = new OpencodeServerManager(config.opencodeCommand);

    // Start watching opencode event streams to learn which session originated
    // each branch/PR. One watcher per configured repo.
    for (const [repo, repoConfig] of Object.entries(config.repos)) {
      try {
        const server = await this.serverManager.ensure(repoConfig.workdir, repoConfig.serverUrl, repoConfig.serverPassword);
        const watcher = new EventWatcher(repo, server.client, this.sessionMap);
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
    });

    // Start periodic stall detection. Scans opencode sessions for bash tools
    // stuck in "running" state beyond a threshold and aborts them.
    const stallConfig: StallConfig = {
      thresholdMs: 30 * 60 * 1000, // 30 minutes
      directoryHints: buildDirectoryHints(config.repos),
      abort: true,
    };
    this.startStallDetection(stallConfig);

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

  async stop(): Promise<void> {
    this.running = false;
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
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
