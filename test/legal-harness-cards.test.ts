/**
 * 职责: 覆盖 Legal Harness V1 业务卡片的渲染与数据校验。
 * 关注点:
 * - 断言每张卡片的稳定 ID、核心状态字段、关键 CTA 和统计块。
 * - 不依赖飞书 API，仅校验模板渲染与 schema 校验。
 */
import { describe, expect, it } from "vitest";

import {
  HARNESS_AUTHORITY_COVERAGE_TEMPLATE_ID,
  HARNESS_FINDINGS_TEMPLATE_ID,
  HARNESS_RESULT_GROUP_TEMPLATE_ID,
  HARNESS_REVIEW_REPORT_TEMPLATE_ID,
  HARNESS_SEARCH_CONFIRM_TEMPLATE_ID,
  harnessAuthorityCoverageTemplate,
  harnessFindingsTemplate,
  harnessResultGroupTemplate,
  harnessReviewReportTemplate,
  harnessSearchConfirmTemplate,
} from "../src/labor/harness-card-templates.js";
import {
  buildHarnessAuthorityCoveragePayload,
  buildHarnessFindingsPayload,
  buildHarnessResultGroupPayload,
  buildHarnessReviewReportPayload,
  buildHarnessSearchConfirmPayload,
} from "../src/feishu/harness-cards.js";

describe("harness reviewReport card", () => {
  const view = {
    title: "违法解除劳动合同案件",
    status: "needs_revision" as const,
    findingCount: 5,
    highCount: 2,
    mediumCount: 2,
    lowCount: 1,
    unsupportedClaimCount: 1,
    warningCount: 0,
    suggestedEditCount: 3,
  };

  it("has stable template ID", () => {
    expect(harnessReviewReportTemplate.id).toBe(HARNESS_REVIEW_REPORT_TEMPLATE_ID);
    expect(HARNESS_REVIEW_REPORT_TEMPLATE_ID).toBe("harness.review-report");
  });

  it("renders card payload with status fields", () => {
    const payload = buildHarnessReviewReportPayload(view);
    expect(payload.msg_type).toBe("interactive");
    const content = JSON.parse(payload.content);
    expect(content.header.title.content).toBe("二审报告");
    expect(content.header.template).toBe("yellow");
  });

  it("schema accepts valid input", () => {
    const result = harnessReviewReportTemplate.schema.safeParse(view);
    expect(result.success).toBe(true);
  });

  it("schema rejects invalid status", () => {
    const result = harnessReviewReportTemplate.schema.safeParse({ ...view, status: "invalid" });
    expect(result.success).toBe(false);
  });
});

describe("harness authorityCoverage card", () => {
  const view = {
    title: "工资差额争议案件",
    items: [
      { issue: "未支付加班费", status: "sufficient" as const, sourceType: "authority", sourceRef: "《工资支付暂行规定》" },
      { issue: "社保缴纳不足", status: "partial" as const, sourceType: "local_kb" },
      { issue: "年休假未休", status: "missing" as const },
      { issue: "高温津贴", status: "skipped" as const },
    ],
    sufficientCount: 1,
    partialCount: 1,
    missingCount: 1,
    skippedCount: 1,
  };

  it("has stable template ID", () => {
    expect(harnessAuthorityCoverageTemplate.id).toBe(HARNESS_AUTHORITY_COVERAGE_TEMPLATE_ID);
    expect(HARNESS_AUTHORITY_COVERAGE_TEMPLATE_ID).toBe("harness.authority-coverage");
  });

  it("renders card payload with coverage stats", () => {
    const payload = buildHarnessAuthorityCoveragePayload(view);
    expect(payload.msg_type).toBe("interactive");
    const content = JSON.parse(payload.content);
    expect(content.header.title.content).toBe("权威检索覆盖率");
  });

  it("renders skipped-only coverage without NaN", () => {
    const payload = buildHarnessAuthorityCoveragePayload({
      title: "跳过权威检索案件",
      items: [{ issue: "违法解除", status: "skipped" as const }],
      sufficientCount: 0,
      partialCount: 0,
      missingCount: 0,
      skippedCount: 1,
    });

    expect(JSON.stringify(JSON.parse(payload.content))).toContain("覆盖率 0%");
    expect(JSON.stringify(JSON.parse(payload.content))).not.toContain("NaN");
  });

  it("schema accepts valid authority status values", () => {
    const result = harnessAuthorityCoverageTemplate.schema.safeParse(view);
    expect(result.success).toBe(true);
  });

  it("schema rejects invalid authority status", () => {
    const result = harnessAuthorityCoverageTemplate.schema.safeParse({
      ...view,
      items: [{ issue: "test", status: "invalid" as never }],
    });
    expect(result.success).toBe(false);
  });
});

