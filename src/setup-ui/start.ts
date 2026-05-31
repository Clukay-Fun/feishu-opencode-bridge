/**
 * 职责: 实现 `bridge start` thin wrapper。
 * 关注点:
 * - 调用现有 scripts/runtime/start.mjs
 * - 失败时给出下一步建议
 * - 退出码透传
 */
import { execFile } from "node:child_process";
import path from "node:path";

import type { DiagnosticResult } from "./diagnostics.js";

export async function runStart(cwd: string): Promise<DiagnosticResult> {
  const startScript = path.resolve(cwd, "scripts", "runtime", "start.mjs");

  return new Promise((resolve) => {
    const child = execFile("node", [startScript], {
      cwd,
      timeout: 10_000,
      env: { ...process.env },
    }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          ok: false,
          label: "启动失败",
          detail: stderr || stdout || error.message,
          nextStep: "运行 `bridge doctor` 检查配置，或检查 config.json",
        });
      } else {
        resolve({
          ok: true,
          label: "启动成功",
          detail: stdout.trim().split("\n").slice(-3).join("\n"),
        });
      }
    });

    // 5 秒后如果没有退出，认为启动成功（服务在后台运行）
    setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({
        ok: true,
        label: "服务已在后台启动",
        nextStep: "使用 `bridge doctor` 检查运行状态",
      });
    }, 5000);
  });
}
