/**
 * 职责: 备份和恢复 Bridge 用户数据目录。
 * 关注点:
 * - 只处理本地 config/data/logs/extensions 等用户状态，不触达飞书远端数据。
 * - 使用内置 ZIP 读写实现，避免 portable 包依赖系统 zip 命令或新增 npm 依赖。
 */
import { createDeflateRaw, inflateRawSync } from "node:zlib";
import { constants } from "node:fs";
import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isMainModule } from "./checks.mjs";
import { createPortableEnv, resolveBridgeHome } from "./portable.mjs";

const BACKUP_MANIFEST = "backup-manifest.json";
const BACKUP_SCHEMA_VERSION = 1;
const FIXED_BACKUP_TOP_LEVELS = ["config.json", "data", "logs", "extensions", "mappings.json"];
const EXCLUDED_BACKUP_PATHS = new Set(["data/pkulaw-cache"]);

export async function runBackupCli(args = process.argv.slice(2), options = {}) {
  const logger = options.logger ?? console;
  try {
    const parsed = parseBackupArgs(args);
    const result = parsed.command === "restore"
      ? await restoreBackup({ ...options, ...parsed })
      : await createBackup({ ...options, ...parsed });
    if (parsed.command === "restore") {
      logger.log(`已恢复本地用户数据：${result.bridgeHome}`);
      logger.log("建议下一步：bridge doctor workspace");
      logger.log("然后运行：bridge guide");
    } else {
      logger.log(`已创建备份：${result.outputPath}`);
      logger.log(`包含文件：${result.fileCount} 个`);
      logger.log(`用户数据目录：${result.bridgeHome}`);
    }
    return 0;
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function createBackup(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = createPortableEnv({
    cwd,
    env: options.env ?? process.env,
    platform: options.platform,
    home: options.home,
  });
  const bridgeHome = options.bridgeHome ?? resolveBridgeHome({ env, platform: options.platform, home: options.home });
  const entries = await collectBackupEntries(bridgeHome);
  const manifest = {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    bridgeHome,
    files: entries.map((entry) => ({
      path: entry.path,
      size: entry.data.length,
    })),
  };
  const outputPath = path.resolve(
    options.outputPath
      ?? path.join(path.dirname(bridgeHome), `FeishuOpenCodeBridge-backup-${formatTimestamp(new Date())}.zip`),
  );
  const zipEntries = [
    { path: BACKUP_MANIFEST, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
    ...entries,
  ];
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, await buildZip(zipEntries));
  return {
    bridgeHome,
    outputPath,
    fileCount: entries.length,
  };
}

export async function restoreBackup(options = {}) {
  const zipPath = options.zipPath;
  if (!zipPath) {
    throw new Error("用法: bridge restore <zip> [--force]");
  }
  const cwd = options.cwd ?? process.cwd();
  const env = createPortableEnv({
    cwd,
    env: options.env ?? process.env,
    platform: options.platform,
    home: options.home,
  });
  const bridgeHome = options.bridgeHome ?? resolveBridgeHome({ env, platform: options.platform, home: options.home });
  const entries = readZipEntries(await readFile(zipPath));
  const manifestEntry = entries.find((entry) => entry.path === BACKUP_MANIFEST);
  if (!manifestEntry) {
    throw new Error("备份文件缺少 backup-manifest.json，拒绝恢复。");
  }
  const manifest = JSON.parse(manifestEntry.data.toString("utf8"));
  if (manifest.schemaVersion !== BACKUP_SCHEMA_VERSION || !Array.isArray(manifest.files)) {
    throw new Error("备份 manifest 版本不兼容或格式不合法。");
  }

  await assertRestoreSafe(bridgeHome, options.force === true);
  await mkdir(bridgeHome, { recursive: true });
  for (const entry of entries) {
    if (entry.path === BACKUP_MANIFEST) {
      continue;
    }
    const target = safeJoin(bridgeHome, entry.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.data);
  }
  return {
    bridgeHome,
    restoredCount: entries.length - 1,
  };
}

function parseBackupArgs(args) {
  const command = args[0] === "restore" ? "restore" : "backup";
  const rest = command === "restore" ? args.slice(1) : args;
  const result = { command, force: false };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--output") {
      result.outputPath = rest[++index];
    } else if (value === "--force") {
      result.force = true;
    } else if (command === "restore" && !result.zipPath) {
      result.zipPath = value;
    } else {
      throw new Error(`未知参数: ${value}`);
    }
  }
  return result;
}

