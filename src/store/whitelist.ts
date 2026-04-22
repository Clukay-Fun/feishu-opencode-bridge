/**
 * 职责: 管理群聊中的授权白名单。
 * 关注点:
 * - 维护 chatId 与用户授权关系。
 * - 支持动态绑定、解绑以及重启后的持久化恢复。
 */
import path from "node:path";

import { JsonStore } from "./json-store.js";

export type ChatWhitelist = {
  isBound(chatId: string, senderOpenId: string): boolean;
  bind(chatId: string, senderOpenId: string): Promise<void>;
  unbind(chatId: string, senderOpenId: string): Promise<boolean>;
  count(chatId: string): number;
};

type LoggerLike = {
  log: (scope: string, message: string, fields?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
};

type WhitelistFile = {
  version: 1;
  bindings: Record<string, string[]>;
};

const WHITELIST_VERSION = 1 as const;

export class WhitelistStore extends JsonStore<unknown> implements ChatWhitelist {
  private bindings = new Map<string, Set<string>>();

  constructor(
    storePath: string,
    private readonly logger?: LoggerLike,
  ) {
    super(path.dirname(storePath), path.basename(storePath), { version: WHITELIST_VERSION, bindings: {} } satisfies WhitelistFile);
  }

  /** 加载白名单文件，并还原为内存映射结构。 */
  async load(): Promise<Map<string, Set<string>>> {
    const loaded = await super.load();
    this.bindings = isWhitelistFile(loaded)
      ? normalizeBindings(loaded.bindings)
      : new Map();
    return this.bindings;
  }

  /** 判断用户是否已绑定到指定群聊白名单。 */
  isBound(chatId: string, senderOpenId: string): boolean {
    return this.bindings.get(chatId)?.has(senderOpenId) ?? false;
  }

  /** 绑定指定群聊与用户。 */
  async bind(chatId: string, senderOpenId: string): Promise<void> {
    const members = this.bindings.get(chatId) ?? new Set<string>();
    if (!this.bindings.has(chatId)) {
      this.bindings.set(chatId, members);
    }
    members.add(senderOpenId);
    await this.persist();
  }

  /** 解绑指定群聊与用户；如果不存在则返回 false。 */
  async unbind(chatId: string, senderOpenId: string): Promise<boolean> {
    const members = this.bindings.get(chatId);
    if (!members?.has(senderOpenId)) {
      return false;
    }

    members.delete(senderOpenId);
    if (members.size === 0) {
      this.bindings.delete(chatId);
    }
    await this.persist();
    return true;
  }

  /** 返回指定群聊当前已绑定人数。 */
  count(chatId: string): number {
    return this.bindings.get(chatId)?.size ?? 0;
  }

  /** 将当前内存态绑定关系持久化到磁盘。 */
  private async persist(): Promise<void> {
    const file = {
      version: WHITELIST_VERSION,
      bindings: Object.fromEntries(
        [...this.bindings.entries()]
          .filter(([, members]) => members.size > 0)
          .map(([chatId, members]) => [chatId, [...members].sort()]),
      ),
    } satisfies WhitelistFile;
    await super.save(file);
    this.logger?.log("store/whitelist", "whitelist saved", {
      chatCount: Object.keys(file.bindings).length,
    }, "debug");
  }
}

/** 判断对象是否符合 whitelist 文件结构。 */
function isWhitelistFile(value: unknown): value is WhitelistFile {
  return isRecord(value) && value.version === WHITELIST_VERSION && isRecord(value.bindings);
}

/** 把磁盘结构转换为更适合运行时使用的 Map + Set。 */
function normalizeBindings(bindings: Record<string, unknown>): Map<string, Set<string>> {
  return new Map(
    Object.entries(bindings)
      .map(([chatId, members]) => {
        if (!Array.isArray(members)) {
          return null;
        }
        const normalizedMembers = members.filter((member): member is string => typeof member === "string" && member.length > 0);
        return [chatId, new Set(normalizedMembers)] as const;
      })
      .filter((entry): entry is readonly [string, Set<string>] => entry !== null),
  );
}

/** 判断一个值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
