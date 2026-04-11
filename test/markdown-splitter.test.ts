import { describe, expect, it } from "vitest";

import { splitMarkdownBlocks } from "../src/feishu/markdown-splitter.js";

describe("splitMarkdownBlocks", () => {
  it("splits markdown into semantic blocks without breaking lists, tables, or code fences", () => {
    const markdown = [
      "### 标题",
      "",
      "第一段正文",
      "第二行正文",
      "",
      "- 列表项 1",
      "- 列表项 2",
      "",
      "| 名称 | 值 |",
      "| --- | --- |",
      "| a | b |",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      "最后一段",
    ].join("\n");

    expect(splitMarkdownBlocks(markdown)).toEqual([
      "### 标题",
      "第一段正文\n第二行正文",
      "- 列表项 1\n- 列表项 2",
      "| 名称 | 值 |\n| --- | --- |\n| a | b |",
      "```ts\nconst value = 1;\n```",
      "最后一段",
    ]);
  });

  it("merges overflow blocks from the limit boundary without splitting code blocks", () => {
    const sourceBlocks = Array.from({ length: 35 }, (_, index) => {
      const blockNumber = index + 1;
      if (blockNumber >= 28 && blockNumber <= 32) {
        return ["```text", `code block ${blockNumber}`, "```"].join("\n");
      }
      return `段落 ${blockNumber}`;
    });

    const blocks = splitMarkdownBlocks(sourceBlocks.join("\n\n"), 30);

    expect(blocks).toHaveLength(30);
    expect(blocks.slice(0, 29)).toEqual(sourceBlocks.slice(0, 29));
    expect(blocks[29]).toBe(sourceBlocks.slice(29).join("\n\n"));
  });
});
