import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "../config/schema.js";
import { OpenCodeClient } from "../opencode/client.js";

type FeishuPreflightPort = {
  getTenantToken(): Promise<string>;
};

type ReportFn = (line: string) => void;

export async function runStartupPreflight(
  config: AppConfig,
  feishu: FeishuPreflightPort,
  report: ReportFn = console.log,
): Promise<void> {
  const opencode = new OpenCodeClient(config.opencode.baseUrl);

  await runCheck("数据目录", report, async () => {
    await ensureWritable(config.storage.dataDir);
    await ensureWritable(config.logging.dir);
  });

  await runCheck("飞书鉴权", report, async () => {
    await feishu.getTenantToken();
  });

  await runCheck("OpenCode 健康检查", report, async () => {
    await opencode.health();
  });

  await runCheck("OpenCode 工作目录", report, async () => {
    const project = await opencode.getCurrentProject();
    if (project.worktree !== config.opencode.directory) {
      throw new Error(`opencode serve 当前在 ${project.worktree}，bridge 配置的是 ${config.opencode.directory}`);
    }
  });

  await runCheck("模型提供方", report, async () => {
    const providers = await opencode.listProviders();
    if (!Array.isArray(providers.providers)) {
      throw new Error("provider 列表不可用");
    }
  });

  if (config.feishu.cardActions.enabled) {
    await runCheck("卡片回调配置", report, async () => {
      if (!config.feishu.cardActions.verificationToken) {
        throw new Error("缺少 feishu.cardActions.verificationToken");
      }
      if (!config.feishu.cardActions.encryptKey) {
        throw new Error("缺少 feishu.cardActions.encryptKey");
      }
      if (!config.feishu.cardActions.path) {
        throw new Error("缺少 feishu.cardActions.path");
      }
      if (!config.server.publicBaseUrl) {
        throw new Error("缺少 server.publicBaseUrl");
      }
    });
  }
}

async function runCheck(name: string, report: ReportFn, fn: () => Promise<void>): Promise<void> {
  report(`正在检查 ${name}`);
  try {
    await fn();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`启动检查失败：${name} · ${detail}`);
  }
  report(`已通过 ${name}`);
}

async function ensureWritable(target: string): Promise<void> {
  const dir = path.extname(target) ? path.dirname(target) : target;
  await access(dir, constants.R_OK | constants.W_OK);
}
