/**
 * 职责: 覆盖配置加载、默认值和环境变量覆盖逻辑。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { loadConfig, loadConfigWithWarnings } from "../src/config/loader.js";
import type { ExtensionMetaDefinition } from "../src/extension-api/index.js";

describe("loadConfig", () => {
  it("fails when config.json is missing", async () => {
    const missingPath = path.join(os.tmpdir(), `bridge-missing-${Date.now()}.json`);
    await expect(loadConfig(missingPath)).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("resolves whitelist.storePath under storage.dataDir by default", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");

    await writeFile(configPath, JSON.stringify({
      feishu: {
        appId: "app",
        appSecret: "secret",
      },
      opencode: {
        baseUrl: "http://127.0.0.1:4096/",
        directory: process.cwd(),
      },
      storage: {},
      bridge: {},
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.whitelist.storePath).toBe(path.join(dir, "data", "whitelist.json"));
    expect(config.server.publicBaseUrl.toString()).toBe("http://127.0.0.1:3000/");
    expect(config.feishu.cardActions.path).toBe("/webhook/card");
  });

  it("keeps the legacy config normalized snapshot stable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-legacy-"));
    const configPath = path.join(dir, "legacy-config.json");
    const fixtureText = await readFile(path.resolve("test/fixtures/legacy-config.json"), "utf8");
    await writeFile(configPath, fixtureText, "utf8");
    const expected = JSON.parse(await readFile(path.resolve("test/fixtures/legacy-config.snapshot.json"), "utf8")) as unknown;

    const config = await loadConfig(configPath);

    expect(toStableConfigSnapshot(config, dir)).toEqual(expected);
  });

  it("normalizes external extension configs under extensions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-extension-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      extensions: {
        demoExtension: {
          enabled: true,
          relativePath: "./demo-data",
        },
      },
    }), "utf8");
    const meta: ExtensionMetaDefinition = {
      id: "demo-extension",
      configKey: "demoExtension",
      configDefinition: {
        key: "demoExtension",
        schema: z.object({
          enabled: z.boolean().default(false),
          relativePath: z.string().default("./default"),
        }).default({}),
        normalize(parsed: { enabled: boolean; relativePath: string }, context) {
          return {
            enabled: parsed.enabled,
            absolutePath: context.resolveRelative(context.baseDir, parsed.relativePath),
          };
        },
      },
    };

    const config = await loadConfig({ configPath, extensionMetas: [meta] });

    expect(config.extensions?.demoExtension).toEqual({
      enabled: true,
      absolutePath: path.join(dir, "demo-data"),
    });
  });

  it("maps namespace knowledge-base config back to config.knowledgeBase", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-extension-namespace-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      embeddings: {
        provider: {
          baseUrl: "https://api.openai.com/v1/",
          apiKey: "sk-test",
          model: "text-embedding-3-small",
        },
      },
      extensions: {
        "knowledge-base": {
          enabled: true,
          ingest: {
            allowedExtensions: [".PDF", ".MD"],
          },
          storage: {
            bitable: {
              appToken: "app_token",
              tableId: "tbl_entries",
            },
          },
        },
      },
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.knowledgeBase.enabled).toBe(true);
    expect(config.knowledgeBase.ingest.allowedExtensions).toEqual([".pdf", ".md"]);
    expect(config.knowledgeBase.storage.bitable.appToken).toBe("app_token");
    expect(config.extensions).toBeUndefined();
  });

  it("maps namespace contract-assistant and labor-skill configs back to stable output fields", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-extension-namespace-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      extensions: {
        "contract-assistant": {
          enabled: false,
          ingest: {
            contractAllowedExtensions: [".DOCX"],
          },
        },
        "labor-skill": {
          enabled: true,
          ingest: {
            allowedExtensions: [".PDF", ".XLSX"],
          },
        },
      },
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.contractAssistant?.ingest.contractAllowedExtensions).toEqual([".docx"]);
    expect(config.laborSkill?.enabled).toBe(true);
    expect(config.laborSkill?.ingest.allowedExtensions).toEqual([".pdf", ".xlsx"]);
    expect(config.extensions).toBeUndefined();
  });

  it("prefers namespace config over legacy config and returns a warning", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-extension-conflict-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      laborSkill: {
        enabled: false,
        ingest: {
          allowedExtensions: [".txt"],
        },
      },
      extensions: {
        "labor-skill": {
          enabled: true,
          ingest: {
            allowedExtensions: [".pdf"],
          },
        },
      },
    }), "utf8");

    const result = await loadConfigWithWarnings(configPath);

    expect(result.config.laborSkill?.enabled).toBe(true);
    expect(result.config.laborSkill?.ingest.allowedExtensions).toEqual([".pdf"]);
    expect(result.warnings).toEqual([{
      code: "extension-config-overrides-legacy",
      extensionId: "labor-skill",
      configKey: "laborSkill",
      message: "extensions[\"labor-skill\"] 已覆盖 legacy 顶层配置 laborSkill",
    }]);
  });

  it("ignores invalid legacy config when namespace config overrides it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-extension-conflict-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      contractAssistant: {
        enabled: true,
      },
      extensions: {
        "contract-assistant": {
          enabled: false,
        },
      },
    }), "utf8");

    const result = await loadConfigWithWarnings(configPath);

    expect(result.config.contractAssistant?.enabled).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]?.extensionId).toBe("contract-assistant");
  });

  it("does not fall back to legacy config when namespace config is invalid", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-extension-invalid-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      laborSkill: {
        enabled: false,
      },
      extensions: {
        "labor-skill": {
          enabled: true,
          ingest: {
            maxFileSizeMb: -1,
          },
        },
      },
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow("maxFileSizeMb");
  });

  it("keeps unknown namespace ids under config.extensions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-extension-unknown-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      extensions: {
        "unknown-extension": {
          enabled: true,
          custom: "value",
        },
      },
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.extensions?.["unknown-extension"]).toEqual({
      enabled: true,
      custom: "value",
    });
  });

  it("normalizes external extension configs by namespace id without overriding builtins", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-extension-external-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      extensions: {
        "demo-extension": {
          enabled: true,
          relativePath: "./demo-data",
        },
        "knowledge-base": {
          enabled: false,
          query: {
            topK: 7,
          },
        },
      },
    }), "utf8");
    const demoMeta: ExtensionMetaDefinition = {
      id: "demo-extension",
      configKey: "demoExtension",
      configDefinition: {
        key: "demoExtension",
        schema: z.object({
          enabled: z.boolean().default(false),
          relativePath: z.string().default("./default"),
        }).default({}),
        normalize(parsed: { enabled: boolean; relativePath: string }, context) {
          return {
            enabled: parsed.enabled,
            absolutePath: context.resolveRelative(context.baseDir, parsed.relativePath),
          };
        },
      },
    };
    const conflictingBuiltinMeta: ExtensionMetaDefinition = {
      id: "knowledge-base",
      configKey: "knowledgeBase",
      configDefinition: {
        key: "knowledgeBase",
        schema: z.object({ query: z.object({ topK: z.number().default(99) }).default({}) }).default({}),
        normalize() {
          return { overwritten: true };
        },
      },
    };

    const config = await loadConfig({ configPath, extensionMetas: [demoMeta, conflictingBuiltinMeta] });

    expect(config.knowledgeBase.query.topK).toBe(7);
    expect(config.extensions?.["demo-extension"]).toEqual({
      enabled: true,
      absolutePath: path.join(dir, "demo-data"),
    });
    expect(config.extensions?.["knowledge-base"]).toBeUndefined();
  });
});

describe("loadConfig memory settings", () => {
  it("fills memory defaults from storage.dataDir", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(baseConfig()), "utf8");

    const config = await loadConfig(configPath);

    expect(config.memory.retriever).toBe("recent");
    expect(config.memory.dbPath).toBe(path.join(dir, "data", "memory.db"));
    expect(config.memory.obsidian.syncCron).toBe("0 2 * * *");
    expect(config.embeddings?.similarityThreshold).toBe(0.75);
  });

  it("rejects embedding retriever without embeddings provider config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      memory: {
        enabled: true,
        retriever: "embedding",
      },
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow("embeddings.provider");
  });

  it("accepts the legacy memory.embeddingProvider config for compatibility", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      memory: {
        enabled: true,
        retriever: "embedding",
        embeddingProvider: {
          baseUrl: "https://api.openai.com/v1/",
          apiKey: "sk-test",
          model: "text-embedding-3-small",
        },
        embeddingSimilarityThreshold: 0.81,
      },
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.embeddings?.provider?.model).toBe("text-embedding-3-small");
    expect(config.embeddings?.similarityThreshold).toBe(0.81);
  });

  it("loads the knowledge base source hyperlink field config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      embeddings: {
        provider: {
          baseUrl: "https://api.openai.com/v1/",
          apiKey: "sk-test",
          model: "text-embedding-3-small",
        },
      },
      knowledgeBase: {
        enabled: true,
        storage: {
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
            sourceFileField: {
              name: "资料链接",
              type: "hyperlink",
              urlTemplate: "https://example.com/files/{{messageId}}/{{fileKey}}",
              textTemplate: "{{fileName}}",
            },
            statuteField: {
              name: "法条",
              type: "hyperlink",
              urlTemplate: "https://example.com/law?keyword={{statute}}",
              textTemplate: "{{statute}}",
            },
          },
        },
      },
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.knowledgeBase.storage.bitable.sourceFileField).toEqual({
      name: "资料链接",
      type: "hyperlink",
      urlTemplate: "https://example.com/files/{{messageId}}/{{fileKey}}",
      textTemplate: "{{fileName}}",
    });
    expect(config.knowledgeBase.storage.bitable.statuteField).toEqual({
      name: "法条",
      type: "hyperlink",
      urlTemplate: "https://example.com/law?keyword={{statute}}",
      textTemplate: "{{statute}}",
    });
    expect(config.knowledgeBase.models).toEqual({
      default: undefined,
      webRead: undefined,
      extract: undefined,
      rerank: undefined,
    });
    expect(config.knowledgeBase.ingest.maxExtractChunks).toBe(30);
    expect(config.knowledgeBase.ingest.maxExtractQas).toBe(500);
    expect(config.knowledgeBase.ingest.allowedExtensions).toEqual([".pdf", ".docx", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp"]);
    expect(config.knowledgeBase.parser).toEqual({
      externalApiEnabled: false,
      pdfProviderOrder: ["pdf-parse", "pymupdf4llm", "docling", "mineru-agent"],
      imageProviderOrder: ["mineru-agent", "paddleocr-vl", "tesseract"],
      ocrLang: "chi_sim+eng",
      timeoutMs: 180000,
      pollIntervalMs: 5000,
      maxPollMs: 180000,
      mineru: {
        enabled: false,
        endpoint: "https://mineru.net/api/v1/agent",
        apiKey: "",
      },
      paddleocr: {
        enabled: false,
        apiKey: "",
        secretKey: "",
      },
    });
  });

  it("loads knowledge base OpenCode model routing config", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      embeddings: {
        provider: {
          baseUrl: "https://api.openai.com/v1/",
          apiKey: "sk-test",
          model: "text-embedding-3-small",
        },
      },
      knowledgeBase: {
        enabled: true,
        storage: {
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
          },
        },
        models: {
          default: "minimax-cn-coding-plan/MiniMax-M2.7",
          extract: "minimax-cn-coding-plan/MiniMax-M2.7",
        },
      },
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.knowledgeBase.models).toEqual({
      default: "minimax-cn-coding-plan/MiniMax-M2.7",
      webRead: undefined,
      extract: "minimax-cn-coding-plan/MiniMax-M2.7",
      rerank: undefined,
    });
  });

  it("rejects slashless knowledge base model ids", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      embeddings: {
        provider: {
          baseUrl: "https://api.openai.com/v1/",
          apiKey: "sk-test",
          model: "text-embedding-3-small",
        },
      },
      knowledgeBase: {
        enabled: true,
        storage: {
          bitable: {
            appToken: "app_token",
            tableId: "tbl_entries",
          },
        },
        models: {
          default: "MiniMax-M2.7",
        },
      },
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow(/knowledgeBase\.models\.\* 必须使用 <provider>\/<model> 格式/);
  });

  it("rejects obsidian sync without vaultPath", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      memory: {
        enabled: true,
        obsidian: {
          enabled: true,
        },
      },
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow("vaultPath");
  });

  it("fills contract assistant defaults when omitted", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(baseConfig()), "utf8");

    const config = await loadConfig(configPath);

    expect(config.contractAssistant).toEqual({
      enabled: false,
      storage: {
        baseToken: "",
        contractTableId: "",
        invoiceTableId: "",
        caseTableId: "",
      },
      models: {
        default: undefined,
        draft: undefined,
        extract: undefined,
        invoice: undefined,
        caseManage: undefined,
      },
      ingest: {
        contractAllowedExtensions: [".pdf", ".docx", ".txt", ".md"],
        invoiceAllowedExtensions: [".pdf", ".png", ".jpg", ".jpeg", ".txt", ".md"],
        maxFileSizeMb: 20,
        pendingTtlMs: 600000,
      },
      reminder: {
        enabled: false,
        targetChatIds: [],
        hour: 9,
        minute: 0,
        lookaheadDays: 7,
      },
    });
  });

  it("requires base and table ids when contract assistant is enabled", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      contractAssistant: {
        enabled: true,
      },
    }), "utf8");

    await expect(loadConfig(configPath)).rejects.toThrow("contractAssistant.storage.baseToken");
  });

  it("fills labor skill defaults when omitted", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify(baseConfig()), "utf8");

    const config = await loadConfig(configPath);

    expect(config.laborSkill).toEqual({
      enabled: false,
      models: {
        default: undefined,
        extract: undefined,
        analyze: undefined,
      },
      ingest: {
        allowedExtensions: [".pdf", ".docx", ".txt", ".md", ".png", ".jpg", ".jpeg", ".webp", ".xls", ".xlsx", ".csv"],
        maxFileSizeMb: 20,
        pendingTtlMs: 600000,
      },
      storage: {
        evidenceLedger: undefined,
      },
    });
  });

  it("loads optional labor evidence ledger settings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-config-"));
    const configPath = path.join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({
      ...baseConfig(),
      laborSkill: {
        enabled: true,
        storage: {
          evidenceLedger: {
            appToken: "app_labor",
            tableId: "tbl_evidence",
            keyEvidenceViewId: "vew_key",
            missingEvidenceViewId: "vew_gap",
          },
        },
      },
    }), "utf8");

    const config = await loadConfig(configPath);

    expect(config.laborSkill?.storage).toEqual({
      evidenceLedger: {
        appToken: "app_labor",
        tableId: "tbl_evidence",
        keyEvidenceViewId: "vew_key",
        missingEvidenceViewId: "vew_gap",
      },
    });
  });
});

function baseConfig(): Record<string, unknown> {
  return {
    feishu: {
      appId: "cli_xxx",
      appSecret: "secret",
      botOpenId: "ou_bot",
      behavior: {
        enableP2p: true,
        enableGroup: true,
        requireBotMentionInGroup: true,
        strictBotMention: true,
        ignoreNonUserSenders: true,
        replyInThread: true,
      },
    },
    opencode: {
      baseUrl: "http://127.0.0.1:4096/",
      directory: dirPlaceholder(),
    },
    storage: {
      dataDir: "./data",
      mappingsFile: "mappings.json",
    },
    bridge: {
      queueLimit: 3,
    },
  };
}

function dirPlaceholder(): string {
  return process.cwd();
}

function toStableConfigSnapshot(value: unknown, fixtureDir: string): unknown {
  if (value instanceof URL) {
    return value.toString();
  }
  if (value instanceof Set) {
    return [...value].sort();
  }
  if (Array.isArray(value)) {
    return value.map((item) => toStableConfigSnapshot(item, fixtureDir));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, toStableConfigSnapshot(item, fixtureDir)]));
  }
  if (typeof value === "string") {
    return value.split(fixtureDir).join("<fixtureDir>");
  }
  return value;
}
