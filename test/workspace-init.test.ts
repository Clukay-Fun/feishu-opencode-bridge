/**
 * 职责: 覆盖飞书 Base 工作区初始化脚本。
 * 关注点:
 * - 用 mock lark-cli 验证建表、建字段、公式重映射和配置写回。
 * - 避免测试触达真实飞书多维表格。
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { diagnoseWorkspace, initializeWorkspace, runWorkspaceDoctorCli } from "../scripts/workspace-init/workspace-init.mjs";

describe("workspace init", () => {
  it("keeps the committed workspace schema aligned with the current production table shape", async () => {
    const schema = JSON.parse(await readFile(path.resolve("scripts/workspace-init/current-workspace-schema.json"), "utf8"));

    expect(Object.fromEntries(schema.tables.map((table: { key: string; fields: unknown[] }) => [
      table.key,
      table.fields.length,
    ]))).toEqual({
      contract: 27,
      invoice: 12,
      case: 28,
      knowledge: 8,
    });
    const knowledgeTags = schema.tables
      .find((table: { key: string }) => table.key === "knowledge")
      .fields.find((field: { name: string }) => field.name === "标签");
    expect(knowledgeTags.options.length).toBeGreaterThan(900);
  });

  it("creates tables from schema, remaps formula ids, seeds sample records, and updates namespace config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-workspace-init-"));
    const configPath = path.join(dir, "config.json");
    const schemaPath = path.join(dir, "schema.json");
    await writeFile(configPath, JSON.stringify({
      feishu: { appId: "cli_xxx", appSecret: "secret" },
      extensions: {
        "knowledge-base": { enabled: false, storage: { bitable: {} } },
        "contract-assistant": { enabled: false, storage: {} },
        "custom-ext": { enabled: true },
      },
    }), "utf8");
    await writeFile(schemaPath, JSON.stringify(createTestSchema()), "utf8");

    const calls: string[][] = [];
    const runCommandFn = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[1] === "+base-create") {
        return ok({ data: { base: { app_token: "app_new" } } });
      }
      if (args[1] === "+table-create") {
        const name = args[args.indexOf("--name") + 1];
        const key = tableKeyByName(name);
        const fieldsJson = args.includes("--fields")
          ? JSON.parse(args[args.indexOf("--fields") + 1] ?? "[]")
          : [];
        return ok({
          data: {
            table: { table_id: `tbl_new_${key}` },
            fields: fieldsJson.map((field: { name: string }) => ({ name: field.name, id: `fld_new_${key}_primary` })),
          },
        });
      }
      if (args[1] === "+field-create") {
        const payload = JSON.parse(args[args.indexOf("--json") + 1] ?? "{}");
        return ok({ data: { field: { name: payload.name, id: `fld_new_${payload.name}` } } });
      }
      if (args[1] === "+record-batch-create") {
        return ok({ data: { record_id_list: ["rec_1"] } });
      }
      throw new Error(`unexpected command: ${args.join(" ")}`);
    });

    const result = await initializeWorkspace({
      cwd: dir,
      configPath,
      schemaPath,
      force: true,
      runCommandFn,
      findExecutableFn: () => "/tmp/lark-cli",
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.tableIds).toMatchObject({
      contract: "tbl_new_contract",
      invoice: "tbl_new_invoice",
      case: "tbl_new_case",
      knowledge: "tbl_new_knowledge",
    });
    const formulaCall = calls.find((args) => args[1] === "+field-create" && args.includes("--i-have-read-guide"));
    expect(formulaCall).toBeTruthy();
    const formulaPayload = JSON.parse(formulaCall?.[formulaCall.indexOf("--json") + 1] ?? "{}");
    expect(formulaPayload.expression).toBe("bitable::$table[tbl_new_contract].$field[fld_new_合同金额]*2");
    expect(calls.some((args) => args[1] === "+record-batch-create")).toBe(true);

    const updated = JSON.parse(await readFile(configPath, "utf8"));
    expect(updated.extensions["custom-ext"]).toEqual({ enabled: true });
    expect(updated.extensions["contract-assistant"].storage).toMatchObject({
      baseToken: "app_new",
      contractTableId: "tbl_new_contract",
      invoiceTableId: "tbl_new_invoice",
      caseTableId: "tbl_new_case",
    });
    expect(updated.extensions["knowledge-base"].storage.bitable).toMatchObject({
      appToken: "app_new",
      tableId: "tbl_new_knowledge",
    });
    const manifest = JSON.parse(await readFile(path.join(dir, "data", "init-seeds.json"), "utf8"));
    expect(manifest).toMatchObject({
      baseToken: "app_new",
      tableIds: {
        contract: "tbl_new_contract",
      },
      records: {
        contract: ["rec_1"],
      },
    });
    const onboardingState = JSON.parse(await readFile(path.join(dir, "data", "onboarding-state.json"), "utf8"));
    expect(onboardingState.workspaceInitializedAt).toEqual(expect.any(String));
  });

  it("does not overwrite existing workspace config without force", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-workspace-init-existing-"));
    const configPath = path.join(dir, "config.json");
    const schemaPath = path.join(dir, "schema.json");
    await mkdir(dir, { recursive: true });
    await writeFile(configPath, JSON.stringify({
      extensions: {
        "contract-assistant": {
          storage: { baseToken: "app_existing", contractTableId: "tbl_existing" },
        },
      },
    }), "utf8");
    await writeFile(schemaPath, JSON.stringify(createTestSchema()), "utf8");

    await expect(initializeWorkspace({
      cwd: dir,
      configPath,
      schemaPath,
      findExecutableFn: () => "/tmp/lark-cli",
      runCommandFn: vi.fn(),
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    })).rejects.toThrow("--force");
  });

  it("can skip starter records", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-workspace-init-no-sample-"));
    const configPath = path.join(dir, "config.json");
    const schemaPath = path.join(dir, "schema.json");
    await writeFile(configPath, JSON.stringify({ extensions: {} }), "utf8");
    await writeFile(schemaPath, JSON.stringify(createTestSchema()), "utf8");
    const calls: string[][] = [];
    const runCommandFn = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[1] === "+base-create") {
        return ok({ data: { base: { app_token: "app_new" } } });
      }
      if (args[1] === "+table-create") {
        const name = args[args.indexOf("--name") + 1];
        return ok({
          data: {
            table: { table_id: `tbl_${name}` },
            fields: [{ name: JSON.parse(args[args.indexOf("--fields") + 1] ?? "[]")[0].name, id: `fld_${name}` }],
          },
        });
      }
      return ok({ data: { field: { id: "fld_x", name: "x" } } });
    });

    await initializeWorkspace({
      cwd: dir,
      configPath,
      schemaPath,
      force: true,
      sampleData: false,
      runCommandFn,
      findExecutableFn: () => "/tmp/lark-cli",
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(calls.some((args) => args[1] === "+record-batch-create")).toBe(false);
  });

  it("resets starter records from the local seed manifest and ignores missing remote records", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-workspace-init-reset-"));
    const configPath = path.join(dir, "config.json");
    const schemaPath = path.join(dir, "schema.json");
    await mkdir(path.join(dir, "data"), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      storage: { dataDir: "./data" },
      extensions: {
        "knowledge-base": { storage: { bitable: { appToken: "app_existing", tableId: "tbl_knowledge" } } },
        "contract-assistant": {
          storage: {
            baseToken: "app_existing",
            contractTableId: "tbl_contract",
            invoiceTableId: "tbl_invoice",
            caseTableId: "tbl_case",
          },
        },
      },
    }), "utf8");
    await writeFile(path.join(dir, "data", "init-seeds.json"), JSON.stringify({
      schemaVersion: 1,
      baseToken: "app_existing",
      tableIds: { contract: "tbl_contract" },
      records: { contract: ["rec_missing", "rec_old"] },
    }), "utf8");
    await writeFile(schemaPath, JSON.stringify(createTestSchema()), "utf8");
    const calls: string[][] = [];
    const runCommandFn = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[1] === "+record-delete" && args.includes("rec_missing")) {
        return { code: 1, stdout: "", stderr: "not found", signal: null, timedOut: false };
      }
      if (args[1] === "+record-delete") {
        return ok({ deleted: true });
      }
      if (args[1] === "+record-batch-create") {
        return ok({ data: { record_id_list: ["rec_new"] } });
      }
      return ok({});
    });

    const result = await initializeWorkspace({
      cwd: dir,
      configPath,
      schemaPath,
      resetSampleData: true,
      runCommandFn,
      findExecutableFn: () => "/tmp/lark-cli",
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    expect(result.baseToken).toBe("app_existing");
    expect(calls.filter((args) => args[1] === "+record-delete")).toHaveLength(2);
    expect(calls.some((args) => args[1] === "+record-batch-create")).toBe(true);
    const manifest = JSON.parse(await readFile(path.join(dir, "data", "init-seeds.json"), "utf8"));
    expect(manifest.records.contract).toEqual(["rec_new"]);
  });

  it("diagnoses workspace field drift and scope failures", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-workspace-doctor-"));
    const configPath = path.join(dir, "config.json");
    const schemaPath = path.join(dir, "schema.json");
    await writeFile(configPath, JSON.stringify({
      extensions: {
        "knowledge-base": { storage: { bitable: { appToken: "app_existing", tableId: "tbl_knowledge" } } },
        "contract-assistant": {
          storage: {
            baseToken: "app_existing",
            contractTableId: "tbl_contract",
            invoiceTableId: "tbl_invoice",
            caseTableId: "tbl_case",
          },
        },
      },
    }), "utf8");
    await writeFile(schemaPath, JSON.stringify(createTestSchema()), "utf8");
    const runCommandFn = vi.fn(async (_command: string, args: string[]) => {
      if (args[1] === "+base-get") {
        return ok({ data: { base: { app_token: "app_existing" } } });
      }
      if (args[1] === "+table-list") {
        return ok({
          data: {
            items: [
              { table_id: "tbl_contract", table_name: "合同管理表" },
              { table_id: "tbl_invoice", table_name: "发票台账" },
              { table_id: "tbl_case", table_name: "案件管理表" },
              { table_id: "tbl_knowledge", table_name: "知识库问答" },
            ],
          },
        });
      }
      if (args[1] === "+field-list" && args.includes("tbl_invoice")) {
        return { code: 1, stdout: "", stderr: "RolePermNotAllow: missing scope", signal: null, timedOut: false };
      }
      if (args[1] === "+field-list") {
        return ok({ data: { fields: [{ name: "客户名称", type: "text" }] } });
      }
      return ok({});
    });

    const results = await diagnoseWorkspace({
      cwd: dir,
      configPath,
      schemaPath,
      runCommandFn,
      findExecutableFn: () => "/tmp/lark-cli",
    });

    expect(results.some((result: { status: string; detail: string }) => result.status === "fail" && result.detail.includes("缺字段"))).toBe(true);
    expect(results.some((result: { hint?: string }) => result.hint?.includes("base:table:read"))).toBe(true);
  });

  it("records workspace doctor summaries and prints recovery sections", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-workspace-doctor-state-"));
    const configPath = path.join(dir, "config.json");
    const schemaPath = path.join(dir, "schema.json");
    await writeFile(configPath, JSON.stringify({
      storage: { dataDir: "./data" },
      extensions: {
        "knowledge-base": { storage: { bitable: { appToken: "app_existing", tableId: "tbl_knowledge" } } },
        "contract-assistant": {
          storage: {
            baseToken: "app_existing",
            contractTableId: "tbl_contract",
            invoiceTableId: "tbl_invoice",
            caseTableId: "tbl_case",
          },
        },
      },
    }), "utf8");
    await writeFile(schemaPath, JSON.stringify(createTestSchema()), "utf8");
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runCommandFn = vi.fn(async (_command: string, args: string[]) => {
      if (args[1] === "+base-get") return ok({ data: { base: { app_token: "app_existing" } } });
      if (args[1] === "+table-list") {
        return ok({
          data: {
            items: [
              { table_id: "tbl_contract" },
              { table_id: "tbl_invoice" },
              { table_id: "tbl_case" },
              { table_id: "tbl_knowledge" },
            ],
          },
        });
      }
      return ok({ data: { fields: [] } });
    });

    const exitCode = await runWorkspaceDoctorCli([], {
      cwd: dir,
      configPath,
      schemaPath,
      runCommandFn,
      findExecutableFn: () => "/tmp/lark-cli",
      logger,
    });

    expect(exitCode).toBe(1);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("问题：缺字段"));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("可能原因："));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("修复命令："));
    const onboardingState = JSON.parse(await readFile(path.join(dir, "data", "onboarding-state.json"), "utf8"));
    expect(onboardingState.lastWorkspaceDoctor.status).toBe("fail");
    expect(onboardingState.lastWorkspaceDoctor.failedChecks.length).toBeGreaterThan(0);
  });
});

function createTestSchema() {
  return {
    schemaVersion: 1,
    name: "测试工作区",
    tables: [
      {
        key: "contract",
        name: "合同管理表",
        sourceTableId: "tbl_old_contract",
        fields: [
          { sourceFieldId: "fld_customer", name: "客户名称", type: "text" },
          { sourceFieldId: "fld_amount", name: "合同金额", type: "number" },
          {
            sourceFieldId: "fld_formula",
            name: "双倍金额",
            type: "formula",
            expression: "bitable::$table[tbl_old_contract].$field[fld_amount]*2",
          },
        ],
      },
      {
        key: "invoice",
        name: "发票台账",
        sourceTableId: "tbl_old_invoice",
        fields: [{ sourceFieldId: "fld_invoice", name: "发票号", type: "text" }],
      },
      {
        key: "case",
        name: "案件管理表",
        sourceTableId: "tbl_old_case",
        fields: [{ sourceFieldId: "fld_case", name: "案号", type: "text" }],
      },
      {
        key: "knowledge",
        name: "知识库问答",
        sourceTableId: "tbl_old_knowledge",
        fields: [{ sourceFieldId: "fld_question", name: "问题", type: "text" }],
      },
    ],
    sampleRecords: {
      contract: [{ 客户名称: "示例客户", 合同金额: 100 }],
    },
  };
}

function ok(stdout: unknown) {
  return {
    code: 0,
    stdout: JSON.stringify(stdout),
    stderr: "",
    signal: null,
    timedOut: false,
  };
}

function tableKeyByName(name: string | undefined): string {
  if (name === "合同管理表") return "contract";
  if (name === "发票台账") return "invoice";
  if (name === "案件管理表") return "case";
  if (name === "知识库问答") return "knowledge";
  throw new Error(`unexpected table name: ${name}`);
}
