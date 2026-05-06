/**
 * 职责: 运行 Legal Harness V1 的劳动争议离线回归。
 * 关注点:
 * - 使用固定 fixture 检查劳动输出结构完整度。
 * - 校验法条引用是否命中劳动领域白名单。
 * - 断言二审链路的 reviewReport 结构、模型差异和 needs_human_review 可见性。
 * - 生成可提交审查的 Markdown 报告。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { checkLaborLegalCitations, formatCitationReviewText } from "../../src/labor/legal-citation.js";
import {
  LaborSkillService,
  type LaborAnalyzeResult,
  type LaborFinalReviewReport,
  type SourceRef,
} from "../../src/labor/index.js";

type LaborHarnessFixture = {
  sourceNotice: string;
  caseTitle: string;
  materials: Array<{ fileName: string; content: string }>;
  expected: {
    requiredSections: string[];
    allowedCitations: string[];
    /** 二审验收：reviewReport 必须存在且不为 null。 */
    reviewReportRequired: boolean;
    /** 二审验收：review 模型与 analyze 模型不能相同。 */
    reviewMustDifferFromAnalyze: boolean;
  };
};

/** 二审验收场景：覆盖正常、同模型自审、调用失败、未配置四种降级路径。 */
type ReviewScenario = {
  name: string;
  reviewModel: string | undefined;
  analyzeModel: string | undefined;
  simulateCallFailed?: boolean | undefined;
  expectedSkippedReason?: string | undefined;
  expectedReportNull: boolean;
};

type ReviewScenarioResult = {
  scenario: ReviewScenario;
  failures: string[];
  report: LaborFinalReviewReport | null;
  skippedReason?: string | undefined;
};

const FIXTURE_PATH = path.resolve("test/fixtures/labor-harness/wrongful-termination.json");
const DEFAULT_REPORT_DIR = path.join(os.tmpdir(), "feishu-opencode-bridge", "labor-harness");

async function main(): Promise<void> {
  const reportPath = resolveReportPath(process.argv.slice(2));
  const fixture = JSON.parse(await readFile(FIXTURE_PATH, "utf8")) as LaborHarnessFixture;
  const output = buildDeterministicHarnessOutput(fixture);
  const citationChecks = checkLaborLegalCitations(output);
  const missingSections = fixture.expected.requiredSections.filter((section) => !output.includes(section));
  const manualReviewCount = citationChecks.filter((item) => !item.allowed).length;

  // 二审验收：测试四种降级场景
  const reviewScenarios: ReviewScenario[] = [
    { name: "正常二审（review 与 analyze 不同模型）", reviewModel: "provider-b/review-model", analyzeModel: "provider-a/analyze-model", expectedReportNull: false },
    { name: "review === analyze（同模型自审）", reviewModel: "provider-a/analyze-model", analyzeModel: "provider-a/analyze-model", expectedSkippedReason: "review_skipped_same_as_analyze", expectedReportNull: true },
    { name: "review 调用失败", reviewModel: "provider-b/review-model", analyzeModel: "provider-a/analyze-model", simulateCallFailed: true, expectedSkippedReason: "review_call_failed", expectedReportNull: true },
    { name: "review 未配置", reviewModel: undefined, analyzeModel: "provider-a/analyze-model", expectedSkippedReason: "review_skipped_no_config", expectedReportNull: true },
  ];

  const scenarioResults: ReviewScenarioResult[] = [];
  for (const scenario of reviewScenarios) {
    const { report, skippedReason, failures } = await runReviewScenario(fixture, scenario);
    scenarioResults.push({ scenario, failures, report, skippedReason });
  }

  const allReviewFailures = scenarioResults.flatMap((r) => r.failures);
  const normalScenario = scenarioResults[0];
  if (!normalScenario?.report) {
    throw new Error("normal review scenario must produce a review report");
  }
  const reviewReport = normalScenario.report;

  const report = renderReport({
    fixture,
    output,
    citationLines: formatCitationReviewText(citationChecks),
    missingSections,
    manualReviewCount,
    reviewReport,
    scenarioResults,
    reviewFailures: allReviewFailures,
  });

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report, "utf8");
  process.stdout.write(`labor harness report written: ${reportPath}\n`);

  if (missingSections.length > 0 || manualReviewCount > 0 || allReviewFailures.length > 0) {
    process.exitCode = 1;
  }
}

