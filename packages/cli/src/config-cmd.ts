import { loadConfig, saveConfig } from "@opencode-observer/daemon/config";
import type { ObserverConfig } from "@opencode-observer/shared";

export async function configCommand(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "get": {
      const key = args[1];
      const config = await loadConfig();
      if (key) {
        const value = getNested(config, key.split("."));
        if (value === undefined) {
          console.log(`${key}: (not set)`);
        } else {
          console.log(`${key}: ${JSON.stringify(value)}`);
        }
      } else {
        console.log(JSON.stringify(config, null, 2));
      }
      break;
    }
    case "set": {
      const key = args[1];
      const value = args[2];
      if (!key || value === undefined) {
        console.log("Usage: opencode-observer config set <key> <value>");
        console.log("  Keys may be dotted, e.g. repos.owner/repo.workdir");
        break;
      }
      let parsed: unknown = value;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value;
      }
      const patch = setNested({}, key.split("."), parsed) as Partial<ObserverConfig>;
      try {
        await saveConfig(patch);
        console.log(`Set ${key} = ${JSON.stringify(parsed)}`);
      } catch (err) {
        console.error(`Failed to set ${key}: ${(err as Error).message}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.log("Usage: opencode-observer config <get|set> [key] [value]");
      console.log("  Keys may be dotted, e.g. repos.owner/repo.workdir");
      break;
  }
}

function getNested(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const part of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setNested(obj: Record<string, unknown>, path: string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const next: Record<string, unknown> = { ...obj };
  next[head] = rest.length === 0 ? value : setNested((obj[head] as Record<string, unknown>) ?? {}, rest, value);
  return next;
}
