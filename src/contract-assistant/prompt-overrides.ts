import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

function resolveSkillBaseDir(skillName: string): string {
  return path.join(homedir(), ".opencode", "skills", skillName);
}

export function buildPromptFromSkillOverride(
  skillName: string,
  relativePaths: string[],
  variables: Record<string, string>,
  fallback: () => string,
): string {
  const template = loadSkillPromptTemplateSync(skillName, relativePaths);
  return template ? renderPromptTemplate(template, variables) : fallback();
}

export async function buildPromptFromSkillOverrideAsync(
  skillName: string,
  relativePaths: string[],
  variables: Record<string, string>,
  fallback: () => string,
): Promise<string> {
  const template = await loadSkillPromptTemplate(skillName, relativePaths);
  return template ? renderPromptTemplate(template, variables) : fallback();
}

export function loadSkillPromptTemplateSync(skillName: string, relativePaths: string[]): string | undefined {
  const baseDir = resolveSkillBaseDir(skillName);
  for (const relativePath of relativePaths) {
    const fullPath = path.join(baseDir, relativePath);
    try {
      const content = readFileSync(fullPath, "utf8").trim();
      if (content) {
        return content;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export async function loadSkillPromptTemplate(skillName: string, relativePaths: string[]): Promise<string | undefined> {
  const baseDir = resolveSkillBaseDir(skillName);
  for (const relativePath of relativePaths) {
    const fullPath = path.join(baseDir, relativePath);
    try {
      const content = (await readFile(fullPath, "utf8")).trim();
      if (content) {
        return content;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

export function renderPromptTemplate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => variables[key] ?? "");
}
