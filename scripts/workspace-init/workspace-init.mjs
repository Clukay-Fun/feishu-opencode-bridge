/**
 * 职责: 基于内置多维表格结构初始化用户自己的飞书 Base 工作区。
 * 关注点:
 * - 通过 lark-cli 创建 Base、数据表、字段和可选初始化样例记录。
 * - 将新生成的 Base / Table 标识写回用户配置，不覆盖密钥和模型配置。
 * - 用本地 seed manifest 追踪初始化样例，避免 reset 误删用户真实数据。
 * - 保持所有飞书写操作可注入 runner，便于测试中 mock 而不触达真实飞书。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { findExecutable, isMainModule, readProjectConfig, runCommand } from "../runtime/checks.mjs";
import { markWorkspaceInitialized, recordWorkspaceDoctorResult } from "../runtime/onboarding-state.mjs";
import { resolveProjectConfigPath } from "../runtime/portable.mjs";

const DEFAULT_SCHEMA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "current-workspace-schema.json");
const SYSTEM_FIELD_TYPES = new Set(["created_at", "updated_at", "created_by", "modified_by", "auto_number"]);
const DEFERRED_FIELD_TYPES = new Set(["link", "formula"]);
const REQUIRED_WORKSPACE_SCOPES = [
  "bitable:app",
  "base:table:read",
  "base:table:write",
  "base:record:retrieve",
  "base:record:create",
  "base:record:update",
  "base:record:delete",
];

export async function runWorkspaceInitCli(args = process.argv.slice(2), options = {}) {
  const command = args[0];
  const logger = options.logger ?? console;
  try {
    if (command === "workspace") {
      const parsed = parseWorkspaceArgs(args.slice(1));
      const result = await initializeWorkspace({ ...options, ...parsed });
      logger.log(parsed.resetSampleData ? `已重置初始化样例：${result.seedManifestPath}` : `已创建 Base：${result.baseToken}`);
      logger.log(`合同表：${result.tableIds.contract}`);
      logger.log(`发票表：${result.tableIds.invoice}`);
      logger.log(`案件表：${result.tableIds.case}`);
      logger.log(`知识库表：${result.tableIds.knowledge}`);
      logger.log(parsed.resetSampleData ? `seed manifest 已更新：${result.seedManifestPath}` : `配置已更新：${result.configPath}`);
      logger.log("");
      logger.log("推荐下一步：");
      logger.log("  1. bridge doctor workspace");
      logger.log("  2. bridge start");
      logger.log("  3. 回到飞书发送 /help");
      logger.log(`初始化样例 manifest：${result.seedManifestPath}`);
      logger.log("需要重建初始化样例时运行：bridge init workspace --reset-sample-data");
      return 0;
    }

    if (command === "export-schema") {
      const parsed = parseExportArgs(args.slice(1));
      const result = await exportWorkspaceSchema({ ...options, ...parsed });
      logger.log(`已导出工作区 schema：${result.outputPath}`);
      return 0;
    }

    logger.error("用法: bridge init <workspace|export-schema>");
    return 1;
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function runWorkspaceDoctorCli(args = [], options = {}) {
  const logger = options.logger ?? console;
  try {
    if (args.length > 0) {
      throw new Error(`未知参数: ${args.join(" ")}`);
    }
    const results = await diagnoseWorkspace(options);
    if (options.statePath) {
      await recordWorkspaceDoctorResult(options.statePath, results);
    } else {
      const statePath = await resolveWorkspaceOnboardingStatePath(options);
      if (statePath) {
        await recordWorkspaceDoctorResult(statePath, results);
      }
    }
    logger.log("### Workspace");
    for (const result of results) {
      logger.log(formatWorkspaceCheckLine(result));
      if (result.hint) {
        logger.log(`     → ${result.hint}`);
      }
      if (result.status === "fail") {
        logger.log(`     问题：${result.detail}`);
        logger.log(`     可能原因：${workspaceCauseForResult(result)}`);
        logger.log(`     修复命令：${workspaceFixForResult(result)}`);
      }
    }
    return results.some((result) => result.status === "fail") ? 1 : 0;
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

export async function initializeWorkspace(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;
  const configPath = options.configPath ?? resolveProjectConfigPath(cwd, env);
  const schema = await readWorkspaceSchema(options.schemaPath ?? DEFAULT_SCHEMA_PATH);
  const larkCliPath = resolveLarkCli({ cwd, env, findExecutableFn: options.findExecutableFn });
  const configState = await readProjectConfig(cwd, configPath);
  if (!configState.exists || !configState.config) {
    throw new Error(`缺少可用的 config.json：${configPath}，请先运行 bridge onboard。`);
  }

  const lark = createLarkRunner({
    cwd,
    env,
    larkCliPath,
    runCommandFn: options.runCommandFn ?? runCommand,
  });
  const seedManifestPath = resolveSeedManifestPath(configState.config, configPath);

  if (options.resetSampleData === true) {
    const current = readWorkspaceConfig(configState.config);
    ensureWorkspaceConfigured(current);
    await resetSampleRecords({
      lark,
      schema,
      baseToken: current.baseToken,
      tableIds: { __baseToken: current.baseToken, ...current.tableIds },
      seedManifestPath,
      logger,
    });
    return {
      baseToken: current.baseToken,
      tableIds: current.tableIds,
      configPath,
      seedManifestPath,
    };
  }

  ensureCanWriteWorkspaceConfig(configState.config, options.force === true);

  logger.log(`正在创建多维表格工作区：${schema.name}`);
  const baseResponse = await lark(["base", "+base-create", "--name", options.name ?? schema.name, "--time-zone", "Asia/Shanghai"]);
  const baseToken = extractBaseToken(baseResponse);
  const tableIds = { __baseToken: baseToken };
  const fieldIds = {};
  const skippedReverseLinks = new Set();

  for (const table of schema.tables) {
    const primaryField = pickPrimaryField(table);
    const createArgs = ["base", "+table-create", "--base-token", baseToken, "--name", table.name];
    if (primaryField) {
      createArgs.push("--fields", JSON.stringify([toCreateFieldPayload(primaryField, { tableIds, fieldIds, schema })]));
    }
    const tableResponse = await lark(createArgs);
    const tableId = extractTableId(tableResponse);
    tableIds[table.key] = tableId;
    if (primaryField) {
      const primaryFieldId = extractFieldId(tableResponse, primaryField.name);
      if (primaryFieldId) {
        fieldIds[primaryField.sourceFieldId] = primaryFieldId;
      }
    }
    logger.log(`已创建数据表：${table.name} (${tableId})`);
  }

  for (const table of schema.tables) {
    const primaryField = pickPrimaryField(table);
    for (const field of table.fields) {
      if (shouldSkipField(field, primaryField)) {
        continue;
      }
      if (DEFERRED_FIELD_TYPES.has(field.type)) {
        continue;
      }
      await createField({ lark, schema, table, field, tableIds, fieldIds });
    }
  }

  for (const table of schema.tables) {
    for (const field of table.fields) {
      if (field.type !== "link" || skippedReverseLinks.has(field.sourceFieldId)) {
        continue;
      }
      const reverseField = findReverseLinkField(schema, field);
      if (reverseField && field.bidirectional) {
        skippedReverseLinks.add(reverseField.sourceFieldId);
      }
      await createField({ lark, schema, table, field, tableIds, fieldIds, reverseField });
    }
  }

  for (const table of schema.tables) {
    for (const field of table.fields) {
      if (field.type === "formula") {
        await createField({ lark, schema, table, field, tableIds, fieldIds });
      }
    }
  }

  if (options.sampleData !== false) {
    const manifest = await createSampleRecords({ lark, schema, baseToken, tableIds });
    await writeSeedManifest(seedManifestPath, manifest);
  }

  const updatedConfig = updateWorkspaceConfig(configState.config, {
    baseToken,
    tableIds,
  });
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(updatedConfig, null, 2)}\n`, "utf8");
  await markWorkspaceInitialized(resolveSeedManifestPath(updatedConfig, configPath).replace(/init-seeds\.json$/, "onboarding-state.json"));

  return {
    baseToken,
    tableIds,
    configPath,
    seedManifestPath,
  };
}

export async function diagnoseWorkspace(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? resolveProjectConfigPath(cwd, env);
  const schema = await readWorkspaceSchema(options.schemaPath ?? DEFAULT_SCHEMA_PATH);
  const results = [];
  const configState = await readProjectConfig(cwd, configPath);
  if (!configState.exists || !configState.config) {
    return [workspaceResult("config", "配置文件", "fail", `缺少可用的 config.json：${configPath}`, "先运行 bridge onboard")];
  }

  const current = readWorkspaceConfig(configState.config);
  if (!current.baseToken) {
    results.push(workspaceResult("base-config", "Base 配置", "fail", "缺少 Base token", "运行 bridge init workspace"));
    return results;
  }
  results.push(workspaceResult("base-config", "Base 配置", "pass", `baseToken=${current.baseToken}`));

  const larkCliPath = resolveLarkCli({ cwd, env, findExecutableFn: options.findExecutableFn });
  const runCommandFn = options.runCommandFn ?? runCommand;
  const baseCheck = await runLarkJsonSafe({ cwd, env, larkCliPath, runCommandFn, args: ["base", "+base-get", "--base-token", current.baseToken] });
  if (!baseCheck.ok) {
    results.push(workspaceResult("base-access", "Base 访问", "fail", baseCheck.error, workspaceHintForError(baseCheck.error)));
    return results;
  }
  results.push(workspaceResult("base-access", "Base 访问", "pass", "Base 可访问"));

  const tableList = await runLarkJsonSafe({ cwd, env, larkCliPath, runCommandFn, args: ["base", "+table-list", "--base-token", current.baseToken, "--offset", "0", "--limit", "100"] });
  if (!tableList.ok) {
    results.push(workspaceResult("table-list", "表列表", "fail", tableList.error, workspaceHintForError(tableList.error)));
    return results;
  }
  const remoteTables = extractTables(tableList.data);
  for (const table of schema.tables) {
    const tableId = current.tableIds[table.key];
    if (!tableId) {
      results.push(workspaceResult(`${table.key}-table-config`, `${table.name}`, "fail", "配置缺少 tableId", "运行 bridge init workspace --force 重新写入工作区配置"));
      continue;
    }
    const remote = remoteTables.find((item) => item.table_id === tableId || item.tableId === tableId);
    if (!remote) {
      results.push(workspaceResult(`${table.key}-table`, `${table.name}`, "fail", `Base 中未找到表 ${tableId}`, "确认 config.json 中的 tableId，或重新运行 bridge init workspace --force"));
      continue;
    }
    const fieldCheck = await runLarkJsonSafe({ cwd, env, larkCliPath, runCommandFn, args: ["base", "+field-list", "--base-token", current.baseToken, "--table-id", tableId, "--offset", "0", "--limit", "200"] });
    if (!fieldCheck.ok) {
      results.push(workspaceResult(`${table.key}-fields`, `${table.name} 字段`, "fail", fieldCheck.error, workspaceHintForError(fieldCheck.error)));
      continue;
    }
    const fieldResult = compareWorkspaceFields(table, extractFields(fieldCheck.data));
    results.push(workspaceResult(
      `${table.key}-fields`,
      `${table.name} 字段`,
      fieldResult.ok ? "pass" : "fail",
      fieldResult.detail,
      fieldResult.ok ? undefined : "字段结构不一致；建议创建新的工作区并用 --force 指向新 Base",
    ));
  }
  return results;
}

export async function exportWorkspaceSchema(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? resolveProjectConfigPath(cwd, env);
  const configState = await readProjectConfig(cwd, configPath);
  if (!configState.exists || !configState.config) {
    throw new Error(`缺少可用的 config.json：${configPath}`);
  }
  const current = readWorkspaceConfig(configState.config);
  if (!current.baseToken || !current.tableIds.contract || !current.tableIds.invoice || !current.tableIds.case || !current.tableIds.knowledge) {
    throw new Error("当前配置缺少 contract / invoice / case / knowledge 表 ID，无法导出 schema。");
  }

  const larkCliPath = resolveLarkCli({ cwd, env, findExecutableFn: options.findExecutableFn });
  const lark = createLarkRunner({
    cwd,
    env,
    larkCliPath,
    runCommandFn: options.runCommandFn ?? runCommand,
  });
  const tables = [];
  for (const table of [
    { key: "contract", name: "合同管理表", tableId: current.tableIds.contract },
    { key: "invoice", name: "发票台账", tableId: current.tableIds.invoice },
    { key: "case", name: "案件管理表", tableId: current.tableIds.case },
    { key: "knowledge", name: "知识库问答", tableId: current.tableIds.knowledge },
  ]) {
    const response = await lark([
      "base",
      "+field-list",
      "--base-token",
      current.baseToken,
      "--table-id",
      table.tableId,
      "--offset",
      "0",
      "--limit",
      "100",
    ]);
    const fields = extractFields(response).map((field) => normalizeExportedField(field));
    for (const field of fields) {
      if (field.type === "select" && field.remaining_options_count > 0) {
        field.options = await readAllFieldOptions({ lark, baseToken: current.baseToken, tableId: table.tableId, fieldId: field.sourceFieldId });
        delete field.remaining_options_count;
      }
    }
    tables.push({
      key: table.key,
      name: table.name,
      sourceTableId: table.tableId,
      fields,
    });
  }

  const schema = {
    schemaVersion: 1,
    name: "飞书 OpenCode Bridge 工作区",
    description: "基于维护者真实合同、发票、案件与知识库多维表格结构生成。",
    tables,
    sampleRecords: {},
  };
  const outputPath = path.resolve(cwd, options.outputPath ?? DEFAULT_SCHEMA_PATH);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(schema, null, 2)}\n`, "utf8");
  return { outputPath };
}

function parseWorkspaceArgs(args) {
  const result = {
    force: false,
    sampleData: true,
    resetSampleData: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--force") {
      result.force = true;
    } else if (value === "--reset-sample-data") {
      result.resetSampleData = true;
    } else if (value === "--no-sample-data") {
      result.sampleData = false;
    } else if (value === "--schema") {
      result.schemaPath = args[++index];
    } else if (value === "--name") {
      result.name = args[++index];
    } else {
      throw new Error(`未知参数: ${value}`);
    }
  }
  return result;
}

function parseExportArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--output") {
      result.outputPath = args[++index];
    } else {
      throw new Error(`未知参数: ${value}`);
    }
  }
  return result;
}

async function readWorkspaceSchema(schemaPath) {
  const raw = JSON.parse(await readFile(schemaPath, "utf8"));
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.tables)) {
    throw new Error(`workspace schema 不合法：${schemaPath}`);
  }
  return raw;
}

function resolveLarkCli({ cwd, env, findExecutableFn = findExecutable }) {
  const larkCliPath = findExecutableFn("lark-cli", { cwd, env });
  if (!larkCliPath) {
    throw new Error("未检测到 lark-cli，请先运行 bridge onboard 或 lark-cli auth login --recommend。");
  }
  return larkCliPath;
}

function createLarkRunner({ cwd, env, larkCliPath, runCommandFn }) {
  const runner = async (args) => {
    const result = await runCommandFn(larkCliPath, args, {
      cwd,
      env,
      timeoutMs: 120_000,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `lark-cli ${args.join(" ")} 执行失败`);
    }
    return parseJsonOutput(result.stdout, args);
  };
  runner.raw = async (args) => await runCommandFn(larkCliPath, args, {
    cwd,
    env,
    timeoutMs: 120_000,
  });
  return runner;
}

function parseJsonOutput(stdout, args) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`lark-cli ${args.join(" ")} 未返回 JSON。`);
  }
}

function ensureCanWriteWorkspaceConfig(config, force) {
  const current = readWorkspaceConfig(config);
  const hasExisting = Boolean(
    current.baseToken
      || current.tableIds.contract
      || current.tableIds.invoice
      || current.tableIds.case
      || current.tableIds.knowledge,
  );
  if (hasExisting && !force) {
    throw new Error("config.json 已存在多维表格配置；如需覆盖，请重新执行 bridge init workspace --force。");
  }
}

function ensureWorkspaceConfigured(current) {
  if (!current.baseToken || !current.tableIds.contract || !current.tableIds.invoice || !current.tableIds.case || !current.tableIds.knowledge) {
    throw new Error("当前配置缺少完整工作区信息，无法重置初始化样例；请先运行 bridge init workspace。");
  }
}

function readWorkspaceConfig(config) {
  const extensions = asRecord(config.extensions);
  const contract = asRecord(extensions["contract-assistant"] ?? config.contractAssistant);
  const contractStorage = asRecord(contract.storage);
  const knowledge = asRecord(extensions["knowledge-base"] ?? config.knowledgeBase);
  const knowledgeStorage = asRecord(asRecord(knowledge.storage).bitable);
  return {
    baseToken: asString(contractStorage.baseToken) || asString(knowledgeStorage.appToken),
    tableIds: {
      contract: asString(contractStorage.contractTableId),
      invoice: asString(contractStorage.invoiceTableId),
      case: asString(contractStorage.caseTableId),
      knowledge: asString(knowledgeStorage.tableId),
    },
  };
}

function updateWorkspaceConfig(config, workspace) {
  const next = deepClone(config);
  const useNamespace = next.extensions && typeof next.extensions === "object" && !Array.isArray(next.extensions);
  if (useNamespace) {
    next.extensions["contract-assistant"] = {
      ...asRecord(next.extensions["contract-assistant"]),
      storage: {
        ...asRecord(asRecord(next.extensions["contract-assistant"]).storage),
        baseToken: workspace.baseToken,
        contractTableId: workspace.tableIds.contract,
        invoiceTableId: workspace.tableIds.invoice,
        caseTableId: workspace.tableIds.case,
      },
    };
    next.extensions["knowledge-base"] = {
      ...asRecord(next.extensions["knowledge-base"]),
      storage: {
        ...asRecord(asRecord(next.extensions["knowledge-base"]).storage),
        bitable: {
          ...asRecord(asRecord(asRecord(next.extensions["knowledge-base"]).storage).bitable),
          appToken: workspace.baseToken,
          tableId: workspace.tableIds.knowledge,
        },
      },
    };
    return next;
  }

  next.contractAssistant = {
    ...asRecord(next.contractAssistant),
    storage: {
      ...asRecord(asRecord(next.contractAssistant).storage),
      baseToken: workspace.baseToken,
      contractTableId: workspace.tableIds.contract,
      invoiceTableId: workspace.tableIds.invoice,
      caseTableId: workspace.tableIds.case,
    },
  };
  next.knowledgeBase = {
    ...asRecord(next.knowledgeBase),
    storage: {
      ...asRecord(asRecord(next.knowledgeBase).storage),
      bitable: {
        ...asRecord(asRecord(asRecord(next.knowledgeBase).storage).bitable),
        appToken: workspace.baseToken,
        tableId: workspace.tableIds.knowledge,
      },
    },
  };
  return next;
}

async function createField({ lark, schema, table, field, tableIds, fieldIds, reverseField }) {
  const args = [
    "base",
    "+field-create",
    "--base-token",
    tableIds.__baseToken ?? "",
    "--table-id",
    tableIds[table.key],
    "--json",
    JSON.stringify(toCreateFieldPayload(field, { tableIds, fieldIds, schema, reverseField })),
  ];
  if (field.type === "formula") {
    args.push("--i-have-read-guide");
  }
  const response = await lark(args);
  const fieldId = extractFieldId(response, field.name);
  if (fieldId) {
    fieldIds[field.sourceFieldId] = fieldId;
  }
}

async function resetSampleRecords({ lark, schema, baseToken, tableIds, seedManifestPath, logger }) {
  const existing = await readSeedManifest(seedManifestPath);
  if (existing) {
    for (const [tableKey, recordIds] of Object.entries(existing.records ?? {})) {
      const tableId = existing.tableIds?.[tableKey];
      if (!tableId || !Array.isArray(recordIds)) {
        continue;
      }
      for (const recordId of recordIds) {
        const result = await lark.raw([
          "base",
          "+record-delete",
          "--base-token",
          existing.baseToken,
          "--table-id",
          tableId,
          "--record-id",
          recordId,
          "--yes",
        ]);
        if (result.code !== 0) {
          logger?.warn?.(`初始化样例记录已不存在或无法删除，跳过：${tableKey}/${recordId}`);
        }
      }
    }
  }

  const manifest = await createSampleRecords({ lark, schema, baseToken, tableIds });
  await writeSeedManifest(seedManifestPath, manifest);
}

async function resolveWorkspaceOnboardingStatePath(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const configPath = options.configPath ?? resolveProjectConfigPath(cwd, env);
  const configState = await readProjectConfig(cwd, configPath);
  if (!configState.exists || !configState.config) {
    return null;
  }
  return resolveSeedManifestPath(configState.config, configPath).replace(/init-seeds\.json$/, "onboarding-state.json");
}

async function createSampleRecords({ lark, schema, baseToken, tableIds }) {
  const samples = schema.sampleRecords && typeof schema.sampleRecords === "object"
    ? schema.sampleRecords
    : {};
  const records = {};
  for (const table of schema.tables) {
    const rows = Array.isArray(samples[table.key]) ? samples[table.key] : [];
    if (rows.length === 0) {
      continue;
    }
    const fields = Object.keys(rows[0]);
    const response = await lark([
      "base",
      "+record-batch-create",
      "--base-token",
      baseToken,
      "--table-id",
      tableIds[table.key],
      "--json",
      JSON.stringify({
        fields,
        rows: rows.map((row) => fields.map((field) => row[field] ?? null)),
      }),
    ]);
    records[table.key] = extractRecordIds(response);
  }
  return {
    schemaVersion: schema.schemaVersion,
    createdAt: new Date().toISOString(),
    baseToken,
    tableIds: pickWorkspaceTableIds(tableIds),
    records,
  };
}

function pickPrimaryField(table) {
  return table.fields.find((field) => field.type === "text")
    ?? table.fields.find((field) => !SYSTEM_FIELD_TYPES.has(field.type) && !DEFERRED_FIELD_TYPES.has(field.type));
}

function shouldSkipField(field, primaryField) {
  return SYSTEM_FIELD_TYPES.has(field.type) || field.sourceFieldId === primaryField?.sourceFieldId;
}

function toCreateFieldPayload(field, context) {
  const payload = deepClone(field);
  delete payload.sourceFieldId;
  delete payload.remaining_options_count;
  if (payload.type === "link") {
    payload.link_table = context.tableIds[findTableKeyBySourceId(context.schema, field.link_table)] ?? field.link_table;
    if (field.bidirectional && context.reverseField) {
      delete payload.bidirectional_link_field_id;
      payload.bidirectional_link_field_name = context.reverseField.name;
    } else {
      delete payload.bidirectional_link_field_id;
    }
  }
  if (payload.type === "formula") {
    payload.expression = remapFormulaExpression(payload.expression, context.schema, context.tableIds, context.fieldIds);
  }
  if (payload.type === "select" && Array.isArray(payload.options)) {
    payload.options = payload.options.map((option) => ({
      name: option.name,
      hue: option.hue,
      lightness: option.lightness,
    }));
  }
  return payload;
}

function remapFormulaExpression(expression, schema, tableIds, fieldIds) {
  return String(expression)
    .replace(/\$table\[([^\]]+)\]/g, (_match, sourceTableId) => {
      const tableKey = findTableKeyBySourceId(schema, sourceTableId);
      const tableId = tableIds[tableKey];
      if (!tableId) {
        throw new Error(`公式引用的表尚未创建，无法重映射：${sourceTableId}`);
      }
      return `$table[${tableId}]`;
    })
    .replace(/\$field\[([^\]]+)\]/g, (_match, sourceFieldId) => {
      const fieldId = fieldIds[sourceFieldId];
      if (!fieldId) {
        throw new Error(`公式引用的字段尚未创建，无法重映射：${sourceFieldId}`);
      }
      return `$field[${fieldId}]`;
    });
}

function findTableKeyBySourceId(schema, sourceTableId) {
  return schema.tables.find((table) => table.sourceTableId === sourceTableId)?.key ?? sourceTableId;
}

function findReverseLinkField(schema, field) {
  if (!field.bidirectional_link_field_id) {
    return undefined;
  }
  for (const table of schema.tables) {
    const reverse = table.fields.find((candidate) => candidate.sourceFieldId === field.bidirectional_link_field_id);
    if (reverse) {
      return reverse;
    }
  }
  return undefined;
}

function extractBaseToken(response) {
  return findStringByKeys(response, ["base_token", "app_token", "baseToken", "appToken"])
    ?? failExtract("Base token", response);
}

function extractTableId(response) {
  return findStringByKeys(response, ["table_id", "tableId"])
    ?? failExtract("table_id", response);
}

function extractFieldId(response, fieldName) {
  const fields = extractFields(response);
  const matched = fields.find((field) => field.name === fieldName);
  return matched ? asString(matched.id ?? matched.field_id ?? matched.fieldId) : findStringByKeys(response, ["field_id", "fieldId", "id"]);
}

function extractFields(response) {
  if (Array.isArray(response?.data?.fields)) {
    return response.data.fields;
  }
  if (Array.isArray(response?.fields)) {
    return response.fields;
  }
  if (response?.data?.field) {
    return [response.data.field];
  }
  if (response?.field) {
    return [response.field];
  }
  return [];
}

function extractTables(response) {
  if (Array.isArray(response?.data?.items)) {
    return response.data.items;
  }
  if (Array.isArray(response?.items)) {
    return response.items;
  }
  if (Array.isArray(response?.data?.tables)) {
    return response.data.tables;
  }
  if (Array.isArray(response?.tables)) {
    return response.tables;
  }
  return [];
}

function extractRecordIds(response) {
  if (Array.isArray(response?.data?.record_id_list)) {
    return response.data.record_id_list;
  }
  if (Array.isArray(response?.record_id_list)) {
    return response.record_id_list;
  }
  if (Array.isArray(response?.data?.records)) {
    return response.data.records.map((record) => record.record_id ?? record.recordId ?? record.id).filter(Boolean);
  }
  return [];
}

async function readSeedManifest(seedManifestPath) {
  try {
    return JSON.parse(await readFile(seedManifestPath, "utf8"));
  } catch {
    return null;
  }
}

async function writeSeedManifest(seedManifestPath, manifest) {
  await mkdir(path.dirname(seedManifestPath), { recursive: true });
  await writeFile(seedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function resolveSeedManifestPath(config, configPath) {
  const dataDir = asString(asRecord(config.storage).dataDir) || "./data";
  const resolvedDataDir = path.isAbsolute(dataDir) ? dataDir : path.resolve(path.dirname(configPath), dataDir);
  return path.join(resolvedDataDir, "init-seeds.json");
}

function pickWorkspaceTableIds(tableIds) {
  return {
    contract: tableIds.contract,
    invoice: tableIds.invoice,
    case: tableIds.case,
    knowledge: tableIds.knowledge,
  };
}

function compareWorkspaceFields(schemaTable, actualFields) {
  const actualByName = new Map(actualFields.map((field) => [field.name, field]));
  const missing = [];
  const mismatched = [];
  for (const expected of schemaTable.fields) {
    if (SYSTEM_FIELD_TYPES.has(expected.type)) {
      continue;
    }
    const actual = actualByName.get(expected.name);
    if (!actual) {
      missing.push(expected.name);
      continue;
    }
    if (actual.type && actual.type !== expected.type) {
      mismatched.push(`${expected.name}: ${actual.type} != ${expected.type}`);
    }
  }
  if (missing.length === 0 && mismatched.length === 0) {
    return { ok: true, detail: `字段结构正常（${actualFields.length} 个字段）` };
  }
  return {
    ok: false,
    detail: [
      missing.length > 0 ? `缺字段：${missing.join("、")}` : "",
      mismatched.length > 0 ? `类型不符：${mismatched.join("、")}` : "",
    ].filter(Boolean).join("; "),
  };
}

async function runLarkJsonSafe({ cwd, env, larkCliPath, runCommandFn, args }) {
  const result = await runCommandFn(larkCliPath, args, {
    cwd,
    env,
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    return {
      ok: false,
      error: result.stderr || result.stdout || `lark-cli ${args.join(" ")} 执行失败`,
    };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: `lark-cli ${args.join(" ")} 未返回 JSON` };
  }
}

function workspaceHintForError(error) {
  if (/scope|permission|RolePermNotAllow|Forbidden|权限|授权|Permission/i.test(error)) {
    return `检查飞书开放平台应用权限并发布版本，然后重新执行 lark-cli auth login --recommend；需要 scopes: ${REQUIRED_WORKSPACE_SCOPES.join(", ")}；入口：https://open.feishu.cn/app`;
  }
  return "确认 lark-cli 已完成用户授权，并检查 Base token / tableId 是否正确";
}

function workspaceCauseForResult(result) {
  if (/scope|permission|RolePermNotAllow|Forbidden|权限|授权|Permission/i.test(`${result.detail} ${result.hint ?? ""}`)) {
    return "飞书应用缺少 Bitable/Base scope，或应用权限更新后尚未发布并重新授权。";
  }
  if (result.id.includes("table")) {
    return "config.json 指向的 Base / Table 与当前飞书工作区不一致。";
  }
  if (result.id.includes("field")) {
    return "表字段被手动改名、删除或字段类型与初始化 schema 不一致。";
  }
  return "本地配置缺失、飞书授权未完成，或当前账号无权访问该 Base。";
}

function workspaceFixForResult(result) {
  if (/scope|permission|RolePermNotAllow|Forbidden|权限|授权|Permission/i.test(`${result.detail} ${result.hint ?? ""}`)) {
    return "在飞书开放平台补充 scope 并发布版本，然后运行 lark-cli auth login --recommend，再运行 bridge doctor workspace。";
  }
  if (result.id.includes("field") || result.id.includes("table")) {
    return "确认远端表结构；需要切换到新工作区时运行 bridge init workspace --force。";
  }
  return "运行 bridge doctor workspace 查看工作区状态，必要时重新运行 bridge onboard。";
}

function workspaceResult(id, label, status, detail, hint) {
  return {
    id,
    label,
    status,
    detail,
    ...(hint ? { hint } : {}),
  };
}

function formatWorkspaceCheckLine(result) {
  const icon = result.status === "pass" ? "✅" : result.status === "warn" ? "⚠️" : result.status === "skip" ? "--" : "❌";
  return `[${icon}] ${result.label.padEnd(16, " ")} ${result.detail}`;
}

async function readAllFieldOptions({ lark, baseToken, tableId, fieldId }) {
  const options = [];
  for (let offset = 0; offset < 10_000; offset += 200) {
    const response = await lark([
      "base",
      "+field-search-options",
      "--base-token",
      baseToken,
      "--table-id",
      tableId,
      "--field-id",
      fieldId,
      "--offset",
      String(offset),
      "--limit",
      "200",
    ]);
    const page = response.data?.options ?? response.options ?? [];
    options.push(...page.map((option) => ({
      name: option.name,
      hue: option.hue,
      lightness: option.lightness,
    })));
    if (page.length < 200) {
      break;
    }
  }
  return options;
}

function normalizeExportedField(field) {
  const next = deepClone(field);
  next.sourceFieldId = next.id ?? next.field_id;
  delete next.id;
  delete next.field_id;
  if (Array.isArray(next.options)) {
    next.options = next.options.map((option) => ({
      name: option.name,
      hue: option.hue,
      lightness: option.lightness,
    }));
  }
  return next;
}

function findStringByKeys(value, keys) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  for (const child of Object.values(value)) {
    const found = findStringByKeys(child, keys);
    if (found) {
      return found;
    }
  }
  return undefined;
}

function failExtract(label, response) {
  throw new Error(`无法从 lark-cli 返回中读取 ${label}: ${JSON.stringify(response).slice(0, 500)}`);
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asString(value) {
  return typeof value === "string" ? value : "";
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runWorkspaceInitCli();
}
