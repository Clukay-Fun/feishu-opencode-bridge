import { createLogger } from "./logging/logger.js";
import { loadConfig } from "./config/loader.js";
import { BridgeApp } from "./runtime/app.js";
import { FeishuApiClient } from "./feishu/api.js";
import { createFeishuIngressOptions, FeishuWsClient } from "./feishu/ws.js";
import { WhitelistStore } from "./store/whitelist.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const logger = await createLogger(config.logging.dir);
  const outbound = new FeishuApiClient(config.feishu.appId, config.feishu.appSecret);
  const whitelist = new WhitelistStore(config.whitelist.storePath, logger);
  await whitelist.load();
  const app = new BridgeApp(config, outbound, logger, whitelist);
  await app.start();
  const ws = new FeishuWsClient(
    config.feishu.appId,
    config.feishu.appSecret,
    createFeishuIngressOptions(config.feishu),
    whitelist,
    (message) => app.handleIncomingMessage(message),
    logger,
  );
  await ws.start();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
