import { describe, expect, it, vi } from "vitest";

vi.mock("mammoth", () => ({
  extractRawText: vi.fn(async () => ({ value: "第一段内容\n\n第二段内容" })),
}));

vi.mock("../src/utils/python-tool.js", () => ({
  spawnPythonTool: vi.fn(),
}));

vi.mock("pdf-parse", () => ({
  PDFParse: class {
    async getText() {
      return {
        pages: [
          { num: 1, text: "第一页内容" },
          { num: 2, text: "第二页内容" },
        ],
        text: "第一页内容\n第二页内容",
        total: 2,
      };
    }

    async destroy() {}
  },
}));

import { chunkKnowledgeSections, groupKnowledgeSectionsByChapter, parseKnowledgeFile } from "../src/knowledge/parser.js";
import { spawnPythonTool } from "../src/utils/python-tool.js";

describe("parseKnowledgeFile", () => {
  it("parses txt sections", async () => {
    const parsed = await parseKnowledgeFile("demo.txt", Buffer.from("第一段\n\n第二段", "utf8"));
    expect(parsed.normalizedMarkdown).toBe("第一段\n\n第二段");
    expect(parsed.sections).toEqual([
      { location: "文本 1", text: "第一段" },
      { location: "文本 2", text: "第二段" },
    ]);
  });

  it("falls back to gb18030 for mojibake txt content", async () => {
    const parsed = await parseKnowledgeFile("demo.txt", Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]));
    expect(parsed.sections).toEqual([
      { location: "文本 1", text: "中文" },
    ]);
  });

  it("parses docx sections via mammoth", async () => {
    vi.mocked(spawnPythonTool).mockResolvedValueOnce({
      ok: false,
      error: "python unavailable",
    });
    const parsed = await parseKnowledgeFile("demo.docx", Buffer.from("fake"));
    expect(parsed.sections.map((item) => item.location)).toEqual(["段落 1", "段落 2"]);
    expect(parsed.parserUsed).toBe("mammoth");
  });

  it("parses pdf pages via pdf-parse", async () => {
    vi.mocked(spawnPythonTool).mockResolvedValueOnce({
      ok: false,
      error: "python unavailable",
    });
    const parsed = await parseKnowledgeFile("demo.pdf", Buffer.from("fake"));
    expect(parsed.normalizedMarkdown).toBe("第一页内容\n\n---\n\n第二页内容");
    expect(parsed.parserUsed).toBe("pdf-parse");
    expect(parsed.sections).toEqual([
      { location: "第 1 页", text: "第一页内容" },
      { location: "第 2 页", text: "第二页内容" },
    ]);
  });

  it("prefers python markdown output for pdf files when available", async () => {
    vi.mocked(spawnPythonTool).mockResolvedValueOnce({
      ok: true,
      data: {
        markdown: "# 第一章\n\n这是提取后的正文",
        plainText: "第一章\n\n这是提取后的正文",
        sourceFormat: "pdf",
        tool: "pymupdf4llm",
        quality: "high",
        fallbackChain: ["pymupdf4llm"],
        warnings: [],
      },
    });

    const parsed = await parseKnowledgeFile("demo.pdf", Buffer.from("fake"));

    expect(parsed.normalizedMarkdown).toBe("# 第一章\n\n这是提取后的正文");
    expect(parsed.parserUsed).toBe("pymupdf4llm");
    expect(parsed.sections).toEqual([
      { location: "段落 1", text: "# 第一章" },
      { location: "段落 2", text: "这是提取后的正文" },
    ]);
  });

  it("parses html as an extra unified document format", async () => {
    const parsed = await parseKnowledgeFile("demo.html", Buffer.from("<h1>标题</h1><p>正文内容</p>", "utf8"));
    expect(parsed.normalizedMarkdown).toBe("标题\n\n正文内容");
    expect(parsed.parserUsed).toBe("html-text");
    expect(parsed.sourceFormat).toBe("html");
  });
});

describe("chunkKnowledgeSections", () => {
  it("greedily merges neighboring short sections into fewer chunks", () => {
    const chunks = chunkKnowledgeSections([
      { location: "文本 1", text: "A".repeat(200) },
      { location: "文本 2", text: "B".repeat(200) },
      { location: "文本 3", text: "C".repeat(200) },
    ], { chunkSize: 700, overlap: 100 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.location).toBe("文本 1-3");
  });

  it("splits long sections with overlap", () => {
    const chunks = chunkKnowledgeSections([{ location: "文本 1", text: "a".repeat(1200) }], { chunkSize: 1000, overlap: 100 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.location).toContain("片段 1");
    expect(chunks[1]?.location).toContain("片段 2");
  });
});

describe("groupKnowledgeSectionsByChapter", () => {
  it("groups markdown and chinese numbered chapter headings and skips ignored chapters", () => {
    const grouped = groupKnowledgeSectionsByChapter([
      { location: "文本 1", text: "# 目录" },
      { location: "文本 2", text: "这是目录内容" },
      { location: "文本 3", text: "第一章 招聘与录用" },
      { location: "文本 4", text: "正文一" },
      { location: "文本 5", text: "一、背景调查" },
      { location: "文本 6", text: "正文二" },
      { location: "文本 7", text: "附录" },
      { location: "文本 8", text: "附录内容" },
    ]);

    expect(grouped.skippedTitles).toEqual(["目录", "附录"]);
    expect(grouped.chapters.filter((chapter) => !chapter.skipped).map((chapter) => chapter.title)).toEqual([
      "第一章 招聘与录用",
      "一、背景调查",
    ]);
    expect(grouped.chapters.find((chapter) => chapter.title === "第一章 招聘与录用")?.sections).toEqual([
      { location: "文本 4", text: "正文一" },
    ]);
  });
});
