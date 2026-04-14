export type ParsedKnowledgeSection = {
  location: string;
  text: string;
};

export type ParsedKnowledgeChunk = {
  location: string;
  text: string;
  prevContext?: string | undefined;
};

export type ParsedKnowledgeDocument = {
  normalizedMarkdown: string;
  sections: ParsedKnowledgeSection[];
};

export type ParsedKnowledgeChapter = {
  title: string;
  sections: ParsedKnowledgeSection[];
  skipped: boolean;
};

export async function parseKnowledgeFile(
  fileName: string,
  buffer: Buffer,
): Promise<ParsedKnowledgeDocument> {
  const extension = normalizeExtension(fileName);
  if (extension === ".txt" || extension === ".md") {
    const normalizedMarkdown = normalizePlainMarkdown(decodePlainTextBuffer(buffer));
    return {
      normalizedMarkdown,
      sections: normalizeSectionsFromMarkdown(normalizedMarkdown, "文本"),
    };
  }
  if (extension === ".docx") {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    const normalizedMarkdown = normalizePlainMarkdown(result.value);
    return {
      normalizedMarkdown,
      sections: normalizeSectionsFromMarkdown(normalizedMarkdown, "段落"),
    };
  }
  if (extension === ".pdf") {
    const pdfModule = await import("pdf-parse");
    const parser = new pdfModule.PDFParse({ data: buffer });
    const result = await parser.getText({});
    await parser.destroy().catch(() => undefined);
    const pages = result.pages.map((page) => normalizePageText(page.text)).filter(Boolean);
    const normalizedMarkdown = pages.join("\n\n---\n\n");
    const sections = pages.length > 0
      ? pages.map((text, index) => ({ location: `第 ${index + 1} 页`, text }))
      : normalizeSectionsFromMarkdown(normalizePlainMarkdown(result.text), "页");
    return {
      normalizedMarkdown,
      sections,
    };
  }
  throw new Error(`暂不支持的文件格式：${extension || "unknown"}`);
}

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

function normalizePlainMarkdown(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replaceAll("\u0000", "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeSectionsFromMarkdown(markdown: string, prefix: string): ParsedKnowledgeSection[] {
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

function isIgnoredChapterTitle(title: string): boolean {
  return /^(?:卷首语|序言|目录|前言|出版说明|作者简介|推荐序|参考文献|附录|索引|后记|致谢)$/.test(
    title.replace(/\s+/g, ""),
  );
}

function normalizePageText(text: string): string {
  return normalizePlainMarkdown(text);
}

function normalizeChunkText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

function normalizeExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.[a-z0-9]+$/);
  return match?.[0] ?? "";
}

function decodePlainTextBuffer(buffer: Buffer): string {
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
