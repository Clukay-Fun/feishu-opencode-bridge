import { spawn } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AppConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { FeishuApiClient } from "../feishu/api.js";
import type { Logger } from "../logging/logger.js";
import { OpenCodeClient } from "../opencode/client.js";
import {
  KnowledgeBaseService,
  type KnowledgeDocumentDetail,
  type KnowledgeDocumentSummary,
  type KnowledgeExtractPreviewResult,
  type KnowledgeIngestResult,
  type KnowledgeParsedFileResult,
  type KnowledgeQueryResult,
  type KnowledgeStatsResult,
} from "./index.js";

type CliArgs = Record<string, string | boolean>;

type ParsedCliInput = {
  command: string[];
  args: CliArgs;
};

export type KnowledgeDoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type KnowledgeDoctorResult = {
  online: boolean;
  checks: KnowledgeDoctorCheck[];
};

type IngestDirectoryFileResult =
  | {
    path: string;
    ok: true;
    extractedCount: number;
    dedupedCount?: number | undefined;
    rawExtractedCount?: number | undefined;
    durationMs: number;
  }
  | {
    path: string;
    ok: false;
    error: string;
  };

type IngestDirectoryResult = {
  rootPath: string;
  recursive: boolean;
  glob?: string | undefined;
  totalFiles: number;
  successCount: number;
  failureCount: number;
  totalExtractedCount: number;
  files: IngestDirectoryFileResult[];
};

type LocalKnowledgeService = {
  query(question: string): Promise<KnowledgeQueryResult>;
  ingestLocalFile(filePath: string): Promise<KnowledgeIngestResult>;
  ingestWebPage(request: { url: string; instruction?: string | undefined }): Promise<KnowledgeIngestResult>;
  parseLocalFile(filePath: string): Promise<KnowledgeParsedFileResult>;
  previewLocalFileExtraction(
    filePath: string,
    options?: { maxQas?: number | undefined },
  ): Promise<KnowledgeExtractPreviewResult>;
  listDocuments(options?: { limit?: number | undefined; status?: string | undefined }): Promise<KnowledgeDocumentSummary[]>;
  getDocument(id: number): Promise<KnowledgeDocumentDetail | null>;
  getStats(): Promise<KnowledgeStatsResult>;
  close(): void;
};

type CliRuntime = {
  config: AppConfig;
  service: LocalKnowledgeService;
  opencode: Pick<OpenCodeClient, "health">;
  bitable: Pick<FeishuApiClient, "listBitableRecords">;
  close(): void;
};

type CliRuntimeFactory = (configPath?: string) => Promise<CliRuntime>;

type DoctorInspector = (runtime: CliRuntime, options: { online: boolean }) => Promise<KnowledgeDoctorResult>;

export type LocalCliResult<T> =
  | { ok: true; result: T; error: null }
  | { ok: false; result: null; error: string };

type RunCliOptions = {
  createRuntime?: CliRuntimeFactory;
  inspectDoctor?: DoctorInspector;
};

const SILENT_LOGGER: Logger = {
  log() {},
  logTranscript() {},
};

const PDF_TO_MD_SCRIPT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/python/pdf_to_markdown.py",
);

