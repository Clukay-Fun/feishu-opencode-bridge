import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config/loader.js";

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
