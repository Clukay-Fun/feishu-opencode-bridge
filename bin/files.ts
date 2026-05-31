#!/usr/bin/env node
/**
 * 职责: File Workspace CLI 入口。
 * 关注点:
 * - 让 OpenCode 和外部脚本可以直接调用 WorkspaceService。
 * - 默认输出 JSON，可切换 markdown/text。
 * - 错误输出 JSON 到 stderr，exit code 1。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { WorkspaceService } from "../src/workspace/service.js";
import { DocumentOperationJournal } from "../src/workspace/journal-db.js";
import { parseFeishuDocUrl } from "../src/workspace/feishu-doc-adapter.js";

const USAGE = `Usage: npm run files -- <command> [options]

Commands:
  read --input <path>                   解析文件，输出 JSON
  parse --input <path> [--format md]    解析文件，输出 Markdown
  journal [--status <s>] [--limit N]    查询 Journal
  fetch-feishu-doc --url <url>          读取飞书云文档

Options:
  --input <path>        输入文件路径
  --url <url>           飞书云文档 URL
  --format <json|md>    输出格式（默认 json）
  --status <status>     Journal 过滤状态
  --type <type>         Journal 过滤操作类型
  --limit <N>           结果数量限制（默认 50）
  --data-dir <path>     数据目录（默认 ./data）
`;

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    process.exit(0);
  }

  const dataDir = getArg(args, "--data-dir") ?? "./data";
  const format = getArg(args, "--format") ?? "json";

  try {
    switch (command) {
      case "read":
      case "parse": {
        const input = getArg(args, "--input");
        if (!input) throw new Error("--input 参数必填");
        const service = new WorkspaceService({ dataDir, logger: createSilentLogger() });
        const result = await service.parse({
          path: path.resolve(input),
          fileName: path.basename(input),
          source: "local-path",
        });
        service.close();
        if (command === "parse" && format === "md") {
          const single = Array.isArray(result) ? result[0] : result;
          console.log(single?.content.markdown ?? "");
        } else {
          outputJson(result);
        }
        break;
      }
      case "journal": {
        const journal = new DocumentOperationJournal(path.join(dataDir, "document-operations.db"));
        const query: Record<string, unknown> = {};
        const status = getArg(args, "--status");
        const type = getArg(args, "--type");
        const limitStr = getArg(args, "--limit");
        if (status) query.status = status;
        if (type) query.operationType = type;
        if (limitStr) query.limit = parseInt(limitStr, 10);
        const entries = journal.query(query);
        journal.close();
        outputJson(entries);
        break;
      }
      case "fetch-feishu-doc": {
        const url = getArg(args, "--url");
        if (!url) throw new Error("--url 参数必填");
        const journal = new DocumentOperationJournal(path.join(dataDir, "document-operations.db"));
        const { FeishuDocAdapter } = await import("../src/workspace/feishu-doc-adapter.js");
        const adapter = new FeishuDocAdapter(createSilentLogger(), journal);
        const result = await adapter.fetch(url);
        journal.close();
        outputJson(result);
        break;
      }
      default:
        throw new Error(`未知命令：${command}\n${USAGE}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(JSON.stringify({ error: "command_failed", detail }) + "\n");
    process.exit(1);
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function createSilentLogger() {
  return { log() {}, warn() {}, error() {}, logTranscript() {} };
}

main();
