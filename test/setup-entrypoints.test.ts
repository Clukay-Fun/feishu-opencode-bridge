import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..");

describe("setup entrypoints", () => {
  it("macOS setup resolves a concrete node path after Homebrew install", async () => {
    const script = await readFile(path.join(repoRoot, "setup.command"), "utf8");

    expect(script).toContain("brew install node@20");
    expect(script).toContain("brew --prefix node@20");
    expect(script).toContain("NODE_DIR=\"$(dirname \"$NODE_BIN\")\"");
    expect(script).toContain("export PATH=\"$NODE_DIR:$PATH\"");
    expect(script).toContain("\"$NODE_BIN\" scripts/runtime/onboard.mjs");
  });

  it("Windows setup resolves a concrete node path after winget install", async () => {
    const script = await readFile(path.join(repoRoot, "setup.bat"), "utf8");

    expect(script).toContain("winget install OpenJS.NodeJS.LTS");
    expect(script).toContain("%ProgramFiles%\\nodejs\\node.exe");
    expect(script).toContain("%LocalAppData%\\Programs\\nodejs\\node.exe");
    expect(script).toContain("set \"PATH=%NODE_DIR%;%PATH%\"");
    expect(script).toContain("\"%NODE_EXE%\" scripts\\runtime\\onboard.mjs");
  });
});
