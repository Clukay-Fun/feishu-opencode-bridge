/**
 * 职责: 维护本地新手引导状态文件。
 * 关注点:
 * - 将提示节流、workspace 初始化和 doctor 摘要收口到用户数据目录。
 * - 不参与运行时配置优先级，也不保存 Feishu 用户或 provider key 等敏感信息。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const ONBOARDING_STATE_SCHEMA_VERSION = 1;

export function resolveOnboardingStatePath(config, configPath) {
  const dataDir = asString(asRecord(config).storage?.dataDir) || "./data";
  const resolvedDataDir = path.isAbsolute(dataDir) ? dataDir : path.resolve(path.dirname(configPath), dataDir);
  return path.join(resolvedDataDir, "onboarding-state.json");
}

export async function readOnboardingState(statePath) {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8"));
    if (!parsed || parsed.schemaVersion !== ONBOARDING_STATE_SCHEMA_VERSION) {
      return createEmptyOnboardingState();
    }
    return parsed;
  } catch {
    return createEmptyOnboardingState();
  }
}

export async function writeOnboardingState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({
    schemaVersion: ONBOARDING_STATE_SCHEMA_VERSION,
    ...state,
  }, null, 2)}\n`, "utf8");
}

export async function updateOnboardingState(statePath, updater) {
  const current = await readOnboardingState(statePath);
  const next = updater(current);
  await writeOnboardingState(statePath, next);
  return next;
}

export async function markGuidePromptShown(statePath, now = new Date()) {
  return await updateOnboardingState(statePath, (state) => ({
    ...state,
    guideShownAt: now.toISOString(),
  }));
}

export async function markWorkspaceInitialized(statePath, now = new Date()) {
  return await updateOnboardingState(statePath, (state) => ({
    ...state,
    workspaceInitializedAt: now.toISOString(),
  }));
}

export async function recordWorkspaceDoctorResult(statePath, results, now = new Date()) {
  const failures = results.filter((result) => result.status === "fail");
  return await updateOnboardingState(statePath, (state) => ({
    ...state,
    lastWorkspaceDoctor: {
      checkedAt: now.toISOString(),
      status: failures.length > 0 ? "fail" : "pass",
      failedChecks: failures.map((result) => ({
        id: result.id,
        label: result.label,
        detail: result.detail,
      })),
    },
  }));
}

function createEmptyOnboardingState() {
  return {
    schemaVersion: ONBOARDING_STATE_SCHEMA_VERSION,
  };
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asString(value) {
  return typeof value === "string" ? value : "";
}
