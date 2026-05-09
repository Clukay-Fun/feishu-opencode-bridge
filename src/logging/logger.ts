/**
 * 职责: 提供系统日志与对话副本日志的统一记录能力。
 * 关注点:
 * - 写入 bridge.log 与 transcript.log 两类日志。
 * - 支持上下文透传、脱敏策略和结构化事件输出。
 * - 为运行时调试、审计和回放提供基础设施。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export type TranscriptType = "inbound" | "outbound-process" | "outbound-final" | "opencode-reply" | "reasoning-raw";
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFormat = "pretty" | "json";
export type LogMessagePolicy = "full" | "preview" | "hash" | "none";
export type BridgeEventName =
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "turn.fallback_triggered"
  | "permission.asked"
  | "permission.decided"
  | "module.invoked"
  | "module.failed"
  | "transport.sent"
  | "transport.failed";

export type LogContext = {
  correlationId?: string | undefined;
  turnId?: string | undefined;
  userId?: string | undefined;
  chatId?: string | undefined;
  messageId?: string | undefined;
  sessionId?: string | undefined;
};

export type Logger = {
  log: (scope: string, message: string, fields?: Record<string, unknown>, level?: LogLevel) => void;
  event?: (scope: string, event: BridgeEventName, fields?: Record<string, unknown>, level?: LogLevel) => void;
  logTranscript: (type: TranscriptType, fields: Record<string, unknown>, content: string) => void;
};

export type LoggerOptions = {
  level: LogLevel;
  enableTranscript: boolean;
  enableConsole: boolean;
  enableColor: boolean;
  rotateDaily: boolean;
  format: LogFormat;
  messagePolicy: LogMessagePolicy;
  redactFields: string[];
};
export type LoggerInputOptions = {
  [Key in keyof LoggerOptions]?: LoggerOptions[Key] | undefined;
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
  format: "pretty",
  messagePolicy: "preview",
  redactFields: [
    "feishu.appSecret",
    "opencode.apiKey",
    "appSecret",
    "apiKey",
    "plainText",
    "content",
  ],
};

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const logContextStorage = new AsyncLocalStorage<LogContext>();

// #region 对外接口

/** 在异步调用链中挂载日志上下文。 */
export async function runWithLogContext<T>(context: LogContext, callback: () => Promise<T>): Promise<T> {
  const parent = logContextStorage.getStore() ?? {};
  return await logContextStorage.run({ ...parent, ...compactContext(context) }, callback);
}

/** 读取当前异步上下文中的日志字段。 */
export function getLogContext(): LogContext {
  return logContextStorage.getStore() ?? {};
}

/** 优先走结构化 event 接口；无 event 实现时退回普通日志。 */
export function logEvent(
  logger: Pick<Logger, "log" | "event">,
  scope: string,
  event: BridgeEventName,
  fields: Record<string, unknown> = {},
  level: LogLevel = "info",
): void {
  if (logger.event) {
    logger.event(scope, event, fields, level);
    return;
  }
  logger.log(scope, event, { event, ...fields }, level);
}

/** 创建日志实例，并初始化日志目录。 */
export async function createLogger(loggingDir: string, options: LoggerInputOptions = {}): Promise<Logger> {
  await mkdir(loggingDir, { recursive: true });
  const resolvedOptions: LoggerOptions = {
    ...DEFAULT_LOGGER_OPTIONS,
    ...options,
    level: options.level ?? DEFAULT_LOGGER_OPTIONS.level,
    enableTranscript: options.enableTranscript ?? DEFAULT_LOGGER_OPTIONS.enableTranscript,
    enableConsole: options.enableConsole ?? DEFAULT_LOGGER_OPTIONS.enableConsole,
    enableColor: options.enableColor ?? DEFAULT_LOGGER_OPTIONS.enableColor,
    rotateDaily: options.rotateDaily ?? DEFAULT_LOGGER_OPTIONS.rotateDaily,
    format: options.format ?? DEFAULT_LOGGER_OPTIONS.format,
    messagePolicy: options.messagePolicy ?? DEFAULT_LOGGER_OPTIONS.messagePolicy,
    redactFields: options.redactFields ?? DEFAULT_LOGGER_OPTIONS.redactFields,
  };

  return {
    log(scope, message, fields = {}, level = "info") {
      if (!shouldLog(level, resolvedOptions.level)) {
        return;
      }
      writeBridgeLog(loggingDir, resolvedOptions, scope, message, fields, level);
    },
    event(scope, event, fields = {}, level = "info") {
      if (!shouldLog(level, resolvedOptions.level)) {
        return;
      }
      writeBridgeLog(loggingDir, resolvedOptions, scope, event, { event, ...fields }, level);
    },
    logTranscript(type, fields, content) {
      if (!resolvedOptions.enableTranscript) {
        return;
      }
      const header = `[${TRANSCRIPT_LABELS[type]}] ${formatFields(prepareFields(fields, resolvedOptions))}`.trimEnd();
      const block = `${header}\n内容: ${content}\n---\n`;
      appendLogLine(resolveLogPath(loggingDir, "transcript", resolvedOptions.rotateDaily), block);
    },
  };
}

