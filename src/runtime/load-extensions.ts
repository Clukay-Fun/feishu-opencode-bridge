/**
 * 职责: 扫描并加载启动期外部扩展目录。
 * 关注点:
 * - 读取 manifest.json，动态导入 dist 或显式 dev source 入口。
 * - 只做启动期发现与校验，不做热拔插、卸载、reload 或沙箱隔离。
 * - 将加载失败记录为 warning，避免单个外部扩展阻塞 bridge 核心启动。
 */
import { access, readdir, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import type { ExtensionDefinition, ExtensionMetaDefinition } from "../extension-api/index.js";

const ExtensionManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1).optional(),
  meta: z.string().min(1).default("dist/meta.js"),
  runtime: z.string().min(1).default("dist/runtime.js"),
  devMeta: z.string().min(1).optional(),
  devRuntime: z.string().min(1).optional(),
  dependencies: z.array(z.string().min(1)).default([]),
});

const ExtensionPackageJsonSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  type: z.string().optional(),
  dependencies: z.record(z.string()).default({}),
  optionalDependencies: z.record(z.string()).default({}),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
export type ExtensionPackageJson = z.infer<typeof ExtensionPackageJsonSchema>;

export type LoadedExternalExtensions = {
  metas: ExtensionMetaDefinition[];
  extensions: ExtensionDefinition[];
  warnings: string[];
};

