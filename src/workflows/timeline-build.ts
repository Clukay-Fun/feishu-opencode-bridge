/**
 * 职责: 提供跨案型复用的时间线构建能力。
 * 关注点:
 * - 对事件按日期做稳定排序。
 * - 输出可嵌入飞书文档和白板的 Mermaid 时间线。
 */
export type TimelineEvent = {
  date?: string | undefined;
  event: string;
  evidence?: string | undefined;
};

export function buildTimelineMermaid(events: TimelineEvent[], options?: {
  emptyLabel?: string | undefined;
  maxEvents?: number | undefined;
}): string {
  const sorted = [...events]
    .filter((item) => item.event.trim())
    .sort((left, right) => (left.date ?? "").localeCompare(right.date ?? ""));
  if (sorted.length === 0) {
    return `flowchart TD\n    N1["${escapeMermaidLabel(options?.emptyLabel ?? "暂无明确时间线")}"]`;
  }
  const lines = ["flowchart TD"];
  sorted.slice(0, options?.maxEvents ?? 8).forEach((row, index) => {
    const nodeId = `N${index + 1}`;
    const label = escapeMermaidLabel(`${row.date ?? "日期待补"}｜${row.event}`);
    lines.push(`    ${nodeId}["${label}"]`);
    if (index > 0) {
      lines.push(`    N${index} --> ${nodeId}`);
    }
  });
  return lines.join("\n");
}

export function escapeMermaidLabel(value: string): string {
  return value.replace(/"/g, "'").replace(/\n/g, " ").trim();
}
