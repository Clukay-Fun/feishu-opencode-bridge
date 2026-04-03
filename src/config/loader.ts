import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "./schema.js";
import { ConfigSchema } from "./schema.js";

export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const resolvedConfigPath = configPath ? path.resolve(configPath) : path.resolve("config.json");
  const raw = JSON.parse(await readFile(resolvedConfigPath, "utf8")) as unknown;
  const parsed = ConfigSchema.parse(raw);
  const baseDir = path.dirname(resolvedConfigPath);
  const dataDir = resolveRelative(baseDir, parsed.storage.dataDir);
  const loggingDir = resolveRelative(baseDir, parsed.logging.dir);
  await mkdir(dataDir, { recursive: true });
  await mkdir(loggingDir, { recursive: true });

  return {
    feishu: {
      appId: parsed.feishu.appId,
      appSecret: parsed.feishu.appSecret,
      wsUrl: new URL(parsed.feishu.wsUrl),
      allowedOpenIds: new Set(parsed.feishu.allowedOpenIds),
    },
    opencode: {
      baseUrl: new URL(parsed.opencode.baseUrl),
      directory: resolveRelative(baseDir, parsed.opencode.directory),
    },
    storage: {
      dataDir,
      mappingsFile: parsed.storage.mappingsFile,
    },
    bridge: {
      queueLimit: parsed.bridge.queueLimit,
      firstEventTimeoutMs: parsed.bridge.timeouts.firstEvent,
      eventGapTimeoutMs: parsed.bridge.timeouts.eventInterval,
      totalTimeoutMs: parsed.bridge.timeouts.totalTurn,
    },
    logging: {
      dir: loggingDir,
      level: parsed.logging.level,
      enableTranscript: parsed.logging.enableTranscript,
      enableConsole: parsed.logging.enableConsole,
      enableColor: parsed.logging.enableColor,
      rotateDaily: parsed.logging.rotateDaily,
    },
  };
}

function resolveRelative(baseDir: string, value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}
