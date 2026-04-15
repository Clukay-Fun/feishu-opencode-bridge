import { spawnPythonTool } from "../utils/python-tool.js";

export type PdfMarkdownResult = {
  markdown: string;
  parserUsed: "pymupdf4llm" | "docling";
};

export async function spawnPdfToMarkdown(inputPath: string): Promise<PdfMarkdownResult> {
  const result = await spawnPythonTool<{
    markdown: string;
    method: "pymupdf4llm" | "docling";
  }>("pdf_to_markdown", { inputPath });
  if (!result.ok) {
    throw new Error(result.error);
  }
  const markdown = result.data.markdown?.trim();
  if (!markdown) {
    throw new Error("Python PDF 转 Markdown 脚本未生成内容");
  }
  return {
    markdown,
    parserUsed: result.data.method,
  };
}
