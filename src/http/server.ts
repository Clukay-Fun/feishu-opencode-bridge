/**
 * 职责: 提供桥接层 HTTP 回调入口，处理飞书卡片动作请求。
 * 关注点:
 * - 接收飞书回调并完成基础验签。
 * - 将卡片动作转换为应用层可处理的调用。
 */
import { randomUUID } from "node:crypto";
import http from "node:http";

import type { AppConfig } from "../config/schema.js";
import { runWithLogContext } from "../logging/logger.js";
import { APP_VERSION } from "../version.js";

type LoggerLike = {
  log: (scope: string, message: string, fields?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
};

type CardActionPort = {
  handlePermissionCardAction(
    actorOpenId: string,
    openMessageId: string,
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  handleCardAction?(
    actorOpenId: string,
    openMessageId: string,
    value: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

/** 尝试把值收窄为普通对象。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

/** 将飞书可能传回的对象或 JSON 字符串统一成普通对象。 */
function parseRecordLike(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record) {
    return record;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

/** 沿嵌套路径读取字符串字段。 */
function readNestedString(value: unknown, ...path: string[]): string {
  let current: unknown = value;
  for (const part of path) {
    const record = asRecord(current);
    if (!record) return "";
    current = record[part];
  }
  return typeof current === "string" ? current : "";
}

/** 从飞书回调事件中提取操作者 open_id。 */
function extractActorOpenId(event: unknown): string {
  return readNestedString(event, "operator", "open_id")
    || readNestedString(event, "operator", "operator_id", "open_id")
    || readNestedString(event, "context", "open_id")
    || readNestedString(event, "open_id");
}

/** 从飞书回调事件中提取 open_message_id。 */
function extractOpenMessageId(event: unknown): string {
  return readNestedString(event, "context", "open_message_id")
    || readNestedString(event, "open_message", "open_message_id")
    || readNestedString(event, "open_message_id");
}

type NormalizedCardActionCallback = {
  actorOpenId: string;
  openMessageId: string;
  actionValue: Record<string, unknown>;
  chatId: string;
  host: string;
};

/** 将 SDK 解密/验签后的卡片事件收口为权限处理需要的最小视图。 */
export function normalizeCardActionCallback(event: unknown): NormalizedCardActionCallback {
  return {
    actorOpenId: extractActorOpenId(event),
    openMessageId: extractOpenMessageId(event),
    actionValue: extractActionValue(event),
    chatId: extractChatId(event),
    host: readNestedString(event, "context", "host") || readNestedString(event, "host"),
  };
}

/** 优先读取标准 action.value；缺失时只查找权限按钮 value。 */
function extractActionValue(event: unknown): Record<string, unknown> {
  const direct = asRecord(asRecord(event)?.action)?.value;
  const directRecord = parseRecordLike(direct);
  if (directRecord) {
    return directRecord;
  }

  return findPermissionActionValue(event, 0) ?? {};
}

/** 从回调里提取 chat id，仅用于日志和诊断。 */
function extractChatId(event: unknown): string {
  return readNestedString(event, "context", "open_chat_id")
    || readNestedString(event, "context", "chat_id")
    || readNestedString(event, "open_chat_id")
    || readNestedString(event, "chat_id");
}

/** 在异常卡片结构里有限递归查找权限按钮 value，避免记录或遍历整个 payload。 */
function findPermissionActionValue(value: unknown, depth: number): Record<string, unknown> | null {
  if (depth > 5) {
    return null;
  }

  const record = parseRecordLike(value);
  if (!record) {
    return null;
  }

  if (record.kind === "permission") {
    return record;
  }

  for (const nested of Object.values(record)) {
    if (Array.isArray(nested)) {
      for (const item of nested) {
        const found = findPermissionActionValue(item, depth + 1);
        if (found) return found;
      }
      continue;
    }
    const found = findPermissionActionValue(nested, depth + 1);
    if (found) return found;
  }

  return null;
}

export type BridgeHttpServer = {
  close(): Promise<void>;
};

type CardActionEvent = {
  action?: { value?: Record<string, unknown> };
} & Record<string, unknown>;

/** 启动 bridge 的 HTTP 服务，并挂载健康检查与卡片回调。 */
export async function startBridgeHttpServer(
  config: AppConfig,
  actions: CardActionPort,
  logger: LoggerLike,
): Promise<BridgeHttpServer> {
  const startedAt = Date.now();
  const lark = (await import("@larksuiteoapi/node-sdk") as unknown) as {
    CardActionHandler: new (
      params: Record<string, string>,
      handler: (event: CardActionEvent) => Promise<Record<string, unknown>>,
    ) => unknown;
    adaptDefault: (
      path: string,
      dispatcher: unknown,
      options?: { autoChallenge?: boolean },
    ) => (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
  };

  const adapter = config.feishu.cardActions.enabled
    ? lark.adaptDefault(
      config.feishu.cardActions.path,
      new lark.CardActionHandler(
        {
          ...(config.feishu.cardActions.verificationToken
            ? { verificationToken: config.feishu.cardActions.verificationToken }
            : {}),
          ...(config.feishu.cardActions.encryptKey
            ? { encryptKey: config.feishu.cardActions.encryptKey }
            : {}),
        },
        async (event) => {
          const callback = normalizeCardActionCallback(event);

          return await runWithLogContext({
            userId: callback.actorOpenId,
            messageId: callback.openMessageId,
          }, async () => {
            logger.log("http/server", "callback event parsed", {
              actorPresent: callback.actorOpenId.length > 0,
              openMessageId: callback.openMessageId,
              actionKind: typeof callback.actionValue.kind === "string" ? callback.actionValue.kind : "",
              nonce: typeof callback.actionValue.nonce === "string" ? callback.actionValue.nonce : "",
              permissionId: typeof callback.actionValue.permissionId === "string" ? callback.actionValue.permissionId : "",
              chatSummary: summarizeIdentifier(callback.chatId),
              host: callback.host,
            });

            if (!callback.actorOpenId) {
              logger.log("http/server", "callback actor missing", {
                actorPresent: false,
                openMessageId: callback.openMessageId,
                actionKind: typeof callback.actionValue.kind === "string" ? callback.actionValue.kind : "",
              }, "warn");
              return buildCardActionNotice("无法识别操作者，请使用文本命令兜底。");
            }

            if (!callback.actionValue.kind || callback.actionValue.kind === "permission") {
              return await actions.handlePermissionCardAction(
                callback.actorOpenId,
                callback.openMessageId,
                callback.actionValue,
              );
            }

            if (actions.handleCardAction) {
              return await actions.handleCardAction(
                callback.actorOpenId,
                callback.openMessageId,
                callback.actionValue,
              );
            }

            return buildCardActionNotice("未识别的卡片操作，请使用文本命令兜底。");
          });
        },
      ),
      { autoChallenge: true },
    )
    : null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${config.server.host}:${config.server.port}`}`);

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        bridgeVersion: APP_VERSION,
        uptimeSec: Math.max(0, Math.floor((Date.now() - startedAt) / 1000)),
        queueLimit: config.bridge.queueLimit,
        cardActionsEnabled: config.feishu.cardActions.enabled,
        cardActionsPath: config.feishu.cardActions.path,
        rssBytes: process.memoryUsage().rss,
        heapUsedBytes: process.memoryUsage().heapUsed,
      }));
      return;
    }

    if (adapter && url.pathname === config.feishu.cardActions.path && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        bridgeVersion: APP_VERSION,
        cardActionsEnabled: true,
        cardActionsPath: config.feishu.cardActions.path,
        message: "card action callback endpoint is ready; Feishu callbacks must use POST",
      }));
      return;
    }

    if (adapter && url.pathname === config.feishu.cardActions.path) {
      await runWithLogContext({ correlationId: randomUUID() }, async () => {
        logger.log("http/card-action", "callback received", {
          method: req.method ?? "UNKNOWN",
          path: url.pathname,
          userAgent: req.headers["user-agent"] ?? "",
          contentType: req.headers["content-type"] ?? "",
        });
        try {
          await adapter(req, res);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          logger.log("http/card-action", "callback adapter failed", {
            method: req.method ?? "UNKNOWN",
            path: url.pathname,
            userAgent: req.headers["user-agent"] ?? "",
            contentType: req.headers["content-type"] ?? "",
            detail,
          }, "warn");
          if (!res.headersSent) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ error: "invalid card action callback" }));
          }
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.server.port, config.server.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  logger.log("http/server", "http server started", {
    host: config.server.host,
    port: config.server.port,
    publicBaseUrl: config.server.publicBaseUrl.toString(),
    cardActionsEnabled: config.feishu.cardActions.enabled,
    cardActionsPath: config.feishu.cardActions.path,
  });

  return {
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

/** 仅展示 id 形态，不在日志中输出完整群聊或消息标识。 */
function summarizeIdentifier(value: string): string {
  if (!value) {
    return "";
  }
  if (value.length <= 10) {
    return value;
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

/** 构建卡片 action 的轻量提示响应。 */
function buildCardActionNotice(content: string): Record<string, unknown> {
  return {
    toast: {
      type: "warning",
      content,
    },
  };
}