describe("harness findings card", () => {
  const view = {
    title: "劳动合同解除争议",
    findings: [
      { severity: "high" as const, type: "证据缺口", message: "缺少工资流水原件", relatedSection: "证据链总表" },
      { severity: "medium" as const, type: "时效风险", message: "仲裁时效临近" },
      { severity: "low" as const, type: "格式瑕疵", message: "部分文件未盖章" },
    ],
  };

  it("has stable template ID", () => {
    expect(harnessFindingsTemplate.id).toBe(HARNESS_FINDINGS_TEMPLATE_ID);
    expect(HARNESS_FINDINGS_TEMPLATE_ID).toBe("harness.findings");
  });

  it("renders card payload with findings count", () => {
    const payload = buildHarnessFindingsPayload(view);
    expect(payload.msg_type).toBe("interactive");
    const content = JSON.parse(payload.content);
    expect(content.header.title.content).toBe("问题发现列表");
    expect(content.header.template).toBe("red");
  });

  it("schema accepts valid severity values", () => {
    const result = harnessFindingsTemplate.schema.safeParse(view);
    expect(result.success).toBe(true);
  });

  it("schema rejects invalid severity", () => {
    const result = harnessFindingsTemplate.schema.safeParse({
      ...view,
      findings: [{ severity: "critical" as never, type: "x", message: "y" }],
    });
    expect(result.success).toBe(false);
  });
});

describe("harness searchConfirm card", () => {
  const view = {
    conversationKey: "chat-123-abc",
    nonce: "nonce-456",
    mainQuery: "劳动争议 违法解除 赔偿金",
    alternatives: ["劳动争议 加班费 仲裁", "劳动争议 社保 补缴"],
    reason: "根据劳动分析报告中的争议焦点生成",
  };

  it("has stable template ID", () => {
    expect(harnessSearchConfirmTemplate.id).toBe(HARNESS_SEARCH_CONFIRM_TEMPLATE_ID);
    expect(HARNESS_SEARCH_CONFIRM_TEMPLATE_ID).toBe("harness.search-confirm");
  });

  it("renders interactive card payload with CTA buttons", () => {
    const payload = buildHarnessSearchConfirmPayload(view);
    expect(payload.msg_type).toBe("interactive");
    const content = JSON.parse(payload.content);
    expect(content.header.title.content).toBe("确认检索词");
    expect(content.header.template).toBe("indigo");
    const bodyElements = content.body.elements;
    const buttonColumn = bodyElements.find((el: Record<string, unknown>) => el.tag === "column_set");
    expect(buttonColumn).toBeDefined();
    const columns = buttonColumn?.columns as Array<Record<string, unknown>>;
    expect(columns?.length).toBeGreaterThanOrEqual(1);
  });

  it("schema accepts valid search confirm input", () => {
    const result = harnessSearchConfirmTemplate.schema.safeParse(view);
    expect(result.success).toBe(true);
  });

  it("schema accepts empty alternatives", () => {
    const result = harnessSearchConfirmTemplate.schema.safeParse({ ...view, alternatives: [] });
    expect(result.success).toBe(true);
  });
});

describe("harness resultGroup card", () => {
  const view = {
    title: "劳动争议证据链分析",
    groups: [
      { label: "高风险事项", riskLevel: "high" as const, count: 3, items: ["违法解除", "加班费", "社保"] },
      { label: "中风险事项", riskLevel: "medium" as const, count: 2, items: ["未休年假", "高温津贴"] },
      { label: "参考信息", riskLevel: "info" as const, count: 1, items: ["公司制度"] },
    ],
    totalCount: 6,
  };

  it("has stable template ID", () => {
    expect(harnessResultGroupTemplate.id).toBe(HARNESS_RESULT_GROUP_TEMPLATE_ID);
    expect(HARNESS_RESULT_GROUP_TEMPLATE_ID).toBe("harness.result-group");
  });

  it("renders card payload with group stats", () => {
    const payload = buildHarnessResultGroupPayload(view);
    expect(payload.msg_type).toBe("interactive");
    const content = JSON.parse(payload.content);
    expect(content.header.title.content).toBe("结果分组");
    expect(content.header.template).toBe("blue");
  });

  it("schema accepts valid group input", () => {
    const result = harnessResultGroupTemplate.schema.safeParse(view);
    expect(result.success).toBe(true);
  });

  it("schema rejects invalid riskLevel in group", () => {
    const result = harnessResultGroupTemplate.schema.safeParse({
      ...view,
      groups: [{ label: "test", riskLevel: "critical" as never, count: 1, items: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("schema accepts empty groups", () => {
    const result = harnessResultGroupTemplate.schema.safeParse({ title: "test", groups: [], totalCount: 0 });
    expect(result.success).toBe(true);
  });
});
