/**
 * 职责: 收口飞书 Markdown 兼容性处理。
 * 关注点:
 * - 避免飞书把 fenced code block 的语言标注渲染成正文前缀。
 * - 保持代码块内容本身不被 HTML escape 或重写。
 */

/** 兼容飞书 Markdown 渲染：代码块不携带语言标注。 */
export function normalizeFeishuMarkdown(markdownText: string): string {
  return markdownText.replace(/^```[^\S\r\n]*[A-Za-z0-9_-]+[^\S\r\n]*$/gm, "```");
}
