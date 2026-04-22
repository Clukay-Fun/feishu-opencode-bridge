/**
 * 职责: 从 package.json 解析应用版本号。
 * 关注点:
 * - 自当前目录向上查找 package.json。
 * - 在缺失或解析失败时返回安全默认值。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 自起始目录向上查找本项目的 package.json。 */
function findPackageJsonPath(startDir: string): string | null {
  let currentDir = startDir;

  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(currentDir, "package.json");
    try {
      const raw = readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown };
      if (parsed.name === "feishu-opencode-bridge") {
        return candidate;
      }
    } catch {
      // Keep searching upward.
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

/** 读取 package.json 中的 version 字段。 */
function loadAppVersion(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = findPackageJsonPath(currentDir);

  if (!packageJsonPath) {
    return "0.0.0";
  }

  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.trim()) {
      return parsed.version;
    }
  } catch {
    // Fall through to the safe default below.
  }

  return "0.0.0";
}

export const APP_VERSION = loadAppVersion();
