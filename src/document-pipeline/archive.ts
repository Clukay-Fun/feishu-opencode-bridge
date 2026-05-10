/**
 * 职责: 展开用户上传的文件夹压缩包为可复用材料条目。
 * 关注点:
 * - 收口 zip 解析、隐藏文件过滤和扩展名白名单。
 * - 让知识库、劳动工作台等文件型 workflow 共享同一套文件夹导入规则。
 * - 不负责飞书 Drive 目录遍历；目录 token 可在上游转成同样的条目结构。
 */
import path from "node:path";
import PizZip from "pizzip";

export type ArchiveMaterialEntry = {
  fileName: string;
  buffer: Buffer;
  originalPath: string;
};

export function isArchiveFileName(fileName: string): boolean {
  return path.extname(fileName).toLowerCase() === ".zip";
}

export function expandArchiveMaterialEntries(
  archiveFileName: string,
  buffer: Buffer,
  allowedExtensions: readonly string[],
): ArchiveMaterialEntry[] {
  let archive: PizZip;
  try {
    archive = new PizZip(buffer);
  } catch (error) {
    throw new Error(`压缩包解析失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const allowedInnerExtensions = new Set(
    allowedExtensions
      .map((extension) => extension.trim().toLowerCase())
      .filter((extension) => extension && extension !== ".zip"),
  );
  const archiveBaseName = path.basename(archiveFileName, path.extname(archiveFileName));
  const entries: ArchiveMaterialEntry[] = [];
  for (const [entryPath, entry] of Object.entries(archive.files)) {
    const normalizedPath = entryPath.replace(/\\/g, "/");
    if (entry.dir || shouldSkipArchiveEntry(normalizedPath)) {
      continue;
    }
    const baseName = path.basename(normalizedPath);
    const extension = path.extname(baseName).toLowerCase();
    if (!baseName || !allowedInnerExtensions.has(extension)) {
      continue;
    }
    entries.push({
      fileName: `${archiveBaseName}/${baseName}`,
      buffer: entry.asNodeBuffer(),
      originalPath: normalizedPath,
    });
  }
  return entries;
}

function shouldSkipArchiveEntry(entryPath: string): boolean {
  if (entryPath.startsWith("__MACOSX/")) {
    return true;
  }
  return entryPath.split("/").some((part) => !part || part.startsWith("."));
}
