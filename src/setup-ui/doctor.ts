/**
 * 职责: 实现 `bridge doctor` 诊断命令。
 * 关注点:
 * - 5 项检查：config / feishu / opencode / dataDir / port
 * - 失败时输出下一步建议
 * - secret 不输出
 */
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { loadConfig } from "../config/loader.js";
import type { DiagnosticResult } from "./diagnostics.js";

export async function runDoctor(configPath: string): Promise<DiagnosticResult[]> {
  const results: DiagnosticResult[] = [];

  // 1. 配置文件存在 + schema 校验
  try {
    const config = await loadConfig(configPath);
    results.push({ ok: true, label: "配置文件校验通过" });

    // 2. Feishu App ID / Secret 已配置
    const hasAppId = Boolean(config.feishu?.appId?.trim());
    const hasSecret = Boolean(config.feishu?.appSecret?.trim());
    if (hasAppId && hasSecret) {
      results.push({ ok: true, label: "飞书 App 凭据已配置" });
    } else {
      results.push({
        ok: false,
        label: "飞书 App 凭据未完整配置",
        detail: `AppID: ${hasAppId ? "已填" : "未填"}, Secret: ${hasSecret ? "已填" : "未填"}`,
        nextStep: "运行 `bridge setup` 重新配置，或手动编辑 config.json 的 feishu.appId / feishu.appSecret",
      });
    }

    // 3. OpenCode 可连接
    try {
      const baseUrl = config.opencode?.baseUrl ?? "http://127.0.0.1:4096/";
      const baseUrlStr = typeof baseUrl === "string" ? baseUrl : baseUrl.toString();
      const healthUrl = new URL("health", baseUrlStr.endsWith("/") ? baseUrlStr : `${baseUrlStr}/`).toString();
      const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        results.push({ ok: true, label: "OpenCode 服务可连接" });
      } else {
        results.push({
          ok: false,
          label: "OpenCode 服务不可用",
          detail: `HTTP ${resp.status}`,
          nextStep: "运行 `opencode serve` 启动 OpenCode，或检查 config.json 的 opencode.baseUrl",
        });
      }
    } catch {
      results.push({
        ok: false,
        label: "OpenCode 服务不可连接",
        nextStep: "运行 `opencode serve` 启动 OpenCode，或检查 config.json 的 opencode.baseUrl",
      });
    }

    // 4. 数据目录可写
    const dataDir = path.resolve(config.storage?.dataDir ?? "./data");
    try {
      await fs.mkdir(dataDir, { recursive: true });
      const testFile = path.join(dataDir, ".write-test");
      await fs.writeFile(testFile, "test", "utf-8");
      await fs.unlink(testFile);
      results.push({ ok: true, label: `数据目录可写: ${dataDir}` });
    } catch {
      results.push({
        ok: false,
        label: `数据目录不可写: ${dataDir}`,
        nextStep: "检查目录权限，或在 config.json 修改 storage.dataDir",
      });
    }

    // 5. HTTP 端口未被占用
    const port = config.server?.port ?? 3000;
    const host = config.server?.host ?? "127.0.0.1";
    const portOk = await checkPortAvailable(host, port);
    if (portOk) {
      results.push({ ok: true, label: `端口 ${port} 可用` });
    } else {
      results.push({
        ok: false,
        label: `端口 ${port} 已被占用`,
        nextStep: `释放端口 ${port}，或在 config.json 修改 server.port`,
      });
    }
  } catch (error) {
    results.push({
      ok: false,
      label: "配置文件校验失败",
      detail: error instanceof Error ? error.message : String(error),
      nextStep: "运行 `bridge setup` 重新生成配置，或检查 config.json 语法",
    });
  }

  return results;
}

function checkPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}
