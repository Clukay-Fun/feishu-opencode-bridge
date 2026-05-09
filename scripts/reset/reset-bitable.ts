#!/usr/bin/env tsx
/**
 * 职责: 清空 contract-assistant 三张多维表格的 records，保留表结构。
 * 关注点:
 * - 仅清理 contract / invoice / case 三张表，KB 表硬隔离不可清。
 * - 默认 dry-run，需要 --yes 才真正删除。
 * - 按 500 条/批走 batchDelete API；分页拉取所有 records。
 * 用法:
 *   tsx scripts/reset/reset-bitable.ts            # dry run
 *   tsx scripts/reset/reset-bitable.ts --yes      # 实际执行
 *   tsx scripts/reset/reset-bitable.ts --config ./other.json
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const KB_TABLE_GUARD = "tblnAdncdOs8Aq6C";
const TARGETS: Array<{ name: string; configKey: string }> = [
  { name: "contract", configKey: "contractTableId" },
  { name: "invoice", configKey: "invoiceTableId" },
  { name: "case", configKey: "caseTableId" },
];

type RecordItem = { record_id: string };
type ListResp = {
  code: number;
  msg: string;
  data?: { items?: RecordItem[]; page_token?: string; has_more?: boolean };
};

function parseArgs(): { configPath: string; yes: boolean } {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--config");
  return {
    configPath: idx >= 0 ? (args[idx + 1] ?? "./config.json") : "./config.json",
    yes: args.includes("--yes"),
  };
}

async function getTenantToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json() as { code: number; msg: string; tenant_access_token?: string };
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`get tenant_access_token failed: code=${data.code} msg=${data.msg}`);
  }
  return data.tenant_access_token;
}

async function listAllRecords(token: string, appToken: string, tableId: string): Promise<RecordItem[]> {
  const all: RecordItem[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    );
    url.searchParams.set("page_size", "500");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json() as ListResp;
    if (data.code !== 0) {
      throw new Error(`list records failed (${tableId}): code=${data.code} msg=${data.msg}`);
    }
    if (data.data?.items) all.push(...data.data.items);
    pageToken = data.data?.has_more ? data.data?.page_token : undefined;
  } while (pageToken);
  return all;
}

async function batchDelete(
  token: string,
  appToken: string,
  tableId: string,
  recordIds: string[],
): Promise<void> {
  if (tableId === KB_TABLE_GUARD) {
    throw new Error(`refused to delete from KB table ${tableId}`);
  }
  for (let i = 0; i < recordIds.length; i += 500) {
    const chunk = recordIds.slice(i, i + 500);
    const res = await fetch(
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_delete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ records: chunk }),
      },
    );
    const data = await res.json() as { code: number; msg: string };
    if (data.code !== 0) {
      throw new Error(`batch_delete failed (${tableId}): code=${data.code} msg=${data.msg}`);
    }
    console.log(`    deleted ${chunk.length} (cumulative ${i + chunk.length}/${recordIds.length})`);
  }
}

async function main(): Promise<void> {
  const { configPath, yes } = parseArgs();
  const config = JSON.parse(readFileSync(resolve(configPath), "utf-8")) as {
    feishu?: { appId?: string; appSecret?: string };
    extensions?: { "contract-assistant"?: { storage?: Record<string, string> } };
  };

  const appId = config.feishu?.appId;
  const appSecret = config.feishu?.appSecret;
  const storage = config.extensions?.["contract-assistant"]?.storage ?? {};
  const baseToken = storage["baseToken"];

  if (!appId || !appSecret) throw new Error("missing feishu.appId / feishu.appSecret in config");
  if (!baseToken) throw new Error("missing extensions.contract-assistant.storage.baseToken");

  const targets = TARGETS
    .map((t) => ({ name: t.name, tableId: storage[t.configKey] }))
    .filter((t): t is { name: string; tableId: string } => Boolean(t.tableId));

  if (targets.some((t) => t.tableId === KB_TABLE_GUARD)) {
    throw new Error("refusing: KB table found in clear list");
  }

  console.log(`mode: ${yes ? "LIVE" : "DRY RUN (use --yes to execute)"}`);
  console.log(`base: ${baseToken}`);
  console.log(`KB guard: ${KB_TABLE_GUARD} (will not be touched)`);
  console.log("targets:");
  for (const t of targets) console.log(`  - ${t.name}: ${t.tableId}`);
  console.log("");

  const token = await getTenantToken(appId, appSecret);

  for (const t of targets) {
    console.log(`[${t.name}] listing records...`);
    const records = await listAllRecords(token, baseToken, t.tableId);
    console.log(`[${t.name}] found ${records.length} records`);
    if (records.length === 0) continue;
    if (!yes) {
      console.log(`[${t.name}] dry run, skip delete`);
      continue;
    }
    await batchDelete(token, baseToken, t.tableId, records.map((r) => r.record_id));
  }

  console.log(yes ? "\nall done" : "\n(dry run complete — pass --yes to execute)");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
