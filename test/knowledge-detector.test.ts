import { describe, expect, it } from "vitest";

import { detectKnowledgeWebIngest, detectLegalQuestion } from "../src/knowledge/detector.js";

describe("detectLegalQuestion", () => {
  it("matches high-signal legal questions conservatively", () => {
    const result = detectLegalQuestion("员工试用期最长多久？");
    expect(result.matched).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.75);
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
