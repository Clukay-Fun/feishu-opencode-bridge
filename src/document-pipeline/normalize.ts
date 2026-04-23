/**
 * 职责: 提供文档解析流程共享的文本归一化工具。
 * 关注点:
 * - 统一纯文本、Markdown、HTML 等来源的换行和空白风格。
 * - 为上层解析器提供稳定的分段与解码行为。
 */

export type ParsedDocumentSection = {
  location: string;
  text: string;
};

/** 规范化纯文本或 Markdown，生成稳定的段落间距。 */
export function normalizePlainMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replaceAll("\u0000", "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 将 Markdown 按空段拆分为稳定 section。 */
export function normalizeSectionsFromMarkdown(markdown: string, prefix: string): ParsedDocumentSection[] {
  if (!markdown) {
    return [];
  }
  const blocks = markdown
    .split(/\n\s*\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return blocks.map((block, index) => ({
    location: `${prefix} ${index + 1}`,
    text: block,
  }));
}

/** 规范化 PDF 页面文本。 */
export function normalizePageText(text: string): string {
  return normalizePlainMarkdown(text);
}

/** 从文件名中提取小写扩展名。 */
export function normalizeExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] ?? "";
}

/** 解码纯文本缓冲区，必要时从 UTF-8 回退到 GB18030。 */
export function decodePlainTextBuffer(buffer: Buffer): string {
  const utf8 = buffer.toString("utf8");
  if (!looksMojibake(utf8)) {
    return utf8;
  }

  try {
    const gb18030 = new TextDecoder("gb18030", { fatal: false }).decode(buffer);
    return scoreReadableText(gb18030) >= scoreReadableText(utf8) ? gb18030 : utf8;
  } catch {
    return utf8;
  }
}

function looksMojibake(text: string): boolean {
  if (!text) {
    return false;
  }
  return text.includes("\uFFFD") || /(Ã.|Â.|ä.|å.|æ.|ç.|è.|é.)/.test(text);
}

function scoreReadableText(text: string): number {
  const cjkMatches = text.match(/[\u4E00-\u9FFF]/g)?.length ?? 0;
  const replacementMatches = text.match(/\uFFFD/g)?.length ?? 0;
  const mojibakeMatches = text.match(/(Ã.|Â.|ä.|å.|æ.|ç.|è.|é.)/g)?.length ?? 0;
  return cjkMatches * 2 - replacementMatches * 3 - mojibakeMatches;
}
