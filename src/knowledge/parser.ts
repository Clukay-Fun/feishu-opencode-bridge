/**
 * 职责: 解析知识库输入文档，并切分为适合检索的内容块。
 * 关注点:
 * - 通过通用 document-pipeline 获取 Markdown 与文本层。
 * - 负责切块与结构信息整理，供后续摄入使用。
 */
import {
  parseDocument,
  type DocumentParseQuality,
  type DocumentParserOptions,
  type DocumentParserUsed,
  type ParsedDocumentSection,
} from "../document-pipeline/index.js";

export type KnowledgeParserUsed = DocumentParserUsed;

export type ParsedKnowledgeSection = ParsedDocumentSection;

export type ParsedKnowledgeChunk = {
  location: string;
  text: string;
  prevContext?: string | undefined;
};

export type ParsedKnowledgeDocument = {
  normalizedMarkdown: string;
  plainText: string;
  sections: ParsedKnowledgeSection[];
  parserUsed: KnowledgeParserUsed;
  sourceFormat: string;
  quality: DocumentParseQuality;
  fallbackChain: string[];
  warnings: string[];
};

export type ParsedKnowledgeChapter = {
  title: string;
  sections: ParsedKnowledgeSection[];
  skipped: boolean;
};

//#region File parsing
// Parse one uploaded file into normalized markdown plus structured sections.
export async function parseKnowledgeFile(
  fileName: string,
  buffer: Buffer,
  options?: DocumentParserOptions,
): Promise<ParsedKnowledgeDocument> {
  const parsed = await parseDocument(fileName, buffer, options);
  return {
    normalizedMarkdown: parsed.markdown,
    plainText: parsed.plainText,
    sections: parsed.sections,
    parserUsed: parsed.parserUsed,
    sourceFormat: parsed.sourceFormat,
    quality: parsed.quality,
    fallbackChain: parsed.fallbackChain,
    warnings: parsed.warnings,
  };
}
//#endregion

//#region Chunking and chaptering
// Merge sections into retrieval-sized chunks with optional previous-context carryover.
export function chunkKnowledgeSections(
  sections: ParsedKnowledgeSection[],
  options: { chunkSize?: number; overlap?: number; prevContextSize?: number } = {},
): ParsedKnowledgeChunk[] {
  const resolved = {
    chunkSize: options.chunkSize ?? 1_000,
    overlap: options.overlap ?? 100,
    prevContextSize: options.prevContextSize ?? 150,
  };
  const chunks: Array<{ location: string; text: string }> = [];
  const pendingSections: ParsedKnowledgeSection[] = [];
  let pendingText = "";

  const flushPending = (): void => {
    const normalized = normalizeChunkText(pendingText);
    if (!normalized || pendingSections.length === 0) {
      pendingSections.length = 0;
      pendingText = "";
      return;
    }
    chunks.push({
      location: summarizeSectionRange(pendingSections),
      text: normalized,
    });
    pendingSections.length = 0;
    pendingText = "";
  };

  for (const section of sections) {
    const normalized = normalizeChunkText(section.text);
    if (!normalized) {
      continue;
    }

    if (normalized.length > resolved.chunkSize) {
      flushPending();
      chunks.push(...splitOversizedSection(section.location, normalized, resolved.chunkSize, resolved.overlap));
      continue;
    }

    const nextText = pendingText ? `${pendingText}\n\n${normalized}` : normalized;
    if (pendingText && nextText.length > resolved.chunkSize) {
      flushPending();
      pendingText = normalized;
      pendingSections.push({ location: section.location, text: normalized });
      continue;
    }

    pendingText = nextText;
    pendingSections.push({ location: section.location, text: normalized });
  }

  flushPending();

  return chunks.map((chunk, index) => ({
    location: chunk.location,
    text: chunk.text,
    prevContext: index > 0 ? chunks[index - 1]?.text.slice(Math.max(0, chunks[index - 1]!.text.length - resolved.prevContextSize)).trim() : undefined,
  }));
}

