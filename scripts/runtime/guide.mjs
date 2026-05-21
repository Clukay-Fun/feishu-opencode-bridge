/**
 * 职责: 根据本地配置与引导状态输出新手下一步。
 * 关注点:
 * - 串联 onboard、workspace 初始化、doctor、start 和飞书 `/help`。
 * - 只读取本地状态，不触达飞书远端资源。
 */
import os from "node:os";

import { isMainModule, readProjectConfig } from "./checks.mjs";
import { resolveProjectConfigPath } from "./portable.mjs";
import { readOnboardingState, resolveOnboardingStatePath } from "./onboarding-state.mjs";

export async function runGuide(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const configPath = options.configPath ?? resolveProjectConfigPath(cwd, env);

  const result = await buildGuideView({ cwd, env, configPath });
  renderGuide(result, logger);
  return result.status === "blocked" ? 1 : 0;
}

export async function buildGuideView(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? resolveProjectConfigPath(cwd, env);
  const configState = await readProjectConfig(cwd, configPath);

  if (!configState.exists) {
    return {
      status: "blocked",
      title: "还没有生成配置",
      detail: `未找到 config.json：${configPath}`,
      nextSteps: ["bridge onboard"],
      heroSteps: [],
      fixes: ["如果是 release 包，请先运行 ./bridge onboard 或 bridge.cmd onboard。"],
    };
  }

  if (configState.error || !configState.config) {
    return {
      status: "blocked",
      title: "配置文件无法读取",
      detail: configState.error?.message ?? `无法解析 config.json：${configPath}`,
      nextSteps: ["修复 config.json 后重新运行 bridge guide"],
      heroSteps: [],
      fixes: ["需要重新生成配置时运行 bridge onboard，并按提示确认覆盖。"],
    };
  }

  const statePath = resolveOnboardingStatePath(configState.config, configPath);
  const state = await readOnboardingState(statePath);
  const workspace = readWorkspaceConfig(configState.config);
  if (!workspace.ready) {
    return {
      status: "needs-workspace",
      title: "下一步：初始化飞书 Base 工作区",
      detail: "当前配置缺少合同、发票、案件或知识库表 ID。",
      nextSteps: ["bridge init workspace", "bridge doctor workspace", "bridge start"],
      heroSteps: buildHeroSteps(),
      fixes: ["已有旧工作区且确认要切换时，运行 bridge init workspace --force。"],
      statePath,
      state,
    };
  }

  if (state.lastWorkspaceDoctor?.status === "fail") {
    return {
      status: "needs-fix",
      title: "下一步：修复 workspace doctor 报告的问题",
      detail: summarizeDoctorFailures(state.lastWorkspaceDoctor),
      nextSteps: ["bridge doctor workspace"],
      heroSteps: buildHeroSteps(),
      fixes: ["修复权限或字段结构后，再运行 bridge doctor workspace 确认。"],
      statePath,
      state,
    };
  }

  if (!state.lastWorkspaceDoctor) {
    return {
      status: "needs-doctor",
      title: "下一步：诊断飞书 Base 工作区",
      detail: "工作区配置已存在，但还没有本地 doctor 摘要。",
      nextSteps: ["bridge doctor workspace", "bridge start"],
      heroSteps: buildHeroSteps(),
      fixes: ["doctor 只诊断不改资源，可以放心运行。"],
      statePath,
      state,
    };
  }

  return {
    status: "ready",
    title: "环境已就绪",
    detail: "可以启动 Bridge，并回到飞书发送 /help 查看指令总览。",
    nextSteps: ["bridge start", "在飞书里发送 /help"],
    heroSteps: buildHeroSteps(),
    fixes: ["如果飞书无响应，运行 bridge doctor workspace 和 bridge doctor 查看环境状态。"],
    statePath,
    state,
  };
}

function renderGuide(view, logger) {
  logger.log("Feishu OpenCode Bridge — 新手引导");
  logger.log("");
  logger.log(`状态：${view.title}`);
  logger.log(`说明：${view.detail}`);
  logger.log("");
  logger.log("下一步：");
  for (const step of view.nextSteps) {
    logger.log(`  - ${step}`);
  }
  if (view.heroSteps.length > 0) {
    logger.log("");
    logger.log("Hero 路线：");
    for (const step of view.heroSteps) {
      logger.log(`  - ${step}`);
    }
  }
  if (view.fixes.length > 0) {
    logger.log("");
    logger.log("自救提示：");
    for (const fix of view.fixes) {
      logger.log(`  - ${fix}`);
    }
  }
  logger.log("");
  logger.log("数据流向：真实案件使用前请阅读 docs/privacy-and-data-flow.md；敏感案件建议使用本地或私有模型 provider。");
  if (view.statePath) {
    logger.log("");
    logger.log(`本地引导状态：${view.statePath}`);
  }
}

function buildHeroSteps() {
  return [
    "上传样例材料：使用 examples/hero/ 或 test/fixtures/labor-harness/wrongful-termination.json 中的违法解除素材。",
    "启动劳动分析：在飞书发送 /劳动分析，补充材料后发送 /劳动分析结束。",
    "查看输出：权威法规检索与二审会在后台完成，重点看争议焦点、请求权基础、证据缺口、策略与文书草稿摘要。",
    "核对二审状态：完成卡会显示法条引用独立校验、建议修改或需人工复核状态。",
    "查看回归：本地运行 npm run labor:harness，按终端输出路径打开报告。",
  ];
}

function summarizeDoctorFailures(lastWorkspaceDoctor) {
  const failures = Array.isArray(lastWorkspaceDoctor.failedChecks) ? lastWorkspaceDoctor.failedChecks : [];
  if (failures.length === 0) {
    return "最近一次 workspace doctor 未通过。";
  }
  return failures.slice(0, 3).map((failure) => `${failure.label}: ${failure.detail}`).join("；");
}

function readWorkspaceConfig(config) {
  const extensions = asRecord(config.extensions);
  const contract = asRecord(extensions["contract-assistant"] ?? config.contractAssistant);
  const contractStorage = asRecord(contract.storage);
  const knowledge = asRecord(extensions["knowledge-base"] ?? config.knowledgeBase);
  const knowledgeStorage = asRecord(asRecord(knowledge.storage).bitable);
  const ready = Boolean(
    asString(contractStorage.baseToken)
      && asString(contractStorage.contractTableId)
      && asString(contractStorage.invoiceTableId)
      && asString(contractStorage.caseTableId)
      && asString(knowledgeStorage.tableId),
  );
  return { ready };
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runGuide({ home: os.homedir() });
}
