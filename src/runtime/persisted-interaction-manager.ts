import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../logging/logger.js";

type PersistedInteractionManagerOptions<T> = {
  stateFilePath: string;
  logger: Logger;
  logScope: string;
  getKey(interaction: T): string;
  getExpiresAt(interaction: T): number;
  onExpire?(interaction: T): Promise<void> | void;
};

export class PersistedInteractionManager<T> {
  private readonly interactions = new Map<string, T>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: PersistedInteractionManagerOptions<T>) {}

  async restore(): Promise<void> {
    const interactions = await this.readPersistedInteractions();
    const now = Date.now();
    let changed = false;
    for (const interaction of interactions) {
      const key = this.options.getKey(interaction);
      const expiresAt = this.options.getExpiresAt(interaction);
      if (expiresAt <= now) {
        changed = true;
        continue;
      }
      this.interactions.set(key, interaction);
      this.restoreTimer(key, expiresAt - now);
    }
    if (changed) {
      this.schedulePersist();
      await this.flush();
    }
  }

  async stop(): Promise<void> {
    await this.flush();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.interactions.clear();
  }

  get(key: string): T | undefined {
    return this.interactions.get(key);
  }

  has(key: string): boolean {
    return this.interactions.has(key);
  }

  set(interaction: T): void {
    const key = this.options.getKey(interaction);
    const expiresAt = this.options.getExpiresAt(interaction);
    if (expiresAt <= Date.now()) {
      this.delete(key);
      return;
    }
    this.interactions.set(key, interaction);
    this.restoreTimer(key, expiresAt - Date.now());
    this.schedulePersist();
  }

  delete(key: string): boolean {
    const removed = this.interactions.delete(key);
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    if (removed) {
      this.schedulePersist();
    }
    return removed;
  }

  touch(key: string, expiresAt: number): void {
    const interaction = this.interactions.get(key);
    if (!interaction) {
      return;
    }
    if (expiresAt <= Date.now()) {
      void this.expireInteraction(key);
      return;
    }
    this.restoreTimer(key, expiresAt - Date.now());
    this.schedulePersist();
  }

  entries(): IterableIterator<[string, T]> {
    return this.interactions.entries();
  }

  values(): IterableIterator<T> {
    return this.interactions.values();
  }

  // `flush()` never throws. Persist failures are logged in `schedulePersist()`
  // so shutdown and restore paths can keep moving.
  async flush(): Promise<void> {
    await this.persistChain;
  }

  private restoreTimer(key: string, timeoutMs: number): void {
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      void this.expireInteraction(key);
    }, Math.max(1, timeoutMs));
    this.timers.set(key, timer);
  }

  private async expireInteraction(key: string): Promise<void> {
    const interaction = this.interactions.get(key);
    if (!interaction) {
      return;
    }
    this.delete(key);
    try {
      await this.options.onExpire?.(interaction);
    } catch (error) {
      this.options.logger.log(this.options.logScope, "expire callback failed", {
        key,
        detail: error instanceof Error ? error.message : String(error),
      }, "warn");
    }
  }

  private async readPersistedInteractions(): Promise<T[]> {
    try {
      const raw = await readFile(this.options.stateFilePath, "utf8");
      const parsed = JSON.parse(raw) as { version?: number; interactions?: T[] };
      return Array.isArray(parsed.interactions) ? parsed.interactions : [];
    } catch {
      return [];
    }
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.options.stateFilePath), { recursive: true });
        await writeFile(this.options.stateFilePath, JSON.stringify({
          version: 1,
          interactions: [...this.interactions.values()],
        }, null, 2), "utf8");
      })
      .catch((error) => {
        this.options.logger.log(this.options.logScope, "persist state failed", {
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      });
  }
}