export async function runKnowledgeCli(
  argv: string[],
  options?: RunCliOptions,
): Promise<LocalCliResult<unknown>> {
  return await runWithRuntime(argv, options, async (input, runtime) => {
    const [command, subcommand] = input.command;

    if (command === "query") {
      const question = readRequiredArg(input.args, "question");
      return await runtime.service.query(question);
    }

    if (command === "ingest" && subcommand === "file") {
      const filePath = readRequiredArg(input.args, "path");
      return await runtime.service.ingestLocalFile(filePath);
    }

    if (command === "ingest" && subcommand === "url") {
      const url = readRequiredArg(input.args, "url");
      const instruction = readOptionalArg(input.args, "instruction");
      return await runtime.service.ingestWebPage({
        url,
        ...(instruction ? { instruction } : {}),
      });
    }

    if (command === "ingest" && subcommand === "dir") {
      return await runKnowledgeIngestDirectory(runtime, input.args);
    }

    if (command === "parse" && subcommand === "pdf") {
      const filePath = readRequiredArg(input.args, "path");
      if (path.extname(filePath).toLowerCase() !== ".pdf") {
        throw new Error("`kb parse pdf` 仅支持 .pdf 文件。");
      }
      return await runtime.service.parseLocalFile(filePath);
    }

    if (command === "extract") {
      const filePath = readRequiredArg(input.args, "path");
      const maxQas = readOptionalIntegerArg(input.args, "max-qas");
      return await runtime.service.previewLocalFileExtraction(filePath, {
        ...(maxQas !== undefined ? { maxQas } : {}),
      });
    }

    if (command === "doc" && subcommand === "list") {
      const limit = readOptionalIntegerArg(input.args, "limit");
      const status = readOptionalArg(input.args, "status");
      return await runtime.service.listDocuments({
        ...(limit !== undefined ? { limit } : {}),
        ...(status ? { status } : {}),
      });
    }

    if (command === "doc" && subcommand === "show") {
      const id = readRequiredIntegerArg(input.args, "id");
      const document = await runtime.service.getDocument(id);
      if (!document) {
        throw new Error(`未找到文档 #${id}`);
      }
      return document;
    }

    if (command === "stats") {
      return await runtime.service.getStats();
    }

    if (command === "doctor") {
      const online = readBooleanArg(input.args, "online");
      return await (options?.inspectDoctor ?? inspectKnowledgeDoctor)(runtime, { online });
    }

    throw new Error(buildUnknownCommandError(input.command));
  });
}

export async function runKnowledgeQueryCli(
  argv: string[],
  options?: RunCliOptions,
): Promise<LocalCliResult<KnowledgeQueryResult>> {
  return await runKnowledgeCli(["query", ...argv], options) as LocalCliResult<KnowledgeQueryResult>;
}

export async function runKnowledgeIngestFileCli(
  argv: string[],
  options?: RunCliOptions,
): Promise<LocalCliResult<KnowledgeIngestResult>> {
  return await runKnowledgeCli(["ingest", "file", ...argv], options) as LocalCliResult<KnowledgeIngestResult>;
}

export async function runKnowledgeIngestUrlCli(
  argv: string[],
  options?: RunCliOptions,
): Promise<LocalCliResult<KnowledgeIngestResult>> {
  return await runKnowledgeCli(["ingest", "url", ...argv], options) as LocalCliResult<KnowledgeIngestResult>;
}

export function printLocalCliResult(result: LocalCliResult<unknown>): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export async function createKnowledgeCliRuntime(configPath?: string): Promise<CliRuntime> {
  const config = await loadConfig(configPath);
  ensureKnowledgeBaseEnabled(config);
  const bitable = new FeishuApiClient(config.feishu.appId, config.feishu.appSecret);
  const opencode = new OpenCodeClient(config.opencode.baseUrl);
  const service = new KnowledgeBaseService(
    config.knowledgeBase,
    {
      async downloadMessageResource() {
        throw new Error("本地知识库命令不支持消息附件下载，请改用本地路径入库。");
      },
      createBitableRecord: bitable.createBitableRecord.bind(bitable),
      listBitableRecords: bitable.listBitableRecords.bind(bitable),
    },
    opencode,
    SILENT_LOGGER,
  ) as LocalKnowledgeService;

  return {
    config,
    service,
    opencode,
    bitable,
    close() {
      service.close();
    },
  };
}

