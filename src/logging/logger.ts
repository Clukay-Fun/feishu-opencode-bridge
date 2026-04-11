import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type TranscriptType = "inbound" | "outbound-process" | "outbound-final" | "opencode-reply" | "reasoning-raw";

export type Logger = {
  log: (scope: string, message: string, fields?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
  logTranscript: (type: TranscriptType, fields: Record<string, unknown>, content: string) => void;
};

export type LoggerOptions = {
  level: "debug" | "info" | "warn" | "error";
  enableTranscript: boolean;
  enableConsole: boolean;
  enableColor: boolean;
  rotateDaily: boolean;
};

const TRANSCRIPT_LABELS: Record<TranscriptType, string> = {
  inbound: "入站",
  "outbound-process": "出站-过程",
  "outbound-final": "出站-最终",
  "opencode-reply": "OpenCode回复",
  "reasoning-raw": "OpenCode思考原文",
};

const DEFAULT_LOGGER_OPTIONS: LoggerOptions = {
  level: "info",
  enableTranscript: true,
  enableConsole: true,
  enableColor: true,
  rotateDaily: true,
};

const LEVEL_PRIORITY: Record<LoggerOptions["level"], number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export async function createLogger(loggingDir: string, options: Partial<LoggerOptions> = {}): Promise<Logger> {
  await mkdir(loggingDir, { recursive: true });
  const resolvedOptions = {
    ...DEFAULT_LOGGER_OPTIONS,
    ...options,
  };

  return {
    log(scope, message, fields = {}, level = "info") {
      if (!shouldLog(level, resolvedOptions.level)) {
        return;
      }
      const line = `${timeStamp()} [${scope}] ${message} ${formatFields(fields)}`.trimEnd();
      void appendFile(resolveLogPath(loggingDir, "bridge", resolvedOptions.rotateDaily), `${line}\n`, "utf8");
      if (resolvedOptions.enableConsole) {
        console.log(resolvedOptions.enableColor ? colorizeLine(line, level) : line);
      }
    },
    logTranscript(type, fields, content) {
      if (!resolvedOptions.enableTranscript) {
        return;
      }
      const header = `[${TRANSCRIPT_LABELS[type]}] ${formatFields(fields)}`.trimEnd();
      const block = `${header}\n内容: ${content}\n---\n`;
      void appendFile(resolveLogPath(loggingDir, "transcript", resolvedOptions.rotateDaily), block, "utf8");
    },
  };
}

export function createTextPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function timeStamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function resolveLogPath(loggingDir: string, kind: "bridge" | "transcript", rotateDaily: boolean): string {
  if (!rotateDaily) {
    return path.join(loggingDir, `${kind}.log`);
  }

  const day = formatLocalDate(new Date());
  return path.join(loggingDir, `${kind}-${day}.log`);
}

function formatLocalDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shouldLog(level: LoggerOptions["level"], configuredLevel: LoggerOptions["level"]): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configuredLevel];
}

function colorizeLine(line: string, level: LoggerOptions["level"]): string {
  switch (level) {
    case "debug": return `\u001b[90m${line}\u001b[0m`;
    case "warn": return `\u001b[33m${line}\u001b[0m`;
    case "error": return `\u001b[31m${line}\u001b[0m`;
    case "info":
    default:
      return line;
  }
}

function formatFields(fields: Record<string, unknown>): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return "{}";
  }

  return `{ ${entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")} }`;
}
