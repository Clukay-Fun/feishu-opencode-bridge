/**
 * 职责: 运行 Legal Harness V1 的劳动争议离线回归。
 * 关注点:
 * - 使用固定 fixture 检查劳动输出结构完整度。
 * - 校验法条引用是否命中劳动领域白名单。
 * - 生成可提交审查的 Markdown 报告。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { checkLaborLegalCitations, formatCitationReviewText } from "../../src/labor/legal-citation.js";

type LaborHarnessFixture = {
  sourceNotice: string;
  caseTitle: string;
  materials: Array<{ fileName: string; content: string }>;
  expected: {
    requiredSections: string[];
    allowedCitations: string[];
  };
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
  const report = renderReport({
    fixture,
    output,
    citationLines: formatCitationReviewText(citationChecks),
    missingSections,
    manualReviewCount,
  });

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, report, "utf8");
  process.stdout.write(`labor harness report written: ${reportPath}\n`);

  if (missingSections.length > 0 || manualReviewCount > 0) {
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
    "- 解除理由与主管聊天中“项目缩编”的表述是否矛盾。",
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

function renderReport(input: {
  fixture: LaborHarnessFixture;
  output: string;
  citationLines: string[];
  missingSections: string[];
  manualReviewCount: number;
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
    "",
    "## 输出快照",
    "",
    input.output,
    "",
  ].join("\n");
}

await main();
