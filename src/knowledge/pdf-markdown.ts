/**
 * 职责: 封装 PDF 转 Markdown 的 Python 工具调用。
 * 关注点:
 * - 调用外部脚本完成 PDF 文本抽取。
 * - 统一 pymupdf4llm 与 docling 两种解析引擎的返回格式。
 */
import { spawnPythonTool } from "../utils/python-tool.js";

export type PdfMarkdownResult = {
  markdown: string;
  parserUsed: "pymupdf4llm" | "docling";
};

/** 调用 Python 工具把 PDF 解析为 Markdown。 */
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
