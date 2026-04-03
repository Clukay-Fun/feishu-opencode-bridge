import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export type TranscriptType = "inbound" | "outbound-process" | "outbound-final" | "opencode-reply" | "reasoning-raw";

export type Logger = {
  log: (scope: string, message: string, fields?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
  logTranscript: (type: TranscriptType, fields: Record<string, unknown>, content: string) => void;
};

const TRANSCRIPT_LABELS: Record<TranscriptType, string> = {
  inbound: "入站",
  "outbound-process": "出站-过程",
  "outbound-final": "出站-最终",
  "opencode-reply": "OpenCode回复",
  "reasoning-raw": "OpenCode思考原文",
};

export async function createLogger(loggingDir: string): Promise<Logger> {
  await mkdir(loggingDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const bridgeLog = path.join(loggingDir, `bridge-${day}.log`);
  const transcriptLog = path.join(loggingDir, `transcript-${day}.log`);

  return {
    log(scope, message, fields = {}) {
      const line = `${timeStamp()} [${scope}] ${message} ${formatFields(fields)}`.trimEnd();
      void appendFile(bridgeLog, `${line}\n`, "utf8");
      console.log(line);
    },
    logTranscript(type, fields, content) {
      const header = `[${TRANSCRIPT_LABELS[type]}] ${formatFields(fields)}`.trimEnd();
      const block = `${header}\n内容: ${content}\n---\n`;
      void appendFile(transcriptLog, block, "utf8");
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

function formatFields(fields: Record<string, unknown>): string {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return "{}";
  }

  return `{ ${entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")} }`;
}
