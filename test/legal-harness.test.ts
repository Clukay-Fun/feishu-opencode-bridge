/**
 * 职责: 覆盖 Legal Harness V1 的离线校验辅助能力。
 * 关注点:
 * - 法条引用白名单同时支持阿拉伯数字与中文数字。
 * - Obsidian 笔记导出省略未配置的 Bitable URL 并生成双链。
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { checkLaborLegalCitations } from "../src/labor/legal-citation.js";
import { buildKnowledgeObsidianMarkdown, exportKnowledgeObsidianNote } from "../src/knowledge/obsidian-export.js";
import {
  buildKnowledgeSearchStrategyDraft,
  confirmKnowledgeSearchStrategy,
} from "../src/knowledge/search-strategy.js";
import { LaborSkillService, type LaborAnalyzeResult } from "../src/labor/index.js";

describe("legal harness helpers", () => {
  it("marks labor law citations outside the whitelist for manual review", () => {
    const checks = checkLaborLegalCitations("依据《劳动合同法》第四十八条和《民法典》第五百条处理。");

    expect(checks).toEqual([
      expect.objectContaining({ citation: "《劳动合同法》第四十八条", allowed: true, article: "48" }),
      expect.objectContaining({ citation: "《民法典》第五百条", allowed: false, note: "需人工复核" }),
    ]);
  });

  it("supports Arabic article numbers in citation checks", () => {
    expect(checkLaborLegalCitations("参考《劳动合同法》第47条。")[0]).toEqual(expect.objectContaining({
      citation: "《劳动合同法》第47条",
      allowed: true,
      article: "47",
    }));
  });

  it("builds Obsidian markdown with frontmatter and wiki links", () => {
    const markdown = buildKnowledgeObsidianMarkdown({ enableWikiLinks: true }, {
      sourceType: "local-file",
      fileName: "违法解除 FAQ.md",
      checksum: "sha256-demo",
      tags: ["违法解除", "劳动合同"],
      entries: [{
        question: "违法解除如何主张？",
        answer: "可围绕解除依据、程序和赔偿金组织。",
        tags: ["违法解除"],
        statute: "《劳动合同法》第四十八条",
        pageSection: "第 1 节",
      }],
      sqliteDocumentId: 12,
    });

    expect(markdown).toContain("sqliteDocumentId: 12");
    expect(markdown).not.toContain("bitableUrl");
    expect(markdown).toContain("[[劳动争议]]");
    expect(markdown).toContain("[[违法解除劳动合同]]");
    expect(markdown).toContain("[[劳动合同法第四十八条]]");
  });

  it("exports Obsidian notes with document id and checksum to avoid same-name overwrite", async () => {
    const vaultPath = await mkdtemp(path.join(os.tmpdir(), "knowledge-obsidian-"));
    const baseInput = {
      sourceType: "local-file",
      fileName: "劳动争议 FAQ.md",
      domain: "劳动争议",
      tags: ["劳动合同"],
      entries: [{
        question: "试用期多久？",
        answer: "最长不超过六个月。",
        tags: ["劳动合同"],
      }],
    };

    const first = await exportKnowledgeObsidianNote({
      enabled: true,
      vaultPath,
      baseDir: "Knowledge",
      enableWikiLinks: true,
    }, {
      ...baseInput,
      checksum: "sha256-first",
      sqliteDocumentId: 1,
    });
    const second = await exportKnowledgeObsidianNote({
      enabled: true,
      vaultPath,
      baseDir: "Knowledge",
      enableWikiLinks: true,
    }, {
      ...baseInput,
      checksum: "sha256-second",
      sqliteDocumentId: 2,
    });

    expect(first).toContain("劳动争议 FAQ.md-1-sha256-first.md");
    expect(second).toContain("劳动争议 FAQ.md-2-sha256-secon.md");
    expect(first).not.toBe(second);
  });

  it("builds and confirms a lawyer-visible search strategy draft", () => {
    const draft = buildKnowledgeSearchStrategyDraft({
      question: "员工被辞退后主张违法解除赔偿金，劳动仲裁如何准备？",
      pkulawEnabled: true,
    });

    expect(draft.status).toBe("pending-confirmation");
    expect(draft.sources).toEqual(["local-knowledge", "pkulaw"]);
    expect(draft.terms.flatMap((item) => item.terms)).toContain("违法解除劳动合同");

    const confirmed = confirmKnowledgeSearchStrategy(draft, ["违法解除劳动合同", "解除理由 举证责任"]);

    expect(confirmed).toEqual(expect.objectContaining({
      status: "confirmed",
      terms: ["违法解除劳动合同", "解除理由 举证责任"],
      sources: ["local-knowledge", "pkulaw"],
    }));
    expect(confirmed.answerBoundaries.join("\n")).toContain("人工复核");
  });

  it("downgrades search strategy to local knowledge when pkulaw is unavailable", () => {
    const draft = buildKnowledgeSearchStrategyDraft({
      question: "工资拖欠和加班费证据怎么整理？",
      pkulawEnabled: false,
    });

    expect(draft.sources).toEqual(["local-knowledge"]);
    expect(draft.reviewNote).toContain("本地知识库");
  });

  it("forces final review to human review when normalized sources are null", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "labor-review-null-source-"));
    const service = new LaborSkillService(
      {
        enabled: true,
        models: {
          analyze: "openai/analyze-model",
          review: "openai/review-model",
        },
        ingest: {
          allowedExtensions: [".txt"],
          maxFileSizeMb: 20,
          pendingTtlMs: 60_000,
        },
        storage: {},
      },
      dataDir,
      {} as never,
      {
        async createSession() {
          return { id: "review-session" };
        },
        async postMessageSync() {
          return {
            info: { role: "assistant" },
            parts: [{ type: "text", text: JSON.stringify({
              status: "pass",
              findings: [{ severity: "high", type: "missing_source", message: "缺少来源", source: { type: "unknown", ref: "demo" } }],
              unsupportedClaims: [],
              authorityCoverage: [],
              suggestedEdits: [],
              warnings: [],
            }) }],
          };
        },
        deleteSession: vi.fn(async () => true),
      },
      { log: vi.fn() } as never,
      null,
    );

    const outcome = await service.finalizeReviewOnly(createLaborAnalyzeResult(), { status: "pending" });

    expect(outcome.reviewReport).toEqual(expect.objectContaining({
      status: "needs_human_review",
      findings: [expect.objectContaining({ source: { type: null, ref: "demo" } })],
    }));
  });

});

function createLaborAnalyzeResult(): LaborAnalyzeResult {
  return {
    title: "劳动争议分析",
    markdown: "### 劳动争议分析",
    syncedEvidenceCount: 0,
    syncedGapCount: 0,
    extractedMaterials: [],
    warnings: [],
    aggregate: {
      caseTitle: "劳动争议分析",
      disputeStage: "劳动仲裁",
      summary: "案件需要二审。",
      coreJudgment: ["解除依据需要复核。"],
      evidenceRows: [{ name: "解除通知", proves: "证明解除事实" }],
      timeline: [{ date: "2026-01-01", event: "收到解除通知" }],
      issues: [{ issue: "违法解除", analysis: "需结合证据判断", riskLevel: "中" }],
      missingEvidence: [],
      nextActions: [],
      legalSupports: [{ issue: "违法解除", rule: "劳动合同法第四十七条", relation: "支持赔偿计算" }],
      keyIssues: ["解除是否合法"],
      claimBasis: [{ claim: "赔偿金", basis: "劳动合同法第四十七条", evidence: ["解除通知"] }],
      strategy: { litigation: [], mediation: [], response: [] },
      draftDocuments: [],
    },
  };
}
