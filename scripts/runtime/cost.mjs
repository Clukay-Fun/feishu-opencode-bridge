/**
 * 职责: 提供 portable CLI 的本地 AI 成本摘要命令。
 * 关注点:
 * - 只读取/清理本地 usage ledger，不访问 provider 账单。
 * - 输出今日、本月和最近记录，帮助用户理解估算成本。
 */
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { createPortableEnv, resolveBridgeHome } from "./portable.mjs";
import { isMainModule } from "./checks.mjs";

const LEDGER_FILE = "usage-ledger.jsonl";

export async function runCostCli(args = process.argv.slice(2), options = {}) {
  const logger = options.logger ?? console;
  const env = createPortableEnv({
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    platform: options.platform,
    home: options.home,
  });
  const bridgeHome = resolveBridgeHome({ env, platform: options.platform, home: options.home });
  const ledgerPath = options.ledgerPath ?? path.join(bridgeHome, "data", LEDGER_FILE);

  if (args.includes("--reset-local")) {
    await rm(ledgerPath, { force: true });
    logger.log(`已清理本地成本 ledger：${ledgerPath}`);
    logger.log("这不会影响 AI provider 的真实账单。");
    return 0;
  }

  const entries = await readEntries(ledgerPath);
  const now = new Date();
  const today = summarize(entries.filter((entry) => entry.createdAt.startsWith(now.toISOString().slice(0, 10))));
  const month = summarize(entries.filter((entry) => entry.createdAt.startsWith(now.toISOString().slice(0, 7))));
  const payload = {
    ledgerPath,
    today,
    month,
    recent: entries.slice(-5).reverse(),
  };
  if (args.includes("--json")) {
    logger.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  logger.log("AI 成本摘要（本地估算）");
  logger.log(`ledger: ${ledgerPath}`);
  logger.log(`今日: ${today.totalTokens} tokens${formatCost(today.estimatedCostCny)}，外部调用 ${today.externalCalls} 次`);
  logger.log(`本月: ${month.totalTokens} tokens${formatCost(month.estimatedCostCny)}，外部调用 ${month.externalCalls} 次`);
  if (payload.recent.length === 0) {
    logger.log("最近记录: 暂无");
  } else {
    logger.log("最近记录:");
    for (const entry of payload.recent) {
      const sourceLabel = entry.source === "external-call"
        ? `${entry.tool ?? entry.model}/${entry.operation ?? "call"}`
        : (entry.source === "provider" ? "provider usage" : "估算");
      logger.log(`- ${entry.createdAt} ${entry.provider}/${entry.model} ${entry.totalTokens} tokens${formatCost(entry.estimatedCostCny)} ${sourceLabel}`);
    }
  }
  logger.log("提示: 金额只代表 bridge 本地估算，真实账单以 provider 为准。");
  return 0;
}

async function readEntries(ledgerPath) {
  let raw = "";
  try {
    raw = await readFile(ledgerPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return raw.split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed?.schemaVersion === 1 ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function summarize(entries) {
  const totalTokens = entries.reduce((sum, entry) => sum + Number(entry.totalTokens ?? 0), 0);
  const externalCalls = entries.filter((entry) => entry.source === "external-call").length;
  const costs = entries.map((entry) => entry.estimatedCostCny).filter((value) => typeof value === "number");
  return {
    totalTokens,
    externalCalls,
    ...(costs.length > 0 ? { estimatedCostCny: Math.round(costs.reduce((sum, value) => sum + value, 0) * 10_000) / 10_000 } : {}),
  };
}

function formatCost(value) {
  return typeof value === "number" ? ` ≈¥${value.toFixed(4)}` : "（未配置价格）";
}

if (isMainModule(import.meta.url)) {
  try {
    process.exitCode = await runCostCli();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
