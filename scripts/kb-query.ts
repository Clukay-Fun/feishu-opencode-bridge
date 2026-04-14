#!/usr/bin/env tsx
import { printLocalCliResult, runKnowledgeCli } from "../src/knowledge/local-cli.js";

const result = await runKnowledgeCli(["query", ...process.argv.slice(2)]);
printLocalCliResult(result);
process.exitCode = result.ok ? 0 : 1;
