import { createLogger } from "./logging/logger.js";
import { loadConfig } from "./config/loader.js";
import { BridgeApp } from "./runtime/app.js";
import { FeishuApiClient } from "./feishu/api.js";
import { createFeishuIngressOptions, FeishuWsClient } from "./feishu/ws.js";
import { WhitelistStore } from "./store/whitelist.js";
import { runStartupPreflight } from "./runtime/preflight.js";
import { startBridgeHttpServer } from "./http/server.js";
import { APP_VERSION } from "./version.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const outbound = new FeishuApiClient(config.feishu.appId, config.feishu.appSecret);
  await runStartupPreflight(config, outbound);
  const logger = await createLogger(config.logging.dir, config.logging);
  const whitelist = new WhitelistStore(config.whitelist.storePath, logger);
  await whitelist.load();
  const app = new BridgeApp(config, outbound, logger, whitelist);
  await app.start();
  const httpServer = await startBridgeHttpServer(config, app, logger);
  const ws = new FeishuWsClient(
    config.feishu.appId,
    config.feishu.appSecret,
    createFeishuIngressOptions(config.feishu),
    whitelist,
    (message) => app.handleIncomingMessage(message),
    logger,
  );
  await ws.start();

  let shuttingDown = false;
  logger.log("bridge/index", "runtime initialized", {
    bridgeVersion: APP_VERSION,
  });

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.log("bridge/index", "shutdown started", {});
    await Promise.allSettled([
      ws.stop(),
      httpServer.close(),
      app.stop(),
    ]);
    logger.log("bridge/index", "shutdown completed", {});
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("beforeExit", () => {
    void shutdown();
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
