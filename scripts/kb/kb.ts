#!/usr/bin/env tsx
/**
 * 职责: 暴露本地知识库 CLI 的脚本入口。
 * 关注点:
 * - 把命令行参数直接转交给知识库本地 CLI。
 * - 根据执行结果设置退出码。
 */
import { printLocalCliResult, runKnowledgeCli } from "../../src/knowledge/local-cli.js";

const result = await runKnowledgeCli(process.argv.slice(2));
printLocalCliResult(result);
process.exitCode = result.ok ? 0 : 1;