export async function loadExternalExtensions(options: {
  rootDir?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  preferSource?: boolean | undefined;
} = {}): Promise<LoadedExternalExtensions> {
  const env = options.env ?? process.env;
  const rootDir = resolveExtensionsRoot(env, options.rootDir);
  const sourcePreference = resolveSourcePreference(env, options.preferSource);
  if (!await exists(rootDir)) {
    return { metas: [], extensions: [], warnings: sourcePreference.warnings };
  }

  const warnings: string[] = [...sourcePreference.warnings];
  const entries = await readdir(rootDir, { withFileTypes: true });
  const loaded: Array<{ manifest: ExtensionManifest; meta: ExtensionMetaDefinition; extension: ExtensionDefinition }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const extensionDir = path.join(rootDir, entry.name);
    try {
      const manifest = await readManifest(extensionDir);
      const packageJson = await readPackageJson(extensionDir);
      warnings.push(...validatePackageAgainstManifest(entry.name, manifest, packageJson));
      await assertDependenciesIsolated(extensionDir, packageJson);
      const entries = resolveManifestEntries(manifest, sourcePreference.preferSource);
      const [meta, extension] = await Promise.all([
        importDefault<ExtensionMetaDefinition>(path.join(extensionDir, entries.meta)),
        importDefault<ExtensionDefinition>(path.join(extensionDir, entries.runtime)),
      ]);
      if (meta.id !== manifest.id || extension.id !== manifest.id) {
        throw new Error(`manifest id ${manifest.id} must match meta/runtime ids (${meta.id}, ${extension.id})`);
      }
      loaded.push({ manifest, meta, extension });
    } catch (error) {
      warnings.push(`跳过外部扩展 ${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const sorted = sortLoadedExtensions(loaded, warnings);
  return {
    metas: sorted.map((item) => item.meta),
    extensions: sorted.map((item) => item.extension),
    warnings,
  };
}

export function resolveExtensionsRoot(env: NodeJS.ProcessEnv = process.env, explicitRoot?: string | undefined): string {
  if (explicitRoot) {
    return path.resolve(explicitRoot);
  }
  if (env.BRIDGE_EXTENSIONS_DIR) {
    return path.resolve(env.BRIDGE_EXTENSIONS_DIR);
  }
  return path.resolve(env.BRIDGE_HOME ?? ".", "extensions");
}

async function readManifest(extensionDir: string): Promise<ExtensionManifest> {
  const manifestPath = path.join(extensionDir, "manifest.json");
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  return ExtensionManifestSchema.parse(raw);
}

async function readPackageJson(extensionDir: string): Promise<ExtensionPackageJson> {
  const packageJsonPath = path.join(extensionDir, "package.json");
  const raw = JSON.parse(await readFile(packageJsonPath, "utf8")) as unknown;
  return ExtensionPackageJsonSchema.parse(raw);
}

async function importDefault<T>(filePath: string): Promise<T> {
  const module = await import(pathToFileURL(filePath).href) as { default?: unknown };
  if (!module.default) {
    throw new Error(`${path.basename(filePath)} must export default`);
  }
  return module.default as T;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function sortLoadedExtensions(
  loaded: Array<{ manifest: ExtensionManifest; meta: ExtensionMetaDefinition; extension: ExtensionDefinition }>,
  warnings: string[],
): Array<{ manifest: ExtensionManifest; meta: ExtensionMetaDefinition; extension: ExtensionDefinition }> {
  const byId = new Map(loaded.map((item) => [item.manifest.id, item]));
  const sorted: typeof loaded = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (item: typeof loaded[number]): void => {
    if (visited.has(item.manifest.id)) {
      return;
    }
    if (visiting.has(item.manifest.id)) {
      warnings.push(`外部扩展 ${item.manifest.id} 存在循环依赖，已跳过排序依赖`);
      return;
    }
    visiting.add(item.manifest.id);
    const dependencies = new Set([
      ...item.manifest.dependencies,
      ...(item.meta.dependencies ?? []),
      ...(item.extension.dependencies ?? []),
    ]);
    for (const dependency of dependencies) {
      const dependencyItem = byId.get(dependency);
      if (dependencyItem) {
        visit(dependencyItem);
      }
    }
    visiting.delete(item.manifest.id);
    visited.add(item.manifest.id);
    sorted.push(item);
  };

  for (const item of loaded) {
    visit(item);
  }
  return sorted;
}

function resolveManifestEntries(
  manifest: ExtensionManifest,
  preferSource: boolean,
): { meta: string; runtime: string } {
  if (!preferSource) {
    return { meta: manifest.meta, runtime: manifest.runtime };
  }
  return {
    meta: manifest.devMeta ?? manifest.meta,
    runtime: manifest.devRuntime ?? manifest.runtime,
  };
}

function shouldPreferSourceEntries(env: NodeJS.ProcessEnv): boolean {
  return env.BRIDGE_EXTENSIONS_DEV === "1" || env.BRIDGE_EXTENSIONS_DEV === "true";
}

function resolveSourcePreference(
  env: NodeJS.ProcessEnv,
  explicitPreferSource: boolean | undefined,
): { preferSource: boolean; warnings: string[] } {
  const requested = explicitPreferSource ?? shouldPreferSourceEntries(env);
  if (!requested) {
    return { preferSource: false, warnings: [] };
  }
  if (explicitPreferSource !== undefined) {
    return { preferSource: explicitPreferSource, warnings: [] };
  }
  if (env.NODE_ENV === "production" && !allowsDevEntriesInProduction(env)) {
    return {
      preferSource: false,
      warnings: ["生产环境已忽略 BRIDGE_EXTENSIONS_DEV；如需强制加载 devMeta/devRuntime，需同时设置 BRIDGE_ALLOW_DEV_IN_PROD=1"],
    };
  }
  return { preferSource: true, warnings: [] };
}

function allowsDevEntriesInProduction(env: NodeJS.ProcessEnv): boolean {
  return env.BRIDGE_ALLOW_DEV_IN_PROD === "1" || env.BRIDGE_ALLOW_DEV_IN_PROD === "true";
}

function validatePackageAgainstManifest(
  directoryName: string,
  manifest: ExtensionManifest,
  packageJson: ExtensionPackageJson,
): string[] {
  const warnings: string[] = [];
  if (packageJson.name !== manifest.id) {
    warnings.push(`外部扩展 ${directoryName}: package.json name (${packageJson.name}) 与 manifest id (${manifest.id}) 不一致`);
  }
  if (manifest.version && packageJson.version !== manifest.version) {
    warnings.push(`外部扩展 ${directoryName}: package.json version (${packageJson.version}) 与 manifest version (${manifest.version}) 不一致`);
  }
  if (packageJson.type !== "module") {
    warnings.push(`外部扩展 ${directoryName}: package.json 建议声明 "type": "module"，以稳定 ESM 加载行为`);
  }
  return warnings;
}

async function assertDependenciesIsolated(
  extensionDir: string,
  packageJson: ExtensionPackageJson,
): Promise<void> {
  const dependencies = Object.keys(packageJson.dependencies);
  if (dependencies.length === 0) {
    return;
  }

  const requireFromExtension = createRequire(path.join(extensionDir, "package.json"));
  const resolvedExtensionDir = await realpath(extensionDir);
  const leaked: string[] = [];
  const missing: string[] = [];

  for (const dependency of dependencies) {
    try {
      const resolved = await realpath(requireFromExtension.resolve(dependency));
      if (!isPathInside(resolvedExtensionDir, resolved)) {
        leaked.push(`${dependency} -> ${resolved}`);
      }
    } catch {
      missing.push(dependency);
    }
  }

  if (missing.length > 0) {
    throw new Error(`package.json dependencies 未安装在扩展目录: ${missing.join(", ")}`);
  }
  if (leaked.length > 0) {
    throw new Error(`package.json dependencies 解析到扩展目录外，疑似依赖泄漏: ${leaked.join("; ")}`);
  }
}

function isPathInside(parentDir: string, childPath: string): boolean {
  const relative = path.relative(parentDir, path.resolve(childPath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
