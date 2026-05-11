/**
 * 职责: 覆盖司法文书 case_digest 入库能力。
 * 关注点:
 * - 验证司法文书识别、分段、原文回指和敏感材料拦截。
 * - 验证 KnowledgeBaseService 会把判决书写成 case_digest，而不是普通问答。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildKnowledgeQueryPayload } from "../src/feishu/knowledge-cards.js";
import { detectJudicialDocument, normalizeCaseDigestItems } from "../src/knowledge/extractors/case-digest.js";
import { KnowledgeBaseService } from "../src/knowledge/index.js";

const tempDirs: string[] = [];

describe("case digest judicial ingest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("detects supported judicial documents and extracts key sections", () => {
    const detection = detectJudicialDocument(judgmentFixture(), [{ location: "全文", text: judgmentFixture() }]);

    expect(detection.matched).toBe(true);
    expect(detection.kind).toBe("judgment");
    expect(detection.caseNumber).toBe("（2024）粤03民终1234号");
    expect(detection.level).toBe("二审");
    expect(detection.sections.reasoning).toContain("本院认为");
    expect(detection.sections.outcome).toContain("判决如下");
  });

  it("does not classify pleadings, contracts, courses, or disclaimers as judicial documents", () => {
    const negatives = [
      "民事起诉状\n原告请求判令被告支付货款。",
      "劳动合同\n甲方与乙方建立劳动关系。",
      "课程目录\n第一章 劳动争议处理流程。",
      "免责声明：本文仅供学习交流，不构成法律意见。",
    ];

    for (const text of negatives) {
      expect(detectJudicialDocument(text, [{ location: "全文", text }]).matched).toBe(false);
    }
  });

  it("rejects case digests whose reasoning is not an original substring", () => {
    const detection = detectJudicialDocument(judgmentFixture(), [{ location: "全文", text: judgmentFixture() }]);
    const items = normalizeCaseDigestItems({
      detection,
      sourceText: judgmentFixture(),
      rawItems: [{
        issue: "试用期约定是否合法",
        reasoning: "这是一段模型编造的法院说理。",
        rule: "试用期应当符合法定上限。",
        outcome: "维持原判。",
        statutes: ["《劳动合同法》第 19 条"],
        tags: ["劳动争议", "试用期"],
      }],
    });

    expect(items).toHaveLength(0);
  });

  it("ingests a judgment as case_digest and keeps metadata in fieldsJson", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-case-digest-"));
    tempDirs.push(dir);
    const filePath = join(dir, "二审判决书.txt");
    writeFileSync(filePath, judgmentFixture(), "utf8");
    const createdRecords: Array<{ tableId: string; fields: Record<string, unknown> }> = [];
    const requests: string[] = [];
    const service = new KnowledgeBaseService(
      createKnowledgeConfig(join(dir, "knowledge.db")),
      {
        async downloadMessageResource() {
          throw new Error("not used");
        },
        async createBitableRecord(_appToken, tableId, fields) {
          createdRecords.push({ tableId, fields });
          return `${tableId}_${createdRecords.length}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub(requests),
      logger(),
    );

    const result = await service.ingestLocalFile(filePath);
    const document = await service.getDocument(1);

    expect(result.extractedCount).toBe(1);
    expect(requests.some((prompt) => prompt.includes("司法文书要旨提取助手"))).toBe(true);
    expect(requests.some((prompt) => prompt.includes("法律知识提取专家"))).toBe(false);
    expect(document?.sampleEntries[0]?.entryType).toBe("case_digest");
    expect(document?.sampleEntries[0]?.dedupKey).toContain("case_digest:（2024）粤03民终1234号:");
    expect(document?.sampleEntries[0]?.fieldsJson).toContain("\"caseNumber\":\"（2024）粤03民终1234号\"");
    expect(document?.sampleEntries[0]?.fieldsJson).toContain("\"redactionApplied\":true");
    expect(createdRecords.at(-1)?.fields).toMatchObject({
      问题: "试用期约定是否合法",
      标签: ["劳动争议", "试用期"],
      "页码/章节": "（2024）粤03民终1234号 · 试用期约定是否合法",
    });
    service.close();
  });

  it("dedupes repeated caseNumber and issue by dedupKey", async () => {
    stubEmbeddingFetch();
    const dir = mkdtempSync(join(tmpdir(), "knowledge-case-digest-dedup-"));
    tempDirs.push(dir);
    const filePath = join(dir, "二审判决书.txt");
    writeFileSync(filePath, judgmentFixture(), "utf8");
    const service = new KnowledgeBaseService(
      createKnowledgeConfig(join(dir, "knowledge.db")),
      {
        async downloadMessageResource() {
          throw new Error("not used");
        },
        async createBitableRecord(_appToken, tableId) {
          return `${tableId}_${Date.now()}`;
        },
        async listBitableRecords() {
          return [];
        },
      },
      createOpenCodeStub([]),
      logger(),
    );

    const first = await service.ingestLocalFile(filePath);
    const second = await service.ingestLocalFile(filePath);

    expect(first.extractedCount).toBe(1);
    expect(second.extractedCount).toBe(0);
    service.close();
  });

  it("renders case_digest results in a separate case reference section", () => {
    const payload = buildKnowledgeQueryPayload({
      question: "试用期超过法定上限怎么办？",
      results: [{
        id: 1,
        documentId: 1,
        question: "试用期约定是否合法",
        answer: "裁判规则：试用期不得超过法定上限。\n\n裁判结果：维持原判。\n\n法院说理：本院认为，案涉劳动合同约定六个月试用期，未超过法律规定上限。",
        tags: ["劳动争议", "试用期"],
        statute: "《劳动合同法》第 19 条",
        sourceFile: "二审判决书.txt",
        pageSection: "（2024）粤03民终1234号 · 试用期约定是否合法",
        sourceUrl: "https://example.com/base/record",
        createdAt: Date.now(),
        entryType: "case_digest",
        fieldsJson: JSON.stringify({
          caseNumber: "（2024）粤03民终1234号",
          court: "广东省深圳市中级人民法院",
          judgmentDate: "二〇二四年五月十日",
          issue: "试用期约定是否合法",
          rule: "试用期不得超过法定上限。",
          outcome: "维持原判。",
        }),
        score: 0.99,
      }],
    });

    const serialized = JSON.stringify(JSON.parse(payload.content));
    expect(serialized).toContain("0 条答案");
    expect(serialized).toContain("1 条类案");
    expect(serialized).toContain("类案参考");
    expect(serialized).toContain("仅供说理思路参考，非法律依据");
    expect(serialized).not.toContain("答案 1");
  });
});

function judgmentFixture(): string {
  return [
    "广东省深圳市中级人民法院",
    "民事判决书",
    "（2024）粤03民终1234号",
    "案由：劳动争议",
    "上诉人某公司上诉请求：撤销一审判决。",
    "本院经审理查明，双方签订三年期限劳动合同，并约定六个月试用期。",
    "本院认为，案涉劳动合同约定六个月试用期，未超过法律规定上限。同一用人单位与同一劳动者只能约定一次试用期，双方未提交重复约定试用期的证据。故劳动者关于试用期违法的主张，本院不予支持。",
    "判决如下：驳回上诉，维持原判。",
    "二〇二四年五月十日",
    "书记员 张某",
  ].join("\n");
}

function createKnowledgeConfig(sqlitePath: string) {
  return {
    enabled: true,
    autoDetect: { enabled: true, minConfidence: 0.75 },
    query: { topK: 10, finalTopN: 3, keywordFallbackLimit: 10 },
    storage: {
      sqlitePath,
      bitable: {
        appToken: "app_token",
        tableId: "tbl_entries",
        documentTableId: "tbl_docs",
      },
    },
    embeddingProvider: {
      baseUrl: new URL("https://example.com/v1/"),
      apiKey: "token",
      model: "text-embedding",
    },
    models: {},
    ingest: {
      allowedExtensions: [".txt"],
      maxFileSizeMb: 20,
      pendingTtlMs: 600_000,
      sessionIdleMs: 1_800_000,
      concurrency: 3,
      maxExtractChunks: 30,
      maxExtractQas: 500,
    },
    judicialIngest: {
      enabled: true,
      batchEnabled: false,
      sources: ["manual" as const],
      batchSize: 20,
    },
  };
}

function createOpenCodeStub(requests: string[]) {
  return {
    async createSession(title: string) {
      return { id: `ses_${title}`, title };
    },
    async deleteSession() {
      return true;
    },
    async postMessageSync(_sessionId: string, request: { parts: Array<{ text?: string }> }) {
      const prompt = request.parts[0]?.text ?? "";
      requests.push(prompt);
      if (prompt.includes("司法文书要旨提取助手")) {
        return assistantMessage(JSON.stringify([{
          issue: "试用期约定是否合法",
          reasoning: "本院认为，案涉劳动合同约定六个月试用期，未超过法律规定上限。同一用人单位与同一劳动者只能约定一次试用期，双方未提交重复约定试用期的证据。故劳动者关于试用期违法的主张，本院不予支持。",
          rule: "试用期不得超过法定上限，且同一用人单位只能约定一次试用期。",
          outcome: "驳回上诉，维持原判。",
          statutes: ["《劳动合同法》第 19 条"],
          tags: ["劳动争议", "试用期"],
          weight: "reference",
        }]));
      }
      return assistantMessage(JSON.stringify([{ id: 1, score: 0.99 }]));
    },
  };
}

function assistantMessage(text: string) {
  return {
    info: {
      id: "msg_1",
      role: "assistant",
      sessionID: "ses_1",
      finish: "stop",
      time: { created: Date.now(), completed: Date.now() },
    },
    parts: [{ id: "part_1", type: "text", text }],
  };
}

function logger() {
  return {
    log() {},
    logTranscript() {},
  };
}

function stubEmbeddingFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    data: [{
      embedding: [0.1, 0.2, 0.3],
    }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch);
}
