import { createLogger } from "./logging/logger.js";
import { loadConfig } from "./config/loader.js";
import { BridgeApp } from "./runtime/app.js";
import { FeishuApiClient } from "./feishu/api.js";
import { FeishuWsClient } from "./feishu/ws.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const logger = await createLogger(config.logging.dir);
  const outbound = new FeishuApiClient(config.feishu.appId, config.feishu.appSecret);
  const app = new BridgeApp(config, outbound, logger);
  await app.start();
  const ws = new FeishuWsClient(config.feishu.appId, config.feishu.appSecret, (message) => app.handleIncomingMessage(message), logger);
  await ws.start();
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