// Detect chapter headings and group sections into higher-level chapter slices.
export function groupKnowledgeSectionsByChapter(sections: ParsedKnowledgeSection[]): {
  chapters: ParsedKnowledgeChapter[];
  skippedTitles: string[];
} {
  const headings = sections
    .map((section, index) => ({ section, index, title: detectChapterTitle(section.text) }))
    .filter((item): item is { section: ParsedKnowledgeSection; index: number; title: string } => Boolean(item.title));

  if (headings.length === 0) {
    return { chapters: [], skippedTitles: [] };
  }

  const chapters: ParsedKnowledgeChapter[] = [];
  const skippedTitles: string[] = [];
  let sectionStart = 0;

  for (let headingIndex = 0; headingIndex < headings.length; headingIndex += 1) {
    const current = headings[headingIndex]!;
    const next = headings[headingIndex + 1];
    const sliceStart = current.index + 1;
    const sliceEnd = next?.index ?? sections.length;
    const chapterSections = sections.slice(sliceStart, sliceEnd);
    const skipped = isIgnoredChapterTitle(current.title);
    if (skipped) {
      skippedTitles.push(current.title);
    }
    chapters.push({
      title: current.title,
      sections: skipped ? [] : chapterSections,
      skipped,
    });
    sectionStart = sliceEnd;
  }

  if (headings[0]!.index > 0) {
    chapters.unshift({
      title: "未命名前置内容",
      sections: sections.slice(0, headings[0]!.index),
      skipped: false,
    });
  } else if (sectionStart < sections.length) {
    // no-op; all trailing sections are already attached to the last heading
  }

  return { chapters, skippedTitles };
}
//#endregion

//#region Text normalization
// Detect chapter-like titles from single-line section content.
function detectChapterTitle(text: string): string | undefined {
  const normalized = text.trim();
  if (!normalized || normalized.includes("\n")) {
    return undefined;
  }
  const markdownHeading = normalized.match(/^#{1,3}\s+(.+)$/);
  if (markdownHeading?.[1]) {
    return markdownHeading[1].trim();
  }
  if (isIgnoredChapterTitle(normalized)) {
    return normalized;
  }
  if (/^第[一二三四五六七八九十百千万\d]+[章节编部篇]/.test(normalized)) {
    return normalized;
  }
  if (/^[一二三四五六七八九十百千万]+、/.test(normalized)) {
    return normalized;
  }
  return undefined;
}

// Skip front-matter or appendix titles that should not become chapter bodies.
function isIgnoredChapterTitle(title: string): boolean {
  return /^(?:卷首语|序言|目录|前言|出版说明|作者简介|推荐序|参考文献|附录|索引|后记|致谢)$/.test(
    title.replace(/\s+/g, ""),
  );
}

// Normalize chunk text before sizing or concatenation.
function normalizeChunkText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Split one oversized section into overlapping retrieval chunks.
function splitOversizedSection(location: string, text: string, chunkSize: number, overlap: number): Array<{ location: string; text: string }> {
  const chunks: Array<{ location: string; text: string }> = [];
  let start = 0;
  let chunkIndex = 1;
  while (start < text.length) {
    const end = Math.min(text.length, start + chunkSize);
    chunks.push({
      location: `${location} · 片段 ${chunkIndex}`,
      text: text.slice(start, end).trim(),
    });
    if (end >= text.length) {
      break;
    }
    start = Math.max(0, end - overlap);
    chunkIndex += 1;
  }
  return chunks;
}

// Summarize a section span into one human-readable location label.
function summarizeSectionRange(sections: ParsedKnowledgeSection[]): string {
  const first = sections[0];
  const last = sections[sections.length - 1];
  if (!first || !last) {
    return "文本";
  }
  if (first.location === last.location) {
    return first.location;
  }
  const firstMatch = first.location.match(/^(.*?)(\d+)$/);
  const lastMatch = last.location.match(/^(.*?)(\d+)$/);
  if (firstMatch && lastMatch && firstMatch[1] === lastMatch[1]) {
    const prefix = firstMatch[1] ?? "";
    const start = firstMatch[2] ?? "";
    const end = lastMatch[2] ?? "";
    return `${prefix.trim()} ${start}-${end}`;
  }
  return `${first.location} - ${last.location}`;
}

//#endregion
