/**
 * 职责: 收口案件待办查询的字段拼装与查询解析。
 * 关注点:
 * - 保持案件待办 runtime/service 行为不变，先把纯辅助逻辑从主 service 拆出。
 * - 通过注入字段读取函数复用现有 Base 字段兼容规则。
 */

type CaseTodoFieldReaders = {
  readString(fields: Record<string, unknown>, key: string): string | undefined;
  readDate(fields: Record<string, unknown>, key: string): string | undefined;
  normalizeDate(value: unknown): number | undefined;
};

export function parseCaseTodoQuery(query: string): { text: string; todayOnly: boolean } {
  const trimmed = query.replace(/\s+/g, "").trim();
  const todayOnly = /(今天|今日)/.test(trimmed);
  const text = trimmed
    .replace(/^(帮我)?(查看|查询|列出|看看|展示|打开|获取)/, "")
    .replace(/(今天|今日)/g, "")
    .replace(/(案件|案子|案源|全部|所有)/g, "")
    .replace(/(待办|提醒|事项|日程|期限|节点)/g, "")
    .trim();
  return { text, todayOnly };
}

export function buildCaseTodoDateSummary(
  fields: Record<string, unknown>,
  readers: Pick<CaseTodoFieldReaders, "readDate" | "normalizeDate">,
  now = new Date(),
): { text: string; todayMatched: boolean } {
  const dateFields = [
    "日期",
    "开庭日",
    "举证截止日",
    "反诉截止日",
    "管辖权异议截止日",
    "上诉截止日",
  ];
  const parts: string[] = [];
  let todayMatched = false;
  for (const field of dateFields) {
    const formatted = readers.readDate(fields, field);
    if (!formatted) {
      continue;
    }
    parts.push(`${field} ${formatted}`);
    const timestamp = readers.normalizeDate(fields[field]);
    if (timestamp !== undefined && isTodayTimestamp(timestamp, now)) {
      todayMatched = true;
    }
  }
  return { text: parts.join("；"), todayMatched };
}

export function buildCaseRecordLabel(
  fields: Record<string, unknown>,
  readers: Pick<CaseTodoFieldReaders, "readString">,
): string {
  const caseNo = readers.readString(fields, "案号");
  const client = readers.readString(fields, "委托人");
  const counterparty = readers.readString(fields, "对方当事人");
  const cause = readers.readString(fields, "案由");
  if (caseNo) {
    return caseNo;
  }
  if (client && counterparty) {
    return `${client} vs ${counterparty}${cause ? ` ${cause}` : ""}`;
  }
  return client ?? counterparty ?? cause ?? "未命名案件";
}

function isTodayTimestamp(timestamp: number, now: Date): boolean {
  const date = new Date(timestamp);
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}
