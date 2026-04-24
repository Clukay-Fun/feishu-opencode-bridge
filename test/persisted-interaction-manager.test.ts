/**
 * 职责: 覆盖挂起交互持久化管理器行为。
 * 关注点: 验证核心路径、边界条件和回归场景。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { PersistedInteractionManager } from "../src/runtime/persisted-interaction-manager.js";

type TestInteraction = {
  conversationKey: string;
  expiresAt: number;
  label: string;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("PersistedInteractionManager", () => {
  it("restores unexpired interactions and prunes expired ones", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "persisted-interactions-"));
    const stateFilePath = path.join(tempDir, "state.json");
    await writeFile(stateFilePath, JSON.stringify({
      version: 1,
      interactions: [
        { conversationKey: "expired", expiresAt: Date.now() - 1_000, label: "old" },
        { conversationKey: "active", expiresAt: Date.now() + 60_000, label: "new" },
      ],
    }), "utf8");

    const manager = new PersistedInteractionManager<TestInteraction>({
      stateFilePath,
      logger: { log: vi.fn() } as never,
      logScope: "test/persisted",
      getKey: (interaction) => interaction.conversationKey,
      getExpiresAt: (interaction) => interaction.expiresAt,
    });

    await manager.restore();

    expect(manager.get("active")).toEqual(expect.objectContaining({ label: "new" }));
    expect(manager.get("expired")).toBeUndefined();

    const persisted = JSON.parse(await readFile(stateFilePath, "utf8")) as { interactions: TestInteraction[] };
    expect(persisted.interactions).toHaveLength(1);
    expect(persisted.interactions[0]?.conversationKey).toBe("active");

    await manager.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("expires interactions via timer and persists the removal", async () => {
    vi.useFakeTimers();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "persisted-interactions-"));
    const stateFilePath = path.join(tempDir, "state.json");
    const onExpire = vi.fn(async () => {});
    const manager = new PersistedInteractionManager<TestInteraction>({
      stateFilePath,
      logger: { log: vi.fn() } as never,
      logScope: "test/persisted",
      getKey: (interaction) => interaction.conversationKey,
      getExpiresAt: (interaction) => interaction.expiresAt,
      onExpire,
    });

    manager.set({
      conversationKey: "active",
      expiresAt: Date.now() + 100,
      label: "soon",
    });
    await manager.flush();

    await vi.advanceTimersByTimeAsync(150);
    await manager.flush();

    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(manager.get("active")).toBeUndefined();

    const persisted = JSON.parse(await readFile(stateFilePath, "utf8")) as { interactions: TestInteraction[] };
    expect(persisted.interactions).toEqual([]);

    await manager.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("flushes the latest state before stop clears in-memory entries", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "persisted-interactions-"));
    const stateFilePath = path.join(tempDir, "state.json");
    const manager = new PersistedInteractionManager<TestInteraction>({
      stateFilePath,
      logger: { log: vi.fn() } as never,
      logScope: "test/persisted",
      getKey: (interaction) => interaction.conversationKey,
      getExpiresAt: (interaction) => interaction.expiresAt,
    });

    manager.set({
      conversationKey: "active",
      expiresAt: Date.now() + 60_000,
      label: "saved",
    });
    await manager.stop();

    expect(manager.get("active")).toBeUndefined();

    const persisted = JSON.parse(await readFile(stateFilePath, "utf8")) as { interactions: TestInteraction[] };
    expect(persisted.interactions).toEqual([
      expect.objectContaining({ conversationKey: "active", label: "saved" }),
    ]);

    await rm(tempDir, { recursive: true, force: true });
  });

  it("ignores already-expired interactions passed to set()", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "persisted-interactions-"));
    const stateFilePath = path.join(tempDir, "state.json");
    const manager = new PersistedInteractionManager<TestInteraction>({
      stateFilePath,
      logger: { log: vi.fn() } as never,
      logScope: "test/persisted",
      getKey: (interaction) => interaction.conversationKey,
      getExpiresAt: (interaction) => interaction.expiresAt,
    });

    manager.set({
      conversationKey: "expired",
      expiresAt: Date.now() - 1,
      label: "old",
    });
    await manager.flush();

    expect(manager.get("expired")).toBeUndefined();
    await expect(readFile(stateFilePath, "utf8")).rejects.toThrow();

    await manager.stop();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("logs persist failures and keeps flush non-throwing", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "persisted-interactions-"));
    const logger = { log: vi.fn() };
    const manager = new PersistedInteractionManager<TestInteraction>({
      stateFilePath: tempDir,
      logger: logger as never,
      logScope: "test/persisted",
      getKey: (interaction) => interaction.conversationKey,
      getExpiresAt: (interaction) => interaction.expiresAt,
    });

    manager.set({
      conversationKey: "active",
      expiresAt: Date.now() + 60_000,
      label: "saved",
    });

    await expect(manager.flush()).resolves.toBeUndefined();
    expect(logger.log).toHaveBeenCalledWith(
      "test/persisted",
      "persist state failed",
      expect.objectContaining({ detail: expect.any(String) }),
      "warn",
    );

    await manager.stop();
    await rm(tempDir, { recursive: true, force: true });
  });
});
