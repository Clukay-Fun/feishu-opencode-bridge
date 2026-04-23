/**
 * 职责: 在架构关键缝合点变更时提醒同步更新架构基线文档。
 * 关注点:
 * - 比较当前分支改动与 seam 文件集合。
 * - 在 CI 或本地给出轻量警告，而不是直接阻断提交。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SEAM_FILES = new Set([
  "src/bridge/module.ts",
  "src/bridge/router.ts",
  "src/runtime/app.ts",
  "src/runtime/feishu-transport.ts",
  "src/runtime/runtime-modules.ts",
  "src/runtime/turn-executor.ts",
  "src/feishu/formatter.ts",
]);

const ARCHITECTURE_BASELINE = "docs/architecture-baseline.md";

// Warn when seam files changed but the architecture baseline document did not.
async function main(): Promise<void> {
  const changedFiles = await getChangedFiles();
  if (changedFiles.length === 0) {
    return;
  }

  const touchedSeams = changedFiles.filter((file) => SEAM_FILES.has(file));
  if (touchedSeams.length === 0 || changedFiles.includes(ARCHITECTURE_BASELINE)) {
    return;
  }

  const message = [
    `Seam files changed without ${ARCHITECTURE_BASELINE}.`,
    `Touched seams: ${touchedSeams.join(", ")}`,
    "If the seam contract changed, update the architecture baseline in the same PR. If this is a behavior-preserving internal edit, note that in the PR.",
  ].join(" ");

  if (process.env.GITHUB_ACTIONS === "true") {
    console.log(`::warning title=Architecture baseline not updated::${escapeGithubAnnotation(message)}`);
  } else {
    console.warn(`WARNING: ${message}`);
  }
}

// Resolve changed files from BASE_SHA, merge-base, or local staged/unstaged diffs.
async function getChangedFiles(): Promise<string[]> {
  const base = process.env.BASE_SHA?.trim();
  if (base) {
    const files = await gitDiffNames([`${base}...HEAD`]);
    if (files.length > 0) {
      return files;
    }
  }

  const mainBase = await getMergeBase("HEAD", "origin/main");
  if (mainBase) {
    const files = await gitDiffNames([`${mainBase}...HEAD`]);
    if (files.length > 0) {
      return files;
    }
  }

  return unique([
    ...(await gitDiffNames(["--cached"])),
    ...(await gitDiffNames([])),
  ]);
}

// Compute a merge-base when comparing the current branch against `origin/main`.
async function getMergeBase(left: string, right: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["merge-base", left, right]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

// Return changed filenames from `git diff --name-only`.
async function gitDiffNames(args: string[]): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", ...args]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// Escape annotation text for the GitHub Actions workflow command format.
function escapeGithubAnnotation(value: string): string {
  return value
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

// Deduplicate file paths while keeping first-seen order.
function unique(values: string[]): string[] {
  return [...new Set(values)];
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
