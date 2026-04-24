/**
 * 职责: 收口飞书 Markdown 兼容性处理。
 * 关注点:
 * - 避免飞书把 fenced code block 的语言标注渲染成正文前缀。
 * - 修复模型偶发输出的单反引号伪代码块。
 * - 保持代码块内容本身不被 HTML escape 或重写。
 */

const CODE_BLOCK_LANGUAGES = [
  "bash",
  "sh",
  "shell",
  "zsh",
  "json",
  "js",
  "ts",
  "tsx",
  "jsx",
  "python",
  "py",
  "yaml",
  "yml",
  "toml",
  "ini",
  "markdown",
  "md",
] as const;

/** 兼容飞书 Markdown 渲染：代码块不携带语言标注。 */
export function normalizeFeishuMarkdown(markdownText: string): string {
  return repairSingleBacktickCodeBlocks(markdownText)
    .replace(/^```[^\S\r\n]*[A-Za-z0-9_-]+[^\S\r\n]*$/gm, "```");
}

/** Assistant 回复专用 Markdown 规整，不影响 bridge 自己拼装的系统卡片。 */
export function normalizeAssistantMarkdown(markdownText: string): string {
  return downgradeTopLevelHeadings(normalizeFeishuMarkdown(markdownText));
}

function repairSingleBacktickCodeBlocks(markdownText: string): string {
  const languageAlternation = CODE_BLOCK_LANGUAGES.join("|");
  const pattern = new RegExp(
    `(^|\\n)\\\`(${languageAlternation})(?:[ \\t]+|\\n)([\\s\\S]*?)\\n\\\`(?=\\n|$)`,
    "gi",
  );
  return markdownText.replace(pattern, (_match, prefix: string, _language: string, body: string) => `${prefix}\`\`\`\n${body.trim()}\n\`\`\``);
}

function downgradeTopLevelHeadings(markdownText: string): string {
  return markdownText.replace(/^(#{1,2})[^\S\r\n]+(.+)$/gm, (_match, marker: string, title: string) => {
    const level = marker.length === 1 ? "###" : "####";
    return `${level} ${title}`;
  });
}
