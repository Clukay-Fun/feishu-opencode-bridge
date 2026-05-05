/**
 * 职责: 覆盖知识库意图检测逻辑。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { describe, expect, it } from "vitest";

import { detectKnowledgeMaterialIngestIntent, detectKnowledgeWebIngest, detectLegalQuestion } from "../src/knowledge/detector.js";

describe("detectLegalQuestion", () => {
  it("matches high-signal legal questions conservatively", () => {
    const result = detectLegalQuestion("劳动合同试用期最长多久？");
    expect(result.matched).toBe(true);
    expect(result.confidence).toBe(0.75);
    expect(result.reasons).not.toContain("high-signal-topic");
  });

  it("matches non-labor legal questions across broader practice areas", () => {
    const questions = [
      "股东会决议程序违法可以撤销吗？",
      "注册商标被别人使用怎么主张侵权？",
      "行政处罚决定不服可以如何救济？",
      "平台收集个人信息是否涉及数据合规风险？",
    ];

    for (const question of questions) {
      const result = detectLegalQuestion(question);
      expect(result.matched, question).toBe(true);
      expect(result.confidence, question).toBeGreaterThanOrEqual(0.5);
    }
  });

  it("does not match unrelated casual messages", () => {
    const result = detectLegalQuestion("今天帮我总结一下周报");
    expect(result.matched).toBe(false);
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe("detectKnowledgeWebIngest", () => {
  it("matches URL ingest requests", () => {
    const result = detectKnowledgeWebIngest("读取 https://example.com/law 这个网页并入库");
    expect(result.matched).toBe(true);
    expect(result.url).toBe("https://example.com/law");
    expect(result.reasons).toEqual(["url", "ingest-intent"]);
  });

  it("does not match ordinary URL questions", () => {
    const result = detectKnowledgeWebIngest("帮我看看 https://example.com/law 这个链接有没有法律风险？");
    expect(result.matched).toBe(false);
    expect(result.url).toBe("https://example.com/law");
  });

  it("matches plain URLs inside ingest mode when explicit intent is not required", () => {
    const result = detectKnowledgeWebIngest("https://example.com/law", { requireIngestIntent: false });
    expect(result.matched).toBe(true);
    expect(result.url).toBe("https://example.com/law");
  });
});

describe("detectKnowledgeMaterialIngestIntent", () => {
  it("matches natural language requests to ingest recent materials", () => {
    const samples = [
      "把刚才上传的三本书收入知识库",
      "这些文件整理到知识库",
      "上面的材料写入知识库",
      "入库",
    ];

    for (const sample of samples) {
      const result = detectKnowledgeMaterialIngestIntent(sample);
      expect(result.matched, sample).toBe(true);
      expect(result.confidence, sample).toBeGreaterThanOrEqual(0.7);
    }
  });

  it("keeps summaries and negative instructions out of ingest routing", () => {
    const samples = [
      "帮我总结一下刚才的文件",
      "先不要入库，看看这是什么材料",
      "这些文件不要写入知识库",
    ];

    for (const sample of samples) {
      const result = detectKnowledgeMaterialIngestIntent(sample);
      expect(result.matched, sample).toBe(false);
    }
  });
});
