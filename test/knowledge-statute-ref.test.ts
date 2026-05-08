/**
 * 职责: 覆盖知识库法条引用解析的固定语法样本。
 * 关注点:
 * - 验证中文数字、裸法名和多条引用顺序。
 * - 保护 exact article 检索入口的解析前置条件。
 */
import { describe, expect, it } from "vitest";

import { parseStatuteReferences } from "../src/knowledge/statute-ref.js";

describe("parseStatuteReferences", () => {
  it("parses book-title and bare law references with normalized article numbers", () => {
    expect(parseStatuteReferences("《劳动合同法》第十九条如何适用？")).toEqual([
      expect.objectContaining({ lawName: "劳动合同法", articleNumber: 19 }),
    ]);
    expect(parseStatuteReferences("商标法第57条有哪些侵权行为？")).toEqual([
      expect.objectContaining({ lawName: "商标法", articleNumber: 57 }),
    ]);
  });

  it("keeps multiple references in query order and inherits nearby law names", () => {
    const refs = parseStatuteReferences("劳动合同法第19条和第83条怎么理解？");

    expect(refs).toEqual([
      expect.objectContaining({ lawName: "劳动合同法", articleNumber: 19 }),
      expect.objectContaining({ lawName: "劳动合同法", articleNumber: 83 }),
    ]);
  });

  it("allows article-only references when no law name is available", () => {
    expect(parseStatuteReferences("第十九条具体怎么规定？")).toEqual([
      expect.objectContaining({ lawName: undefined, articleNumber: 19 }),
    ]);
  });
});
