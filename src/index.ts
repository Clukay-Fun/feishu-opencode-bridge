/**
 * 职责: 作为应用入口，完成启动装配与优雅关闭编排。
 * 关注点:
 * - 加载配置、初始化依赖并启动各类运行时组件。
 * - 处理信号退出时的资源回收与停止顺序。
 */
import { createLogger } from "./logging/logger.js";
import { loadConfigWithWarnings } from "./config/loader.js";
import { BridgeApp } from "./runtime/app.js";
import { FeishuApiClient } from "./feishu/api.js";
import { createFeishuIngressOptions, FeishuWsClient } from "./feishu/ws.js";
import { WhitelistStore } from "./store/whitelist.js";
import { runStartupPreflight } from "./runtime/preflight.js";
import { startBridgeHttpServer } from "./http/server.js";
import { APP_VERSION } from "./version.js";
import { loadExternalExtensions } from "./runtime/load-extensions.js";

/** 组装并启动整个 bridge 运行时。 */
async function main(): Promise<void> {
  const externalExtensions = await loadExternalExtensions();
  const { config, warnings: configWarnings } = await loadConfigWithWarnings({ extensionMetas: externalExtensions.metas });
  const outbound = new FeishuApiClient(config.feishu.appId, config.feishu.appSecret);
  await runStartupPreflight(config, outbound);
  const logger = await createLogger(config.logging.dir, {
    ...config.logging,
    enableConsole: process.env.BRIDGE_CONSOLE_LOG === "0" ? false : config.logging.enableConsole,
  });
  for (const warning of configWarnings) {
    logger.log("config/loader", warning.message, {
      code: warning.code,
      extensionId: warning.extensionId,
      configKey: warning.configKey,
    }, "warn");
  }
  for (const warning of externalExtensions.warnings) {
    logger.log("runtime/extensions", warning, {}, "warn");
  }
  const whitelist = new WhitelistStore(config.whitelist.storePath, logger);
  await whitelist.load();
  const app = new BridgeApp(config, outbound, logger, whitelist, {
    externalExtensions: externalExtensions.extensions,
  });
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
    externalExtensionCount: externalExtensions.extensions.length,
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
