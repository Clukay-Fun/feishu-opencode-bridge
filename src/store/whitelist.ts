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

  async load(): Promise<Map<string, Set<string>>> {
    const loaded = await super.load();
    this.bindings = isWhitelistFile(loaded)
      ? normalizeBindings(loaded.bindings)
      : new Map();
    return this.bindings;
  }

  isBound(chatId: string, senderOpenId: string): boolean {
    return this.bindings.get(chatId)?.has(senderOpenId) ?? false;
  }

  async bind(chatId: string, senderOpenId: string): Promise<void> {
    const members = this.bindings.get(chatId) ?? new Set<string>();
    if (!this.bindings.has(chatId)) {
      this.bindings.set(chatId, members);
    }
    members.add(senderOpenId);
    await this.persist();
  }

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

  count(chatId: string): number {
    return this.bindings.get(chatId)?.size ?? 0;
  }

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

function isWhitelistFile(value: unknown): value is WhitelistFile {
  return isRecord(value) && value.version === WHITELIST_VERSION && isRecord(value.bindings);
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
