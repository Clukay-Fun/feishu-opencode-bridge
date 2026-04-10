import http from "node:http";

import type { AppConfig } from "../config/schema.js";

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
          const actorOpenId = pickString(event, [["operator", "open_id"], ["operator", "operator_id", "open_id"], ["context", "open_id"], ["open_id"]]);
          const openMessageId = pickString(event, [["context", "open_message_id"], ["open_message_id"]]);
          const actionValue = event.action?.value ?? {};

          logger.log("http/server", "callback event parsed", {
            actorOpenId,
            openMessageId,
            actionValueKind: typeof actionValue.kind === "string" ? actionValue.kind : "",
            ...flattenScalarFields("callback", event),
          });

          return actions.handlePermissionCardAction(
            actorOpenId,
            openMessageId,
            actionValue,
          );
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
      await adapter(req, res);
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

function pickString(source: Record<string, unknown>, paths: string[][]): string {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return "";
}

function readPath(source: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
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
