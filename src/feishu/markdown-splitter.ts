const DEFAULT_BLOCK_LIMIT = 30;

type MarkdownBlockKind = "heading" | "paragraph" | "list" | "table" | "code";

export function splitMarkdownBlocks(markdown: string, limit = DEFAULT_BLOCK_LIMIT): string[] {
  const blocks = collectMarkdownBlocks(markdown);
  return mergeOverflowBlocks(blocks, limit);
}

function collectMarkdownBlocks(markdown: string): string[] {
  const lines = markdown.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let currentKind: MarkdownBlockKind | null = null;
  let inFence = false;

  const flush = (): void => {
    const block = current.join("\n").trim();
    if (block) {
      blocks.push(block);
    }
    current = [];
    currentKind = null;
  };

  for (const line of lines) {
    if (isFenceLine(line)) {
      if (inFence) {
        current.push(line);
        inFence = false;
        flush();
        continue;
      }

      flush();
      current.push(line);
      currentKind = "code";
      inFence = true;
      continue;
    }

    if (inFence) {
      current.push(line);
      continue;
    }

    if (line.trim() === "") {
      flush();
      continue;
    }

    const nextKind = classifyLine(line);
    if (nextKind === "heading") {
      flush();
      current.push(line);
      currentKind = nextKind;
      flush();
      continue;
    }

    if (currentKind && currentKind !== nextKind) {
      flush();
    }

    current.push(line);
    currentKind = nextKind;
  }

  flush();
  return blocks;
}

function mergeOverflowBlocks(blocks: string[], limit: number): string[] {
  const safeLimit = Math.max(1, Math.floor(limit));
  if (blocks.length <= safeLimit) {
    return blocks;
  }

  return [
    ...blocks.slice(0, safeLimit - 1),
    blocks.slice(safeLimit - 1).join("\n\n"),
  ];
}

function classifyLine(line: string): MarkdownBlockKind {
  if (/^\s{0,3}#{1,6}\s+\S/.test(line)) {
    return "heading";
  }
  if (/^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line)) {
    return "list";
  }
  if (line.trimStart().startsWith("|")) {
    return "table";
  }
  return "paragraph";
}

function isFenceLine(line: string): boolean {
  return /^\s*```/.test(line);
}
