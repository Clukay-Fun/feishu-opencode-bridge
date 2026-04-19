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
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function readNestedString(value: unknown, ...path: string[]): string {
  let current: unknown = value;
  for (const part of path) {
    const record = asRecord(current);
    if (!record) return "";
    current = record[part];
  }
  return typeof current === "string" ? current : "";
}

function extractActorOpenId(event: unknown): string {
  return readNestedString(event, "operator", "open_id")
    || readNestedString(event, "operator", "operator_id", "open_id")
    || readNestedString(event, "context", "open_id")
    || readNestedString(event, "open_id");
}

function extractOpenMessageId(event: unknown): string {
  return readNestedString(event, "context", "open_message_id")
    || readNestedString(event, "open_message", "open_message_id")
    || readNestedString(event, "open_message_id");
}

export type BridgeHttpServer = {
  close(): Promise<void>;
};

type CardActionEvent = {
  action?: { value?: Record<string, unknown> };
} & Record<string, unknown>;

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
          const actorOpenId = extractActorOpenId(event);
          const openMessageId = extractOpenMessageId(event);
          const actionValue = event.action?.value ?? {};

          return await runWithLogContext({
            userId: actorOpenId,
            messageId: openMessageId,
          }, async () => {
            logger.log("http/server", "callback event parsed", {
              actorOpenId,
              openMessageId,
              actionValueKind: typeof actionValue.kind === "string" ? actionValue.kind : "",
              ...flattenScalarFields("callback", event),
            });

            return await actions.handlePermissionCardAction(
              actorOpenId,
              openMessageId,
              actionValue,
            );
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

    if (adapter && url.pathname === config.feishu.cardActions.path) {
      await runWithLogContext({ correlationId: randomUUID() }, async () => {
        logger.log("http/card-action", "callback received", {
          method: req.method ?? "UNKNOWN",
          path: url.pathname,
          userAgent: req.headers["user-agent"] ?? "",
          contentType: req.headers["content-type"] ?? "",
        });
        await adapter(req, res);
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

function flattenScalarFields(prefix: string, value: unknown): Record<string, string | number | boolean | null> {
  const fields: Record<string, string | number | boolean | null> = {};
  collectScalarFields(fields, prefix, value);
  return fields;
}

function collectScalarFields(
  fields: Record<string, string | number | boolean | null>,
  path: string,
  value: unknown,
): void {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    fields[path] = value;
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectScalarFields(fields, `${path}.${index}`, item);
    });
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    collectScalarFields(fields, `${path}.${key}`, nestedValue);
  }
}
