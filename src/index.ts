import { createLogger } from "./logging/logger.js";
import { loadConfig } from "./config/loader.js";
import { BridgeApp } from "./runtime/app.js";
import { FeishuApiClient } from "./feishu/api.js";
import { createFeishuIngressOptions, FeishuWsClient } from "./feishu/ws.js";

type Runtime = {
  app: BridgeApp;
  ws: FeishuWsClient;
};

async function main(): Promise<Runtime> {
  const config = await loadConfig();
  const logger = await createLogger(config.logging.dir);
  const outbound = new FeishuApiClient(config.feishu.appId, config.feishu.appSecret);
  const app = new BridgeApp(config, outbound, logger);
  await app.start();
  const ws = new FeishuWsClient(
    config.feishu.appId,
    config.feishu.appSecret,
    createFeishuIngressOptions(config.feishu),
    (message) => app.handleIncomingMessage(message),
    logger,
  );
  await ws.start();
  return { app, ws };
}

let runtime: Runtime | null = null;
let shuttingDown: Promise<void> | null = null;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    return shuttingDown;
  }

  shuttingDown = (async () => {
    if (!runtime) {
      return;
    }

    try {
      await runtime.ws.stop();
    } catch (error) {
      console.error(`[shutdown:${reason}] failed to stop Feishu WS`, error);
    }

    try {
      await runtime.app.stop();
    } catch (error) {
      console.error(`[shutdown:${reason}] failed to stop bridge app`, error);
    }
  })();

  return shuttingDown;
}

process.once("SIGINT", () => {
  void shutdown("SIGINT").finally(() => {
    process.exit(0);
  });
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM").finally(() => {
    process.exit(0);
  });
});

process.once("beforeExit", () => {
  void shutdown("beforeExit");
});

void main()
  .then((started) => {
    runtime = started;
  })
  .catch(async (error) => {
    console.error(error);
    await shutdown("startup-error");
    process.exitCode = 1;
  });
