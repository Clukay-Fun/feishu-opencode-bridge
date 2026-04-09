import { describe, expect, it, vi } from "vitest";

import { BridgeApp, type PermissionCardActionValue } from "../src/runtime/app.js";
import type { AppConfig } from "../src/config/schema.js";
import type { PendingPermissionInteraction } from "../src/bridge/state.js";
import type { ChatWhitelist } from "../src/store/whitelist.js";

describe("BridgeApp permission card actions", () => {
  it("handles an allow-always button click for the requester", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const replyPermission = vi.fn(async () => true);
    (app as unknown as { opencode: { replyPermission: typeof replyPermission } }).opencode = { replyPermission };

    const interaction = seedPermission(app);
    const card = await app.handlePermissionCardAction(
      interaction.requesterOpenId,
      interaction.permissionMessageId ?? "",
      buildActionValue(interaction, "always"),
    );

    expect(replyPermission).toHaveBeenCalledWith(interaction.sessionId, interaction.permissionId, "always", true);
    expect(JSON.stringify(card)).toContain("后续同类权限将自动允许");
    expect((app as unknown as { pendingInteractions: Map<string, unknown> }).pendingInteractions.has(interaction.conversationKey)).toBe(false);
  });

  it("rejects clicks from non-requesters", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const replyPermission = vi.fn(async () => true);
    (app as unknown as { opencode: { replyPermission: typeof replyPermission } }).opencode = { replyPermission };

    const interaction = seedPermission(app);
    const card = await app.handlePermissionCardAction(
      "ou_other",
      interaction.permissionMessageId ?? "",
      buildActionValue(interaction, "once"),
    );

    expect(replyPermission).not.toHaveBeenCalled();
    expect(JSON.stringify(card)).toContain("当前按钮仅限本轮发起者处理");
    expect((app as unknown as { pendingInteractions: Map<string, unknown> }).pendingInteractions.has(interaction.conversationKey)).toBe(true);
  });

  it("returns an idempotent terminal card for resolved interactions", async () => {
    const outbound = createOutbound();
    const app = new BridgeApp(baseConfig(), outbound, logger(), createWhitelist());
    const replyPermission = vi.fn(async () => true);
    (app as unknown as { opencode: { replyPermission: typeof replyPermission } }).opencode = { replyPermission };

    const interaction = seedPermission(app, {
      resolvedAt: Date.now(),
      resolution: "deny",
    });
    const card = await app.handlePermissionCardAction(
      interaction.requesterOpenId,
      interaction.permissionMessageId ?? "",
      buildActionValue(interaction, "deny"),
    );

    expect(replyPermission).not.toHaveBeenCalled();
    expect(JSON.stringify(card)).toContain("当前权限请求已拒绝");
  });
});

function seedPermission(
  app: BridgeApp,
  overrides: Partial<PendingPermissionInteraction> = {},
): PendingPermissionInteraction {
  const interaction: PendingPermissionInteraction = {
    kind: "permission",
    chatId: "oc_chat_1",
    conversationKey: "oc_chat_1",
    replyToMessageId: "om_in_1",
    requesterOpenId: "ou_requester",
    sessionId: "ses_1",
    permissionId: "perm_1",
    permissionName: "rm -rf dist/",
    permissionMessageId: "om_perm_1",
    permissionVersion: "nonce_1",
    turnId: "turn_1",
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
  const appAny = app as unknown as {
    pendingInteractions: Map<string, unknown>;
    permissionInteractions: Map<string, PendingPermissionInteraction>;
  };
  appAny.pendingInteractions.set(interaction.conversationKey, interaction);
  appAny.permissionInteractions.set(interaction.permissionVersion, interaction);
  return interaction;
}

function buildActionValue(
  interaction: PendingPermissionInteraction,
  policy: PermissionCardActionValue["policy"],
): PermissionCardActionValue {
  return {
    kind: "permission",
    conversationKey: interaction.conversationKey,
    turnId: interaction.turnId,
    sessionId: interaction.sessionId,
    permissionId: interaction.permissionId,
    policy,
    nonce: interaction.permissionVersion,
  };
}

function baseConfig(): AppConfig {
  return {
    feishu: {
      appId: "app",
      appSecret: "secret",
      botOpenIds: new Set(["ou_bot"]),
      botMentionNames: new Set(["opencode"]),
      selfBotOpenIds: new Set(["ou_bot"]),
      wsUrl: new URL("wss://open.feishu.cn/open-apis/ws/v2"),
      allowedOpenIds: new Set(),
      behavior: {
        enableP2p: true,
        enableGroup: true,
        requireBotMentionInGroup: true,
        strictBotMention: true,
        ignoreNonUserSenders: true,
        replyInThread: true,
      },
      cardActions: {
        enabled: true,
        path: "/webhook/card",
        verificationToken: "token",
        encryptKey: "",
      },
    },
    opencode: {
      baseUrl: new URL("http://127.0.0.1:4096/"),
      directory: process.cwd(),
    },
    storage: {
      dataDir: process.cwd(),
      mappingsFile: "mappings.json",
    },
    server: {
      host: "127.0.0.1",
      port: 3000,
      publicBaseUrl: new URL("http://127.0.0.1:3000/"),
    },
    whitelist: {
      storePath: "whitelist.json",
    },
    bridge: {
      queueLimit: 3,
      sessionModes: {
        p2p: "multi",
        group: "single",
        topicGroup: "single",
      },
      maxSessionsPerWindow: 20,
      sessionListLimit: 10,
      injectSystemState: true,
      firstEventTimeoutMs: 30_000,
      eventGapTimeoutMs: 120_000,
      totalTimeoutMs: 300_000,
    },
    logging: {
      dir: process.cwd(),
      level: "info",
      enableTranscript: true,
      enableConsole: true,
      enableColor: true,
      rotateDaily: true,
    },
  };
}

function createOutbound() {
  return {
    sendMessage: vi.fn(async () => ({ messageId: "om_send" })),
    replyMessage: vi.fn(async () => ({ messageId: "om_reply" })),
    updateMessage: vi.fn(async () => ({ messageId: "om_update" })),
  };
}

function createWhitelist(): ChatWhitelist {
  return {
    isBound() {
      return false;
    },
    async bind() {},
    async unbind() {
      return false;
    },
    count() {
      return 0;
    },
  };
}

function logger() {
  return {
    log() {},
    logTranscript() {},
  };
}