/** 生成适合日志展示的短文本预览。 */
export function createTextPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

// #endregion

// #region 内部格式化与落盘

function timeStamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

function resolveLogPath(loggingDir: string, kind: "bridge" | "transcript", rotateDaily: boolean): string {
  if (!rotateDaily) {
    return path.join(loggingDir, `${kind}.log`);
  }

  const day = formatLocalDay(new Date());
  return path.join(loggingDir, `${kind}-${day}.log`);
}

function formatLocalDay(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shouldLog(level: LogLevel, configuredLevel: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configuredLevel];
}

function colorizeLine(line: string, level: LogLevel): string {
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

function writeBridgeLog(
  loggingDir: string,
  options: LoggerOptions,
  scope: string,
  message: string,
  fields: Record<string, unknown>,
  level: LogLevel,
): void {
  const preparedFields = prepareFields(fields, options);
  const line = options.format === "json"
    ? formatJsonLine(scope, message, preparedFields, level)
    : `${timeStamp()} [${scope}] ${message} ${formatFields(preparedFields)}`.trimEnd();
  appendLogLine(resolveLogPath(loggingDir, "bridge", options.rotateDaily), `${line}\n`);
  if (options.enableConsole) {
    console.log(options.enableColor && options.format === "pretty" ? colorizeLine(line, level) : line);
  }
}

// #endregion

function appendLogLine(filePath: string, content: string): void {
  // 日志写入本身不应影响业务流程；同步写入让测试和短生命周期 CLI 不再和异步落盘竞态。
  try {
    appendFileSync(filePath, content, "utf8");
  } catch {
    // Ignore logging failures: callers should not fail because a log file cannot be written.
  }
}

function prepareFields(fields: Record<string, unknown>, options: LoggerOptions): Record<string, unknown> {
  return applyMessagePolicy(redactFields({
    ...getLogContext(),
    ...fields,
  }, new Set(options.redactFields)), options.messagePolicy);
}

function formatJsonLine(
  scope: string,
  message: string,
  fields: Record<string, unknown>,
  level: LogLevel,
): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
    ...fields,
  });
}

function redactFields(fields: Record<string, unknown>, redactedKeys: Set<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => {
    if (redactedKeys.has(key)) {
      return [key, "[REDACTED]"];
    }
    return [key, value];
  }));
}

function applyMessagePolicy(fields: Record<string, unknown>, policy: LogMessagePolicy): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(fields, "textPreview")) {
    return fields;
  }

  const value = fields.textPreview;
  if (typeof value !== "string") {
    return fields;
  }

  if (policy === "full" || policy === "preview") {
    return policy === "preview"
      ? { ...fields, textPreview: createTextPreview(value) }
      : fields;
  }

  if (policy === "hash") {
    return {
      ...fields,
      textPreviewHash: createHash("sha256").update(value).digest("hex"),
      textPreview: "[HASHED]",
    };
  }

  return {
    ...fields,
    textPreview: "[REDACTED]",
  };
}

function compactContext(context: LogContext): LogContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => typeof value === "string" && value.length > 0),
  ) as LogContext;
}
