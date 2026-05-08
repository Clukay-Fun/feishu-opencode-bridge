/**
 * 职责: 提供知识库召回质量的最小固定回归 harness。
 * 关注点:
 * - 使用 per-fixture entries 隔离失败样本。
 * - 通过预计算 embedding 避免 CI 访问外部模型服务。
 * - 输出 recall@3 / recall@10 / MRR，作为后续 rerank 与切分优化基线。
 * - fixture 扩到 10 条以上时切换共享 corpus 模式，避免重复复制样本。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KnowledgeBaseService } from "../src/knowledge/index.js";

type HarnessEntry = {
  key: string;
  question: string;
  answer: string;
  tags: string[];
  statute?: string | undefined;
  embedding: number[];
};

type HarnessFixture = {
  id: string;
  query: string;
  queryEmbedding: number[];
  entries: HarnessEntry[];
  expectedEntryKeys: string[];
  minRecallAt3: number;
  minRecallAt10: number;
  tags: string[];
};

const tempDirs: string[] = [];

describe("kb recall harness", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("meets the starter legal recall baseline without external embedding calls", async () => {
    const reports = [];
    for (const fixture of STARTER_FIXTURES) {
      stubQueryEmbedding(fixture.queryEmbedding);
      const dir = mkdtempSync(join(tmpdir(), `kb-harness-${fixture.id}-`));
      tempDirs.push(dir);
      const service = createHarnessService(dir, fixture);
      await service.syncMirror();
      const result = await service.query(fixture.query);
      const actualKeys = result.results.map((entry) => entry.sourceFile.replace(/\.md$/u, ""));
      const report = scoreFixture(fixture, actualKeys);
      reports.push(report);
      service.close();

      expect(report.recallAt3, `${fixture.id} recall@3`).toBeGreaterThanOrEqual(fixture.minRecallAt3);
      expect(report.recallAt10, `${fixture.id} recall@10`).toBeGreaterThanOrEqual(fixture.minRecallAt10);
    }

    console.info(JSON.stringify({ suite: "kb-recall", reports }, null, 2));
  });
});

function createHarnessService(dir: string, fixture: HarnessFixture): KnowledgeBaseService {
  return new KnowledgeBaseService(
    {
      enabled: true,
      autoDetect: { enabled: false, minConfidence: 0.75 },
      query: { topK: 10, finalTopN: 10, keywordFallbackLimit: 10 },
      storage: {
        sqlitePath: join(dir, "knowledge.db"),
        bitable: {
          appToken: "app_token",
          tableId: "tbl_entries",
          documentTableId: undefined,
        },
      },
      embeddingProvider: {
        baseUrl: new URL("https://example.com/v1/"),
        apiKey: "token",
        model: "fixture-embedding",
      },
      models: {},
      ingest: {
        allowedExtensions: [".md"],
        maxFileSizeMb: 20,
        pendingTtlMs: 600_000,
        sessionIdleMs: 1_800_000,
        concurrency: 3,
        maxExtractChunks: 30,
        maxExtractQas: 500,
      },
    },
    {
      async downloadMessageResource() {
        throw new Error("not used");
      },
      async createBitableRecord() {
        throw new Error("not used");
      },
      async listBitableRecords() {
        return fixture.entries.map((entry) => ({
          recordId: `rec_${entry.key}`,
          fields: {
            问题: entry.question,
            答案: entry.answer,
            标签: entry.tags,
            法条: entry.statute ?? "",
            源文件: `${entry.key}.md`,
            embedding: JSON.stringify(entry.embedding),
          },
        }));
      },
    },
    createHarnessOpenCode(),
    { log() {}, logTranscript() {} },
  );
}

function createHarnessOpenCode() {
  return {
    async createSession(title: string) {
      return { id: title, title };
    },
    async deleteSession() {
      return true;
    },
    async postMessageSync() {
      return {
        info: {
          id: "msg_1",
          role: "assistant",
          sessionID: "ses_1",
          finish: "stop",
          time: { created: Date.now(), completed: Date.now() },
        },
        parts: [{ id: "part_1", type: "text", text: JSON.stringify([1, 2, 3, 4, 5].map((id) => ({ id, score: 1 - id / 10 }))) }],
      };
    },
  };
}

function stubQueryEmbedding(embedding: number[]): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    data: [{ embedding }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch);
}

function scoreFixture(fixture: HarnessFixture, actualKeys: string[]) {
  const expected = new Set(fixture.expectedEntryKeys);
  const hitAt3 = actualKeys.slice(0, 3).filter((key) => expected.has(key)).length;
  const hitAt10 = actualKeys.slice(0, 10).filter((key) => expected.has(key)).length;
  const firstHitIndex = actualKeys.findIndex((key) => expected.has(key));
  return {
    id: fixture.id,
    query: fixture.query,
    tags: fixture.tags,
    expected: fixture.expectedEntryKeys,
    actual: actualKeys,
    recallAt3: hitAt3 / expected.size,
    recallAt10: hitAt10 / expected.size,
    mrr: firstHitIndex >= 0 ? 1 / (firstHitIndex + 1) : 0,
  };
}

const STARTER_FIXTURES: HarnessFixture[] = [
  {
    id: "kb-recall-001",
    query: "劳动合同法第十九条",
    queryEmbedding: [0, 1, 0, 0, 0],
    expectedEntryKeys: ["labor-probation"],
    minRecallAt3: 1,
    minRecallAt10: 1,
    tags: ["劳动", "试用期"],
    entries: [
      {
        key: "labor-probation",
        question: "劳动合同试用期最长可以约定多久？",
        answer: "《劳动合同法》第十九条规定，试用期期限应当与劳动合同期限匹配。",
        tags: ["劳动"],
        statute: "《劳动合同法》第 19 条",
        embedding: [1, 0, 0, 0, 0],
      },
      unrelatedEntry("company-resolution", [0, 1, 0, 0, 0]),
    ],
  },
  {
    id: "kb-recall-002",
    query: "违法解除劳动合同赔偿金怎么计算",
    queryEmbedding: [0, 1, 0, 0, 0],
    expectedEntryKeys: ["labor-illegal-termination"],
    minRecallAt3: 1,
    minRecallAt10: 1,
    tags: ["劳动", "解除"],
    entries: [
      {
        key: "labor-illegal-termination",
        question: "违法解除劳动合同赔偿金怎么计算？",
        answer: "赔偿金通常按照经济补偿标准的二倍计算，并结合工作年限和月工资口径确定。",
        tags: ["劳动", "赔偿金"],
        statute: "《劳动合同法》第 87 条",
        embedding: [0, 1, 0, 0, 0],
      },
      unrelatedEntry("trademark-infringement", [0, 0, 1, 0, 0]),
    ],
  },
  {
    id: "kb-recall-003",
    query: "迟延付款可以主张哪些违约责任",
    queryEmbedding: [0, 0, 1, 0, 0],
    expectedEntryKeys: ["contract-delay-payment"],
    minRecallAt3: 1,
    minRecallAt10: 1,
    tags: ["合同", "违约"],
    entries: [
      {
        key: "contract-delay-payment",
        question: "合同一方迟延付款时守约方可以主张哪些违约责任？",
        answer: "守约方可以主张继续履行、违约金、损失赔偿；合同目的不能实现时还可评估解除权。",
        tags: ["合同纠纷"],
        statute: "《民法典》第 577 条",
        embedding: [0, 0, 1, 0, 0],
      },
      unrelatedEntry("data-compliance", [0, 0, 0, 1, 0]),
    ],
  },
  {
    id: "kb-recall-004",
    query: "商标法第57条",
    queryEmbedding: [0, 0, 0, 1, 0],
    expectedEntryKeys: ["trademark-article-57"],
    minRecallAt3: 1,
    minRecallAt10: 1,
    tags: ["知识产权", "商标"],
    entries: [
      {
        key: "trademark-article-57",
        question: "未经许可使用他人注册商标会有哪些侵权风险？",
        answer: "《商标法》第五十七条列明了多类商标侵权行为，可能承担停止侵害和赔偿责任。",
        tags: ["知识产权"],
        statute: "《商标法》第 57 条",
        embedding: [0, 0, 0, 1, 0],
      },
      unrelatedEntry("labor-overtime", [1, 0, 0, 0, 0]),
    ],
  },
  {
    id: "kb-recall-005",
    query: "平台收集个人信息应注意哪些合规要求",
    queryEmbedding: [0, 0, 0, 0, 1],
    expectedEntryKeys: ["data-personal-info"],
    minRecallAt3: 1,
    minRecallAt10: 1,
    tags: ["数据合规"],
    entries: [
      {
        key: "data-personal-info",
        question: "平台收集个人信息应当重点关注哪些合规要求？",
        answer: "平台应遵循合法、正当、必要和诚信原则，明示处理规则，取得相应同意，并落实安全保护义务。",
        tags: ["数据合规"],
        statute: "《个人信息保护法》",
        embedding: [0, 0, 0, 0, 1],
      },
      unrelatedEntry("contract-delay-payment", [0, 0, 1, 0, 0]),
    ],
  },
];

function unrelatedEntry(key: string, embedding: number[]): HarnessEntry {
  return {
    key,
    question: "无关法律问题如何处理？",
    answer: "这是用于召回 harness 的无关干扰项。",
    tags: ["干扰项"],
    embedding,
  };
}
