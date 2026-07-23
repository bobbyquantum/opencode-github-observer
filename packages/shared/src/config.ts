export type RepoConfig = {
  workdir: string;
  serverUrl?: string;
  serverPassword?: string;
};

export type ObserverConfig = {
  serverUrl: string;
  githubClientId: string;
  tokenPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
  reconnectIntervalMs: number;
  maxReconnectIntervalMs: number;
  keepaliveIntervalMs: number;
  opencodeCommand: string;
  repos: Record<string, RepoConfig>;
  // Instructions appended to every prompt the daemon sends to an agent.
  // Tells the agent what its goal is when handling CI failures, review
  // comments, and merge conflicts. Configurable via:
  //   opencode-observer config set promptInstructions "..."
  promptInstructions: string;
};

export const DEFAULT_CONFIG: ObserverConfig = {
  serverUrl: "wss://github.quantum.observer/ws",
  githubClientId: "",
  tokenPath: "",
  logLevel: "info",
  reconnectIntervalMs: 1000,
  maxReconnectIntervalMs: 30000,
  keepaliveIntervalMs: 30000,
  opencodeCommand: "opencode",
  repos: {},
  promptInstructions: [
    "Your goal is to fully resolve every issue raised in this event.",
    "- Address every review comment individually. Do not skip any.",
    "- Fix every CI failure. Check the logs, identify the root cause, and push a fix.",
    "- Fix any bad code, small issues, or flagged issues mentioned in the event.",
    "- Do not stop until all issues are resolved and CI passes.",
    "- Push your changes to the branch when done.",
  ].join("\n"),
};

export type DeviceFlowResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

export type TokenResponse =
  | { access_token: string; token_type: string; scope: string }
  | { error: string; error_description?: string };

export type GitHubUserInfo = {
  id: number;
  login: string;
};

export function validateConfig(value: unknown): ObserverConfig {
  if (typeof value !== "object" || value === null) {
    throw new Error("Config must be an object");
  }
  const obj = value as Record<string, unknown>;
  const config: ObserverConfig = { ...DEFAULT_CONFIG };

  if (obj.serverUrl !== undefined) {
    if (typeof obj.serverUrl !== "string") throw new Error("serverUrl must be a string");
    try { new URL(obj.serverUrl); } catch { throw new Error("serverUrl must be a valid URL"); }
    config.serverUrl = obj.serverUrl;
  }

  if (obj.githubClientId !== undefined) {
    if (typeof obj.githubClientId !== "string") throw new Error("githubClientId must be a string");
    config.githubClientId = obj.githubClientId;
  }

  if (obj.tokenPath !== undefined) {
    if (typeof obj.tokenPath !== "string") throw new Error("tokenPath must be a string");
    config.tokenPath = obj.tokenPath;
  }

  if (obj.logLevel !== undefined) {
    if (!["debug", "info", "warn", "error"].includes(obj.logLevel as string)) {
      throw new Error("logLevel must be one of: debug, info, warn, error");
    }
    config.logLevel = obj.logLevel as ObserverConfig["logLevel"];
  }

  if (obj.reconnectIntervalMs !== undefined) {
    if (typeof obj.reconnectIntervalMs !== "number" || !Number.isInteger(obj.reconnectIntervalMs) || obj.reconnectIntervalMs <= 0) {
      throw new Error("reconnectIntervalMs must be a positive integer");
    }
    config.reconnectIntervalMs = obj.reconnectIntervalMs;
  }

  if (obj.maxReconnectIntervalMs !== undefined) {
    if (typeof obj.maxReconnectIntervalMs !== "number" || !Number.isInteger(obj.maxReconnectIntervalMs) || obj.maxReconnectIntervalMs <= 0) {
      throw new Error("maxReconnectIntervalMs must be a positive integer");
    }
    config.maxReconnectIntervalMs = obj.maxReconnectIntervalMs;
  }

  if (obj.keepaliveIntervalMs !== undefined) {
    if (typeof obj.keepaliveIntervalMs !== "number" || !Number.isInteger(obj.keepaliveIntervalMs) || obj.keepaliveIntervalMs < 0) {
      throw new Error("keepaliveIntervalMs must be a non-negative integer (0 disables it)");
    }
    config.keepaliveIntervalMs = obj.keepaliveIntervalMs;
  }

  if (obj.opencodeCommand !== undefined) {
    if (typeof obj.opencodeCommand !== "string" || obj.opencodeCommand.trim() === "") {
      throw new Error("opencodeCommand must be a non-empty string");
    }
    config.opencodeCommand = obj.opencodeCommand;
  }

  if (obj.promptInstructions !== undefined) {
    if (typeof obj.promptInstructions !== "string") {
      throw new Error("promptInstructions must be a string");
    }
    config.promptInstructions = obj.promptInstructions;
  }

  if (obj.repos !== undefined) {
    if (typeof obj.repos !== "object" || obj.repos === null) {
      throw new Error("repos must be an object");
    }
    const repos: Record<string, RepoConfig> = {};
    for (const [fullName, val] of Object.entries(obj.repos as Record<string, unknown>)) {
      if (typeof val !== "object" || val === null) {
        throw new Error(`repos.${fullName} must be an object`);
      }
      const r = val as Record<string, unknown>;
      if (typeof r.workdir !== "string" || r.workdir.trim() === "") {
        throw new Error(`repos.${fullName}.workdir must be a non-empty string`);
      }
      if (r.serverUrl !== undefined && (typeof r.serverUrl !== "string" || r.serverUrl.trim() === "")) {
        throw new Error(`repos.${fullName}.serverUrl must be a string`);
      }
      if (r.serverUrl !== undefined) {
        try { new URL(r.serverUrl); } catch { throw new Error(`repos.${fullName}.serverUrl must be a valid URL`); }
      }
      if (r.serverPassword !== undefined && typeof r.serverPassword !== "string") {
        throw new Error(`repos.${fullName}.serverPassword must be a string`);
      }
      repos[fullName] = {
        workdir: r.workdir,
        ...(r.serverUrl !== undefined ? { serverUrl: r.serverUrl } : {}),
        ...(r.serverPassword !== undefined ? { serverPassword: r.serverPassword } : {}),
      };
    }
    config.repos = repos;
  }

  return config;
}