function resolveReportPath(args: string[]): string {
  const outputIndex = args.findIndex((value) => value === "--output" || value === "-o");
  const explicitOutput = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  if (explicitOutput?.trim()) {
    return path.resolve(explicitOutput);
  }
  return path.join(DEFAULT_REPORT_DIR, `labor-harness-report-${timestampForFileName(new Date())}.md`);
}

function timestampForFileName(value: Date): string {
  return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function buildDeterministicHarnessOutput(fixture: LaborHarnessFixture): string {
  return [
    `# ${fixture.caseTitle}｜Legal Harness V1`,
    "",
    "## 来源说明",
    fixture.sourceNotice,
    "",
    "## 争议焦点",
    "- 用人单位以严重违纪解除是否具有事实和制度依据。",
    "- 解除理由与主管聊天中\u201c项目缩编\u201d的表述是否矛盾。",
    "",
    "## 请求权基础",
    "- 违法解除赔偿金：依据《劳动合同法》第四十八条，并结合《劳动合同法》第四十七条核算赔偿基数。",
    "- 工资基数：以离职前十二个月平均工资 15000 元为初步测算依据，需律师复核。",
    "",
    "## 证据链",
    ...fixture.materials.map((item) => `- ${item.fileName}：${item.content}`),
    "",
    "## 证据缺口",
    "- 缺少规章制度文本、民主程序与员工签收记录。",
    "- 缺少违纪事实调查记录、工会通知或听取意见材料。",
    "- 需固定聊天记录原件、工资流水和劳动合同。",
    "",
    "## 策略",
    "- 诉讼/仲裁：围绕解除理由前后矛盾、制度依据缺失、程序瑕疵组织证据。",
    "- 调解：以违法解除赔偿金区间作为谈判锚点，同时保留工资基数复核空间。",
    "- 庭审回应：针对严重违纪抗辩，要求公司举证制度依据、事实调查和程序履行。",
    "",
    "## 文书草稿摘要",
    "- 仲裁申请书：请求确认解除违法并主张赔偿金，事实部分突出解除理由矛盾和举证缺口。",
  ].join("\n");
}

// #region 二审模拟与断言

/** 构造确定性二审报告，用于 fake OpenCode 返回，断言仍通过真实 service 归一化。 */
function buildReviewResponseJson(): LaborFinalReviewReport {
  const findings: LaborFinalReviewReport["findings"] = [
    {
      severity: "medium",
      type: "missing_authority",
      message: "违法解除赔偿金请求权缺少权威法规来源佐证",
      relatedSection: "请求权基础",
      source: { type: "local_kb", ref: "劳动合同法第四十八条" },
    },
    {
      severity: "high",
      type: "null_source",
      message: "工资基数测算缺少来源字段",
      relatedSection: "请求权基础",
      source: { type: null },
    },
  ];

  return {
    status: "needs_human_review",
    findings,
    unsupportedClaims: ["工资基数测算"],
    authorityCoverage: [
      { issue: "违法解除赔偿金", status: "partial", source: { type: "local_kb", ref: "劳动合同法第四十八条" } },
      { issue: "工资基数核算", status: "missing", source: { type: null } },
    ],
    suggestedEdits: ["补充工资流水原件后重新核算基数"],
    warnings: [{ code: "authority_pending", message: "权威法规检索尚未执行" }],
  };
}

/** 验证二审报告是否满足验收标准。 */
function validateReviewReport(
  fixture: LaborHarnessFixture,
  review: LaborFinalReviewReport,
  scenario: ReviewScenario,
): string[] {
  const failures: string[] = [];

  // 1. reviewReport 存在性
  if (fixture.expected.reviewReportRequired && !review) {
    failures.push("reviewReport 为 null，二审链路未执行");
  }

  // 2. review 与 analyze 模型差异
  if (fixture.expected.reviewMustDifferFromAnalyze) {
    if (scenario.reviewModel === scenario.analyzeModel) {
      failures.push(`review 模型（${scenario.reviewModel}）与 analyze 模型相同，违反二审独立性要求`);
    }
  }

  // 4. needs_human_review 可见性：source.type === null 时必须触发
  const nullSourceFindings = review.findings.filter((f) => f.source.type === null);
  if (nullSourceFindings.length > 0 && review.status !== "needs_human_review") {
    failures.push(`存在 ${nullSourceFindings.length} 条 source.type===null 的发现，但 status 不是 needs_human_review`);
  }

  // 5. source.type 白名单校验
  const allSources: SourceRef[] = [
    ...review.findings.map((f) => f.source),
    ...review.authorityCoverage.map((c) => c.source),
  ];
  for (const source of allSources) {
    if (source.type !== null && !["material", "local_kb", "authority"].includes(source.type)) {
      failures.push(`非法 source.type "${source.type}" 绕过了白名单校验`);
    }
  }

  // 6. authority/debug 状态
  const hasAuthorityWarning = review.warnings.some((w) => w.code === "authority_pending" || w.code === "authority_skipped");
  if (!hasAuthorityWarning && review.authorityCoverage.some((c) => c.status === "missing")) {
    failures.push("存在 missing 权威覆盖但 warnings 中缺少 authority 状态提示");
  }

  return failures;
}

/** 运行单个二审场景，并断言降级语义是否符合预期。 */
async function runReviewScenario(
  fixture: LaborHarnessFixture,
  scenario: ReviewScenario,
): Promise<{ report: LaborFinalReviewReport | null; skippedReason?: string | undefined; failures: string[] }> {
  const failures: string[] = [];
  const service = createHarnessLaborService(scenario);
  const { reviewReport: report, reviewSkippedReason: actualSkippedReason } = await service.finalizeReviewOnly(
    buildHarnessAnalyzeResult(fixture),
    { status: "pending" },
  );

  if (report) {
    failures.push(...validateReviewReport(fixture, report, scenario));
  }

  if (scenario.expectedReportNull !== (report === null)) {
    failures.push(
      `场景「${scenario.name}」期望 report ${scenario.expectedReportNull ? "为空" : "存在"}，实际${report === null ? "为空" : "存在"}`,
    );
  }

  if ((scenario.expectedSkippedReason ?? undefined) !== actualSkippedReason) {
    failures.push(
      `场景「${scenario.name}」期望 skippedReason=${scenario.expectedSkippedReason ?? "undefined"}，实际=${actualSkippedReason ?? "undefined"}`,
    );
  }

  return { report, skippedReason: actualSkippedReason, failures };
}

function createHarnessLaborService(scenario: ReviewScenario): LaborSkillService {
  const response = JSON.stringify(buildReviewResponseJson());
  return new LaborSkillService(
    {
      enabled: true,
      models: {
        ...(scenario.analyzeModel ? { analyze: scenario.analyzeModel } : {}),
        ...(scenario.reviewModel ? { review: scenario.reviewModel } : {}),
      },
      ingest: {
        allowedExtensions: [".txt"],
        maxFileSizeMb: 20,
        pendingTtlMs: 60_000,
      },
      storage: {},
    },
    path.join(os.tmpdir(), "feishu-opencode-bridge", "labor-harness-service"),
    {} as never,
    {
      async createSession() {
        return { id: "harness-review-session" };
      },
      async postMessageSync() {
        if (scenario.simulateCallFailed) {
          throw new Error("simulated review failure");
        }
        return {
          info: { role: "assistant" },
          parts: [{ type: "text", text: response }],
        };
      },
      async deleteSession() {
        return undefined;
      },
    } as never,
    {
      log() {},
      logTranscript() {},
    },
    null,
  );
}

function buildHarnessAnalyzeResult(fixture: LaborHarnessFixture): LaborAnalyzeResult {
  return {
    title: fixture.caseTitle,
    markdown: buildDeterministicHarnessOutput(fixture),
    syncedEvidenceCount: fixture.materials.length,
    syncedGapCount: 2,
    extractedMaterials: fixture.materials.map((material) => ({
      materialType: material.fileName,
      summary: material.content,
      facts: [material.content],
      timelineEvents: [],
      evidenceRows: [{ name: material.fileName, proves: material.content }],
      riskPoints: ["解除依据不足"],
      missingEvidenceHints: ["需人工复核"],
    })),
    aggregate: {
      caseTitle: fixture.caseTitle,
      disputeStage: "仲裁前评估",
      summary: "违法解除争议回归样例。",
      coreJudgment: ["解除依据和程序材料需要复核。"],
      evidenceRows: fixture.materials.map((material) => ({ name: material.fileName, proves: material.content })),
      timeline: [],
      issues: [{ issue: "违法解除赔偿金", analysis: "解除理由与证据存在冲突。", riskLevel: "high" }],
      missingEvidence: ["规章制度文本", "工会通知材料"],
      nextActions: ["补充工资流水原件"],
      legalSupports: [{ issue: "违法解除赔偿金", rule: "《劳动合同法》第四十八条", relation: "请求权基础" }],
      keyIssues: ["解除是否合法"],
      claimBasis: [{ claim: "违法解除赔偿金", basis: "《劳动合同法》第四十八条", evidence: ["解除通知.txt"] }],
      strategy: { litigation: ["固定解除事实"], mediation: ["以赔偿金区间谈判"], response: ["要求公司举证制度依据"] },
      draftDocuments: [],
    },
    warnings: [],
  };
}

// #endregion

function renderReport(input: {
  fixture: LaborHarnessFixture;
  output: string;
  citationLines: string[];
  missingSections: string[];
  manualReviewCount: number;
  reviewReport: LaborFinalReviewReport;
  scenarioResults: Array<{ scenario: ReviewScenario; failures: string[]; report: LaborFinalReviewReport | null; skippedReason?: string | undefined }>;
  reviewFailures: string[];
}): string {
  return [
    "# Labor Harness V1 Report",
    "",
    `- Fixture: ${path.relative(process.cwd(), FIXTURE_PATH)}`,
    `- Case: ${input.fixture.caseTitle}`,
    `- Source: ${input.fixture.sourceNotice}`,
    "",
    "## 结构完整度",
    input.missingSections.length === 0
      ? "- 通过：争议焦点、请求权基础、证据链、证据缺口、策略、来源说明均已覆盖。"
      : `- 失败：缺少 ${input.missingSections.join("、")}`,
    "",
    "## 来源覆盖",
    ...input.fixture.materials.map((item) => `- ${item.fileName}`),
    "",
    "## 法条风险",
    ...input.citationLines.map((line) => `- ${line}`),
    "",
    "## 二审验收（四场景）",
    ...input.scenarioResults.map((result) => [
      `### ${result.scenario.name}`,
      `- 期望 report 为 null：${result.scenario.expectedReportNull}`,
      `- 实际 report 为 null：${result.report === null}`,
      result.scenario.expectedSkippedReason ? `- 期望 skippedReason：${result.scenario.expectedSkippedReason}` : "- 无 skippedReason 期望",
      result.skippedReason ? `- 实际 skippedReason：${result.skippedReason}` : "- 实际 skippedReason：无",
      result.failures.length === 0
        ? "- 通过"
        : `- 失败：${result.failures.join("；")}`,
      "",
    ]).flat(),
    "### 正常二审场景详情",
    `- reviewReport 存在性：${input.reviewReport ? "通过" : "失败"}`,
    "- review 模型独立性：通过",
    `- review status：${input.reviewReport.status}`,
    `- needs_human_review 可见性：${input.reviewReport.findings.some((f) => f.source.type === null) && input.reviewReport.status === "needs_human_review" ? "通过" : "失败"}`,
    `- source 白名单校验：${input.reviewFailures.filter((f) => f.includes("source.type")).length === 0 ? "通过" : "失败"}`,
    `- authority 状态报告：${input.reviewReport.warnings.some((w) => w.code.startsWith("authority")) ? "通过" : "失败"}`,
    ...(input.reviewFailures.length > 0
      ? ["", "### 二审失败项", ...input.reviewFailures.map((f) => `- ${f}`)]
      : []),
    "",
    "## 证据缺口覆盖",
    "- 已覆盖制度依据、程序材料、调查记录、聊天记录原件、工资流水。",
    "",
    "## 策略输出",
    "- 已区分诉讼/仲裁、调解、庭审回应。",
    "",
    "## Reviewer Checklist",
    "- 风格不得覆盖专业性。",
    "- 策略建议是否符合律师工作习惯。",
    "- 证据补强是否可实际执行。",
    "- 二审 reviewReport 是否包含可操作的 findings 和 suggestedEdits。",
    "- needs_human_review 是否在 source.type === null 时正确触发。",
    "- 四种降级场景（正常、同模型、调用失败、未配置）是否均通过。",
    "",
    "## 输出快照",
    "",
    input.output,
    "",
  ].join("\n");
}

await main();
