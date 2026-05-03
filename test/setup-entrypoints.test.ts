/**
 * 职责: 覆盖脚本入口和包命令配置。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");

describe("setup entrypoints", () => {
  it("macOS setup command forwards to the portable bridge onboarding entrypoint", async () => {
    const script = await readFile(path.join(repoRoot, "setup.command"), "utf8");

    expect(script).toContain("兼容旧版 macOS 双击安装入口");
    expect(script).toContain("exec \"$ROOT/bridge\" onboard");
    expect(script).not.toContain("brew install");
  });

  it("Windows setup batch forwards to the portable bridge onboarding entrypoint", async () => {
    const script = await readFile(path.join(repoRoot, "setup.bat"), "utf8");

    expect(script).toContain("兼容旧版 Windows 双击安装入口");
    expect(script).toContain("bridge.cmd\" onboard");
    expect(script).not.toContain("winget install");
  });

  it("macOS start command forwards to the portable bridge start entrypoint", async () => {
    const script = await readFile(path.join(repoRoot, "start.command"), "utf8");

    expect(script).toContain("兼容旧版 macOS 双击启动入口");
    expect(script).toContain("BRIDGE_CONFIG_PATH");
    expect(script).toContain("exec \"$ROOT/bridge\" start");
    expect(script).not.toContain("scripts/runtime/start.mjs");
  });

  it("Windows start batch forwards to the portable bridge start entrypoint", async () => {
    const script = await readFile(path.join(repoRoot, "start.bat"), "utf8");

    expect(script).toContain("兼容旧版 Windows 双击启动入口");
    expect(script).toContain("BRIDGE_CONFIG_PATH");
    expect(script).toContain("bridge.cmd\" start");
    expect(script).not.toContain("scripts\\runtime\\start.mjs");
  });

  it("portable macOS entrypoint downloads Node and dispatches through bootstrap", async () => {
    const script = await readFile(path.join(repoRoot, "bridge"), "utf8");

    expect(script).toContain("scripts/runtime/install-node.sh");
    expect(script).toContain("BRIDGE_HOME");
    expect(script).toContain("BRIDGE_PRESERVE_XDG");
    expect(script).toContain("scripts/runtime/bootstrap.mjs");
  });

  it("portable Windows entrypoint downloads Node and dispatches through bootstrap", async () => {
    const script = await readFile(path.join(repoRoot, "bridge.cmd"), "utf8");

    expect(script).toContain("scripts\\runtime\\install-node.ps1");
    expect(script).toContain("BRIDGE_HOME");
    expect(script).toContain("scripts\\runtime\\bootstrap.mjs");
  });
});
