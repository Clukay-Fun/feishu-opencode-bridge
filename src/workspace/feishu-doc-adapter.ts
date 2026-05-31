/**
 * 职责: 封装 lark-cli 飞书云文档读写为 WorkspaceService 统一接口。
 * 关注点:
 * - URL 解析：识别 Docx / Wiki / Sheet / Base URL。
 * - fetchFeishuDoc：读取云文档并返回 WorkspaceParseResult。
 * - updateFeishuDoc：写操作前保留快照到 Journal。
 * - lark-cli 不可用时降级返回。
 */
import { execFile } from "node:child_process";

import type { Logger } from "../logging/logger.js";
import type { WorkspaceParseResult, WorkspaceSource } from "./types.js";
import type { DocumentOperationJournal } from "./journal-db.js";

export type FeishuDocType = "docx" | "wiki" | "sheet" | "base" | "unknown";

export type FeishuUpdateCommand =
  | "append"
  | "overwrite"
  | "replace"
  | "insertByHeading";

const DOC_URL_PATTERNS: Array<{ pattern: RegExp; type: FeishuDocType }> = [
  { pattern: /\/docx\/([a-zA-Z0-9]+)/, type: "docx" },
  { pattern: /\/wiki\/([a-zA-Z0-9]+)/, type: "wiki" },
  { pattern: /\/sheets\/([a-zA-Z0-9]+)/, type: "sheet" },
  { pattern: /\/base\/([a-zA-Z0-9]+)/, type: "base" },
];

/** 解析飞书云文档 URL，返回类型和 token。 */
export function parseFeishuDocUrl(url: string): { type: FeishuDocType; token: string } | null {
  for (const { pattern, type } of DOC_URL_PATTERNS) {
    const match = url.match(pattern);
    if (match?.[1]) {
      return { type, token: match[1] };
    }
  }
  return null;
}

export class FeishuDocAdapter {
  private larkCliAvailable: boolean | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly journal: DocumentOperationJournal,
  ) {}

  /** 检测 lark-cli 是否可用。 */
  async checkAvailability(): Promise<boolean> {
    if (this.larkCliAvailable !== null) {
      return this.larkCliAvailable;
    }
    try {
      await this.execLarkCli(["--version"]);
      this.larkCliAvailable = true;
    } catch {
      this.larkCliAvailable = false;
      this.logger.log("workspace/feishu-doc", "lark-cli 不可用，云文档功能降级", {}, "warn");
    }
    return this.larkCliAvailable;
  }

  /** 读取飞书云文档并返回 WorkspaceParseResult。 */
  async fetch(url: string): Promise<WorkspaceParseResult> {
    const startTime = Date.now();
    const parsed = parseFeishuDocUrl(url);
    if (!parsed) {
      this.journal.appendSafe(this.logger, {
        operationType: "fetch-feishu",
        sourceType: "feishu-doc",
        fileName: url,
        extension: "",
        status: "failed",
        elapsedMs: Date.now() - startTime,
        detail: "不是有效的飞书云文档 URL",
      });
      throw new Error("不是有效的飞书云文档 URL");
    }

    if (!(await this.checkAvailability())) {
      this.journal.appendSafe(this.logger, {
        operationType: "fetch-feishu",
        inputPath: url,
        sourceType: "feishu-doc",
        fileName: `${parsed.type}-${parsed.token}`,
        extension: "",
        status: "failed",
        elapsedMs: Date.now() - startTime,
        detail: "lark-cli 不可用",
      });
      throw new Error("lark-cli 不可用，无法读取飞书云文档");
    }

    try {
      const result = await this.execLarkCli(["docs", "+fetch", "--url", url, "--format", "text"]);
      const elapsedMs = Date.now() - startTime;

      this.journal.appendSafe(this.logger, {
        operationType: "fetch-feishu",
        inputPath: url,
        sourceType: "feishu-doc",
        fileName: `${parsed.type}-${parsed.token}`,
        extension: "",
        status: "success",
        elapsedMs,
      });

      return {
        meta: {
          fileName: `${parsed.type}-${parsed.token}`,
          extension: "",
          size: result.length,
          source: "feishu-doc" as WorkspaceSource,
          sourceUrl: url,
        },
        content: {
          rawText: result,
          markdown: result,
        },
        parse: {
          used: "plain-text",
          quality: "medium",
          fallbackChain: ["lark-cli"],
          warnings: [],
          elapsedMs,
        },
      };
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      const detail = error instanceof Error ? error.message : String(error);
      this.journal.appendSafe(this.logger, {
        operationType: "fetch-feishu",
        inputPath: url,
        sourceType: "feishu-doc",
        fileName: `${parsed.type}-${parsed.token}`,
        extension: "",
        status: "failed",
        elapsedMs,
        detail,
      });
      throw error;
    }
  }

  /** 写操作前快照 + 执行写入。 */
  async update(
    url: string,
    command: FeishuUpdateCommand,
    content: string,
    options?: { heading?: string },
  ): Promise<{ success: boolean; detail?: string }> {
    const startTime = Date.now();
    const parsed = parseFeishuDocUrl(url);
    if (!parsed) {
      return { success: false, detail: "不是有效的飞书云文档 URL" };
    }

    if (!(await this.checkAvailability())) {
      return { success: false, detail: "lark-cli 不可用" };
    }

    // 写前快照
    let snapshotSummary = "";
    try {
      const existing = await this.fetch(url);
      snapshotSummary = existing.content.rawText?.slice(0, 500) ?? "";
    } catch {
      // 文档可能不存在（create 场景），快照为空
    }

    try {
      const args = this.buildUpdateArgs(url, command, content, options);
      await this.execLarkCli(args);
      const elapsedMs = Date.now() - startTime;

      this.journal.appendSafe(this.logger, {
        operationType: `update-feishu-${command}`,
        inputPath: url,
        sourceType: "feishu-doc",
        fileName: `${parsed.type}-${parsed.token}`,
        extension: "",
        status: "success",
        elapsedMs,
        detail: snapshotSummary ? `快照摘要：${snapshotSummary.slice(0, 200)}` : undefined,
      });

      return { success: true };
    } catch (error) {
      const elapsedMs = Date.now() - startTime;
      const detail = error instanceof Error ? error.message : String(error);
      this.journal.appendSafe(this.logger, {
        operationType: `update-feishu-${command}`,
        inputPath: url,
        sourceType: "feishu-doc",
        fileName: `${parsed.type}-${parsed.token}`,
        extension: "",
        status: "failed",
        elapsedMs,
        detail,
      });
      return { success: false, detail };
    }
  }

  private buildUpdateArgs(
    url: string,
    command: FeishuUpdateCommand,
    content: string,
    options?: { heading?: string },
  ): string[] {
    switch (command) {
      case "append":
        return ["docs", "+update", "--url", url, "--action", "append", "--content", content];
      case "overwrite":
        return ["docs", "+update", "--url", url, "--action", "overwrite", "--content", content];
      case "replace":
        return ["docs", "+update", "--url", url, "--action", "str_replace", "--content", content];
      case "insertByHeading":
        return ["docs", "+update", "--url", url, "--action", "block_insert_after", "--heading", options?.heading ?? "", "--content", content];
      default:
        throw new Error(`不支持的写命令：${command}`);
    }
  }

  private execLarkCli(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("lark-cli", args, { timeout: 30_000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || stdout || error.message));
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }
}
