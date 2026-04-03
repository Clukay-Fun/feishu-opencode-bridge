export function cleanAssistantReply(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