async function collectBackupEntries(bridgeHome) {
  const entries = [];
  for (const name of FIXED_BACKUP_TOP_LEVELS) {
    await collectPath(entries, bridgeHome, name);
  }
  return entries;
}

async function collectPath(entries, bridgeHome, relativePath) {
  if (shouldExcludeBackupPath(relativePath)) {
    return;
  }
  const absolutePath = safeJoin(bridgeHome, relativePath);
  let info;
  try {
    info = await stat(absolutePath);
  } catch {
    return;
  }
  if (info.isDirectory()) {
    const children = await readdir(absolutePath);
    for (const child of children) {
      await collectPath(entries, bridgeHome, normalizeZipPath(path.posix.join(relativePath, child)));
    }
    return;
  }
  if (info.isFile()) {
    entries.push({
      path: normalizeZipPath(relativePath),
      data: await readFile(absolutePath),
    });
  }
}

function shouldExcludeBackupPath(relativePath) {
  const normalized = normalizeZipPath(relativePath);
  return EXCLUDED_BACKUP_PATHS.has(normalized)
    || [...EXCLUDED_BACKUP_PATHS].some((excluded) => normalized.startsWith(`${excluded}/`));
}

async function assertRestoreSafe(bridgeHome, force) {
  if (force) {
    await rm(bridgeHome, { recursive: true, force: true });
    return;
  }
  const conflicts = [];
  for (const relativePath of ["config.json", "data"]) {
    try {
      await access(path.join(bridgeHome, relativePath), constants.F_OK);
      conflicts.push(relativePath);
    } catch {
      // No conflict.
    }
  }
  if (conflicts.length > 0) {
    throw new Error(`目标用户数据目录已存在 ${conflicts.join("、")}；请先备份，或确认后使用 bridge restore <zip> --force。`);
  }
}

function safeJoin(root, relativePath) {
  const normalized = normalizeZipPath(relativePath);
  if (!normalized || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    throw new Error(`备份路径不安全：${relativePath}`);
  }
  const target = path.resolve(root, normalized);
  const resolvedRoot = path.resolve(root);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`备份路径越界：${relativePath}`);
  }
  return target;
}

function normalizeZipPath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\/+/, "");
}

async function buildZip(entries) {
  const chunks = [];
  const centralDirectory = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(normalizeZipPath(entry.path), "utf8");
    const data = Buffer.from(entry.data);
    const compressed = await deflateRaw(data);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    chunks.push(localHeader, name, compressed);
    centralDirectory.push({ entry, name, crc, compressedSize: compressed.length, size: data.length, offset });
    offset += localHeader.length + name.length + compressed.length;
  }

  const centralStart = offset;
  for (const item of centralDirectory) {
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(8, 10);
    header.writeUInt32LE(0, 12);
    header.writeUInt32LE(item.crc, 16);
    header.writeUInt32LE(item.compressedSize, 20);
    header.writeUInt32LE(item.size, 24);
    header.writeUInt16LE(item.name.length, 28);
    header.writeUInt32LE(item.offset, 42);
    chunks.push(header, item.name);
    offset += header.length + item.name.length;
  }
  const centralSize = offset - centralStart;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centralDirectory.length, 8);
  end.writeUInt16LE(centralDirectory.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  chunks.push(end);
  return Buffer.concat(chunks);
}

function readZipEntries(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileSize = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const compressed = buffer.subarray(dataStart, dataEnd);
    const data = method === 8 ? inflateRawSync(compressed) : compressed;
    if (data.length !== fileSize) {
      throw new Error(`备份条目大小不一致：${name}`);
    }
    entries.push({ path: normalizeZipPath(name), data });
    offset = dataEnd;
  }
  if (entries.length === 0) {
    throw new Error("备份文件不是可识别的 zip。");
  }
  return entries;
}

function deflateRaw(data) {
  return new Promise((resolve, reject) => {
    const stream = createDeflateRaw();
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.end(data);
  });
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

if (isMainModule(import.meta.url)) {
  process.exitCode = await runBackupCli(process.argv.slice(2), { home: os.homedir() });
}
