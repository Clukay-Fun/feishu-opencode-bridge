/**
 * 职责: 覆盖启动期外部扩展加载器。
 * 关注点:
 * - 验证 manifest 扫描、默认 dist 入口、warning 降级和依赖排序。
 * - 不测试热拔插或第三方包解析，Phase 2 只支持启动期加载。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadExternalExtensions, resolveExtensionsRoot } from "../src/runtime/load-extensions.js";

describe("loadExternalExtensions", () => {
  it("returns empty lists when the extensions root does not exist", async () => {
    const root = path.join(os.tmpdir(), `bridge-missing-extensions-${Date.now()}`);

    await expect(loadExternalExtensions({ rootDir: root })).resolves.toEqual({
      metas: [],
      extensions: [],
      warnings: [],
    });
  });

  it("loads meta and runtime modules from extension directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-extensions-"));
    await writeExtension(root, "demo", {
      meta: "export default { id: 'demo', commands: [{ name: 'demo', owner: 'business', description: 'Demo' }] };",
      runtime: "export default { id: 'demo', createModule: () => ({ name: 'demo', priority: 90 }) };",
    });

    const loaded = await loadExternalExtensions({ rootDir: root });

    expect(loaded.warnings).toEqual([]);
    expect(loaded.metas).toEqual([
      expect.objectContaining({ id: "demo" }),
    ]);
    expect(loaded.extensions).toEqual([
      expect.objectContaining({ id: "demo" }),
    ]);
  });

  it("rejects extension directories without package.json", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-extensions-"));
    await writeExtension(root, "legacy", {
      writePackageJson: false,
      meta: "export default { id: 'legacy' };",
      runtime: "export default { id: 'legacy', createModule: () => ({ name: 'legacy', priority: 90 }) };",
    });

    const loaded = await loadExternalExtensions({ rootDir: root });

    expect(loaded.extensions).toEqual([]);
    expect(loaded.warnings[0]).toContain("跳过外部扩展 legacy");
    expect(loaded.warnings[0]).toContain("package.json");
  });

  it("warns when package.json metadata differs from manifest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-extensions-"));
    await writeExtension(root, "demo", {
      manifestId: "demo",
      manifestVersion: "1.0.0",
      packageName: "@demo/different",
      packageVersion: "2.0.0",
      meta: "export default { id: 'demo' };",
      runtime: "export default { id: 'demo', createModule: () => ({ name: 'demo', priority: 90 }) };",
    });

    const loaded = await loadExternalExtensions({ rootDir: root });

    expect(loaded.extensions.map((extension) => extension.id)).toEqual(["demo"]);
    expect(loaded.warnings).toEqual([
      expect.stringContaining("package.json name (@demo/different) 与 manifest id (demo) 不一致"),
      expect.stringContaining("package.json version (2.0.0) 与 manifest version (1.0.0) 不一致"),
    ]);
  });

  it("requires declared dependencies to resolve inside the extension directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-extensions-"));
    await writeExtension(root, "demo", {
      packageDependencies: { "local-only": "1.0.0" },
      localDependencies: ["local-only"],
      meta: "export default { id: 'demo' };",
      runtime: "export default { id: 'demo', createModule: () => ({ name: 'demo', priority: 90 }) };",
    });

    const loaded = await loadExternalExtensions({ rootDir: root });

    expect(loaded.warnings).toEqual([]);
    expect(loaded.extensions.map((extension) => extension.id)).toEqual(["demo"]);
  });

  it("rejects declared dependencies that leak from an ancestor node_modules", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-extensions-"));
    await writeFakePackage(path.join(root, "node_modules", "leaky"));
    await writeExtension(root, "demo", {
      packageDependencies: { leaky: "1.0.0" },
      meta: "export default { id: 'demo' };",
      runtime: "export default { id: 'demo', createModule: () => ({ name: 'demo', priority: 90 }) };",
    });

    const loaded = await loadExternalExtensions({ rootDir: root });

    expect(loaded.extensions).toEqual([]);
    expect(loaded.warnings[0]).toContain("疑似依赖泄漏");
    expect(loaded.warnings[0]).toContain("leaky");
  });

  it("rejects declared dependencies that are not installed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-extensions-"));
    await writeExtension(root, "demo", {
      packageDependencies: { missing: "1.0.0" },
      meta: "export default { id: 'demo' };",
      runtime: "export default { id: 'demo', createModule: () => ({ name: 'demo', priority: 90 }) };",
    });

    const loaded = await loadExternalExtensions({ rootDir: root });

    expect(loaded.extensions).toEqual([]);
    expect(loaded.warnings[0]).toContain("dependencies 未安装在扩展目录");
    expect(loaded.warnings[0]).toContain("missing");
  });

  it("uses dev source entries when explicitly requested", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-extensions-"));
    await writeExtension(root, "demo", {
      manifestExtra: {
        devMeta: "src/meta.js",
        devRuntime: "src/runtime.js",
      },
      meta: "export default { id: 'demo', commands: [{ name: 'dist-demo', owner: 'business', description: 'Dist demo' }] };",
      runtime: "export default { id: 'demo', createModule: () => ({ name: 'dist-demo', priority: 90 }) };",
      sourceMeta: "export default { id: 'demo', commands: [{ name: 'source-demo', owner: 'business', description: 'Source demo' }] };",
      sourceRuntime: "export default { id: 'demo', createModule: () => ({ name: 'source-demo', priority: 90 }) };",
    });

    const loaded = await loadExternalExtensions({ rootDir: root, preferSource: true });

    const module = await Promise.resolve(loaded.extensions[0]?.createModule({} as never));

    expect(loaded.warnings).toEqual([]);
    expect(loaded.metas[0]?.commands?.[0]?.name).toBe("source-demo");
    expect(module?.name).toBe("source-demo");
  });

  it("keeps loading other extensions when one extension is invalid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-extensions-"));
    await writeExtension(root, "valid", {
      meta: "export default { id: 'valid' };",
      runtime: "export default { id: 'valid', createModule: () => null };",
    });
    await writeExtension(root, "broken", {
      manifestId: "broken",
      meta: "export default { id: 'different' };",
      runtime: "export default { id: 'broken', createModule: () => null };",
    });

    const loaded = await loadExternalExtensions({ rootDir: root });

    expect(loaded.extensions.map((extension) => extension.id)).toEqual(["valid"]);
    expect(loaded.warnings).toHaveLength(1);
    expect(loaded.warnings[0]).toContain("跳过外部扩展 broken");
  });

  it("sorts loaded extensions by declared dependencies", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-extensions-"));
    await writeExtension(root, "consumer", {
      dependencies: ["provider"],
      meta: "export default { id: 'consumer', dependencies: ['provider'] };",
      runtime: "export default { id: 'consumer', dependencies: ['provider'], createModule: () => null };",
    });
    await writeExtension(root, "provider", {
      meta: "export default { id: 'provider' };",
      runtime: "export default { id: 'provider', createModule: () => null };",
    });

    const loaded = await loadExternalExtensions({ rootDir: root });

    expect(loaded.extensions.map((extension) => extension.id)).toEqual(["provider", "consumer"]);
  });

  it("resolves BRIDGE_EXTENSIONS_DIR before BRIDGE_HOME", () => {
    expect(resolveExtensionsRoot({
      BRIDGE_EXTENSIONS_DIR: "/tmp/custom-ext",
      BRIDGE_HOME: "/tmp/bridge-home",
    })).toBe("/tmp/custom-ext");
  });

  it("can enable dev source entries through BRIDGE_EXTENSIONS_DEV", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-extensions-"));
    await writeExtension(root, "demo", {
      manifestExtra: {
        devMeta: "src/meta.js",
        devRuntime: "src/runtime.js",
      },
      meta: "export default { id: 'demo' };",
      runtime: "export default { id: 'demo', createModule: () => ({ name: 'dist-demo', priority: 90 }) };",
      sourceMeta: "export default { id: 'demo' };",
      sourceRuntime: "export default { id: 'demo', createModule: () => ({ name: 'source-demo', priority: 90 }) };",
    });

    const loaded = await loadExternalExtensions({
      rootDir: root,
      env: { BRIDGE_EXTENSIONS_DEV: "1" },
    });
    const module = await Promise.resolve(loaded.extensions[0]?.createModule({} as never));

    expect(module?.name).toBe("source-demo");
  });

  it("ignores BRIDGE_EXTENSIONS_DEV in production unless explicitly allowed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-extensions-"));
    await writeExtension(root, "demo", {
      manifestExtra: {
        devMeta: "src/meta.js",
        devRuntime: "src/runtime.js",
      },
      meta: "export default { id: 'demo' };",
      runtime: "export default { id: 'demo', createModule: () => ({ name: 'dist-demo', priority: 90 }) };",
      sourceMeta: "export default { id: 'demo' };",
      sourceRuntime: "export default { id: 'demo', createModule: () => ({ name: 'source-demo', priority: 90 }) };",
    });

    const loaded = await loadExternalExtensions({
      rootDir: root,
      env: { NODE_ENV: "production", BRIDGE_EXTENSIONS_DEV: "1" },
    });
    const module = await Promise.resolve(loaded.extensions[0]?.createModule({} as never));

    expect(module?.name).toBe("dist-demo");
    expect(loaded.warnings).toContain("生产环境已忽略 BRIDGE_EXTENSIONS_DEV；如需强制加载 devMeta/devRuntime，需同时设置 BRIDGE_ALLOW_DEV_IN_PROD=1");
  });

  it("allows dev source entries in production only with the double opt-in", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bridge-extensions-"));
    await writeExtension(root, "demo", {
      manifestExtra: {
        devMeta: "src/meta.js",
        devRuntime: "src/runtime.js",
      },
      meta: "export default { id: 'demo' };",
      runtime: "export default { id: 'demo', createModule: () => ({ name: 'dist-demo', priority: 90 }) };",
      sourceMeta: "export default { id: 'demo' };",
      sourceRuntime: "export default { id: 'demo', createModule: () => ({ name: 'source-demo', priority: 90 }) };",
    });

    const loaded = await loadExternalExtensions({
      rootDir: root,
      env: {
        NODE_ENV: "production",
        BRIDGE_EXTENSIONS_DEV: "1",
        BRIDGE_ALLOW_DEV_IN_PROD: "1",
      },
    });
    const module = await Promise.resolve(loaded.extensions[0]?.createModule({} as never));

    expect(loaded.warnings).toEqual([]);
    expect(module?.name).toBe("source-demo");
  });
});

async function writeExtension(
  root: string,
  name: string,
  options: {
    manifestId?: string | undefined;
    manifestVersion?: string | undefined;
    dependencies?: string[] | undefined;
    manifestExtra?: Record<string, unknown> | undefined;
    writePackageJson?: boolean | undefined;
    packageName?: string | undefined;
    packageVersion?: string | undefined;
    packageDependencies?: Record<string, string> | undefined;
    localDependencies?: string[] | undefined;
    meta: string;
    runtime: string;
    sourceMeta?: string | undefined;
    sourceRuntime?: string | undefined;
  },
): Promise<void> {
  const extensionDir = path.join(root, name);
  const distDir = path.join(extensionDir, "dist");
  const sourceDir = path.join(extensionDir, "src");
  await mkdir(distDir, { recursive: true });
  if (options.sourceMeta || options.sourceRuntime) {
    await mkdir(sourceDir, { recursive: true });
  }
  await writeFile(path.join(extensionDir, "manifest.json"), JSON.stringify({
    id: options.manifestId ?? name,
    ...(options.manifestVersion ? { version: options.manifestVersion } : {}),
    dependencies: options.dependencies ?? [],
    ...options.manifestExtra,
  }), "utf8");
  if (options.writePackageJson !== false) {
    await writeFile(path.join(extensionDir, "package.json"), JSON.stringify({
      name: options.packageName ?? (options.manifestId ?? name),
      version: options.packageVersion ?? options.manifestVersion ?? "0.0.0",
      type: "module",
      dependencies: options.packageDependencies ?? {},
    }), "utf8");
  }
  for (const dependency of options.localDependencies ?? []) {
    await writeFakePackage(path.join(extensionDir, "node_modules", dependency));
  }
  await writeFile(path.join(distDir, "meta.js"), options.meta, "utf8");
  await writeFile(path.join(distDir, "runtime.js"), options.runtime, "utf8");
  if (options.sourceMeta) {
    await writeFile(path.join(sourceDir, "meta.js"), options.sourceMeta, "utf8");
  }
  if (options.sourceRuntime) {
    await writeFile(path.join(sourceDir, "runtime.js"), options.sourceRuntime, "utf8");
  }
}

async function writeFakePackage(packageDir: string): Promise<void> {
  await mkdir(packageDir, { recursive: true });
  await writeFile(path.join(packageDir, "package.json"), JSON.stringify({
    name: path.basename(packageDir),
    version: "1.0.0",
    type: "module",
    main: "index.js",
  }), "utf8");
  await writeFile(path.join(packageDir, "index.js"), "export default 'ok';\n", "utf8");
}