async function runWithRuntime<T>(
  argv: string[],
  options: RunCliOptions | undefined,
  run: (input: ParsedCliInput, runtime: CliRuntime) => Promise<T>,
): Promise<LocalCliResult<T>> {
  const input = parseCliInput(argv);
  let runtime: CliRuntime | null = null;
  try {
    runtime = await (options?.createRuntime ?? createKnowledgeCliRuntime)(readOptionalArg(input.args, "config"));
    const result = await run(input, runtime);
    return { ok: true, result, error: null };
  } catch (error) {
    return {
      ok: false,
      result: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    runtime?.close();
  }
}

async function runKnowledgeIngestDirectory(runtime: CliRuntime, args: CliArgs): Promise<IngestDirectoryResult> {
  const rootPath = path.resolve(readRequiredArg(args, "path"));
  const recursive = readBooleanArg(args, "recursive");
  const failFast = readBooleanArg(args, "fail-fast");
  const glob = readOptionalArg(args, "glob");
  const limit = readOptionalIntegerArg(args, "limit");
  const files = await collectDirectoryFiles(rootPath, recursive);
  const matcher = glob ? createGlobMatcher(glob) : null;
  const allowedExtensions = new Set(runtime.config.knowledgeBase.ingest.allowedExtensions.map((extension) => extension.toLowerCase()));
  const candidates = files
    .filter((filePath) => allowedExtensions.has(path.extname(filePath).toLowerCase()))
    .filter((filePath) => !matcher || matcher(normalizeRelativeFilePath(rootPath, filePath)))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, limit ?? Number.MAX_SAFE_INTEGER);

  const results: IngestDirectoryFileResult[] = [];
  let totalExtractedCount = 0;
  for (const filePath of candidates) {
    try {
      const result = await runtime.service.ingestLocalFile(filePath);
      totalExtractedCount += result.extractedCount;
      results.push({
        path: filePath,
        ok: true,
        extractedCount: result.extractedCount,
        dedupedCount: result.dedupedCount,
        rawExtractedCount: result.rawExtractedCount,
        durationMs: result.durationMs,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({
        path: filePath,
        ok: false,
        error: detail,
      });
      if (failFast) {
        break;
      }
    }
  }

  return {
    rootPath,
    recursive,
    glob,
    totalFiles: candidates.length,
    successCount: results.filter((item) => item.ok).length,
    failureCount: results.filter((item) => !item.ok).length,
    totalExtractedCount,
    files: results,
  };
}

async function inspectKnowledgeDoctor(runtime: CliRuntime, options: { online: boolean }): Promise<KnowledgeDoctorResult> {
  const checks: KnowledgeDoctorCheck[] = [];
  checks.push({
    name: "knowledgeBase.enabled",
    ok: runtime.config.knowledgeBase.enabled,
    detail: runtime.config.knowledgeBase.enabled ? "已启用知识库配置。" : "knowledgeBase.enabled=false。",
  });
  checks.push({
    name: "sqlitePath",
    ok: Boolean(runtime.config.knowledgeBase.storage.sqlitePath),
    detail: runtime.config.knowledgeBase.storage.sqlitePath
      ? `SQLite 路径：${runtime.config.knowledgeBase.storage.sqlitePath}`
      : "缺少 knowledgeBase.storage.sqlitePath。",
  });
  checks.push({
    name: "bitable",
    ok: Boolean(runtime.config.knowledgeBase.storage.bitable.appToken && runtime.config.knowledgeBase.storage.bitable.tableId),
    detail: runtime.config.knowledgeBase.storage.bitable.appToken && runtime.config.knowledgeBase.storage.bitable.tableId
      ? "已配置 Bitable appToken/tableId。"
      : "缺少 Bitable appToken 或 tableId。",
  });
  checks.push({
    name: "embeddingProvider",
    ok: Boolean(runtime.config.knowledgeBase.embeddingProvider),
    detail: runtime.config.knowledgeBase.embeddingProvider
      ? `Embedding 模型：${runtime.config.knowledgeBase.embeddingProvider.model}`
      : "缺少 knowledgeBase.embeddingProvider。",
  });

  const pythonCommand = await resolvePythonCommand();
  checks.push({
    name: "python",
    ok: Boolean(pythonCommand),
    detail: pythonCommand ? `已找到 Python：${pythonCommand}` : "未找到可用的 Python 解释器。",
  });

  checks.push({
    name: "pdf_to_markdown.py",
    ok: await fileExists(PDF_TO_MD_SCRIPT_PATH),
    detail: `PDF 脚本：${PDF_TO_MD_SCRIPT_PATH}`,
  });

  if (options.online) {
    checks.push(await wrapDoctorCheck("opencode.health", async () => {
      const health = await runtime.opencode.health();
      return `OpenCode healthy=${health.healthy} version=${health.version}`;
    }));
    checks.push(await wrapDoctorCheck("bitable.read", async () => {
      const records = await runtime.bitable.listBitableRecords(
        runtime.config.knowledgeBase.storage.bitable.appToken,
        runtime.config.knowledgeBase.storage.bitable.tableId,
      );
      return `可读取知识库表，共 ${records.length} 条记录。`;
    }));
    if (pythonCommand) {
      checks.push(await wrapDoctorCheck("python.import.pymupdf4llm", async () => {
        await assertPythonModule(pythonCommand, "pymupdf4llm");
        return "可导入 pymupdf4llm。";
      }));
      checks.push(await wrapDoctorCheck("python.import.docling", async () => {
        await assertPythonModule(pythonCommand, "docling");
        return "可导入 docling。";
      }));
    }
  }

  return {
    online: options.online,
    checks,
  };
}

async function wrapDoctorCheck(name: string, check: () => Promise<string>): Promise<KnowledgeDoctorCheck> {
  try {
    return {
      name,
      ok: true,
      detail: await check(),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function ensureKnowledgeBaseEnabled(config: AppConfig): void {
  if (!config.knowledgeBase.enabled) {
    throw new Error("knowledgeBase.enabled=false，无法执行本地知识库命令。");
  }
}

function parseCliInput(argv: string[]): ParsedCliInput {
  const args: CliArgs = {};
  const command: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current) {
      continue;
    }
    if (!current.startsWith("--")) {
      command.push(current);
      continue;
    }
    const body = current.slice(2);
    if (!body) {
      continue;
    }
    const [key, inlineValue] = body.split("=", 2);
    if (!key) {
      continue;
    }
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return { command, args };
}

function readRequiredArg(args: CliArgs, key: string): string {
  const value = readOptionalArg(args, key);
  if (!value) {
    throw new Error(`缺少必填参数 --${key}`);
  }
  return value;
}

function readOptionalArg(args: CliArgs, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBooleanArg(args: CliArgs, key: string): boolean {
  return args[key] === true;
}

function readRequiredIntegerArg(args: CliArgs, key: string): number {
  const value = readOptionalIntegerArg(args, key);
  if (value === undefined) {
    throw new Error(`缺少必填参数 --${key}`);
  }
  return value;
}

function readOptionalIntegerArg(args: CliArgs, key: string): number | undefined {
  const value = readOptionalArg(args, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`参数 --${key} 必须是正整数`);
  }
  return parsed;
}

function buildUnknownCommandError(command: string[]): string {
  const received = command.join(" ").trim() || "(empty)";
  return `未知知识库命令：${received}`;
}

async function collectDirectoryFiles(rootPath: string, recursive: boolean): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      if (recursive) {
        files.push(...await collectDirectoryFiles(absolutePath, true));
      }
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }
  return files;
}

function createGlobMatcher(pattern: string): (value: string) => boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  const regex = new RegExp(`^${escaped}$`, "i");
  return (value: string) => regex.test(value);
}

function normalizeRelativeFilePath(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath).split(path.sep).join("/");
}

async function resolvePythonCommand(): Promise<string | null> {
  for (const command of dedupeCommands([
    process.env.KNOWLEDGE_PDF_TO_MD_PYTHON,
    process.env.PYTHON,
    "python3",
    "python",
  ])) {
    try {
      await spawnProcess(command, ["--version"]);
      return command;
    } catch {
      continue;
    }
  }
  return null;
}

async function assertPythonModule(command: string, moduleName: string): Promise<void> {
  await spawnProcess(command, ["-c", `import ${moduleName}`]);
}

async function spawnProcess(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${command} ${args.join(" ")} 执行失败`));
    });
  });
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function dedupeCommands(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}
