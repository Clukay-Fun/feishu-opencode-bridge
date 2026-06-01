/**
 * 职责: 实现 `bridge start` thin wrapper。
 * 关注点:
 * - 调用现有 scripts/runtime/start.mjs
 * - 失败时给出下一步建议
 * - 退出码透传
 */
import { spawn } from "node:child_process";
import path from "node:path";

import type { DiagnosticResult } from "./diagnostics.js";

export async function runStart(cwd: string): Promise<DiagnosticResult> {
  const startScript = path.resolve(cwd, "scripts", "runtime", "start.mjs");

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [startScript], {
      cwd,
      env: { ...process.env },
      stdio: "inherit",
      shell: false,
    });

    child.once("error", (error) => {
      resolve({
        ok: false,
        label: "启动失败",
        detail: error.message,
        nextStep: "运行 `bridge doctor` 检查配置，或检查 config.json",
      });
    });

    child.once("close", (code) => {
      if (code && code !== 0) {
        resolve({
          ok: false,
          label: "启动失败",
          detail: `启动脚本退出码：${code}`,
          nextStep: "运行 `bridge doctor` 检查配置，或检查 config.json",
        });
      } else {
        resolve({
          ok: true,
          label: "启动已结束",
          detail: "Bridge 进程已退出",
        });
      }
    });
  });
}
