/**
 * 职责: 跟踪并清理每个 turn 创建的临时资源。
 * 关注点:
 * - 记录 turn 维度的文件、目录等资源路径。
 * - 在 turn 结束或全局清理时回收这些资源。
 */
import { rm } from "node:fs/promises";

import type { Logger } from "../logging/logger.js";

type TurnOwnedResource = {
  path: string;
};

export class TurnOwnedResourceStore {
  private readonly resources = new Map<string, TurnOwnedResource[]>();

  constructor(private readonly logger: Logger) {}

  //#region Registration
  // Attach one temporary resource path to a turn for later cleanup.
  register(turnId: string, resource: TurnOwnedResource): void {
    const existing = this.resources.get(turnId) ?? [];
    existing.push(resource);
    this.resources.set(turnId, existing);
  }
  //#endregion

  //#region Cleanup
  // Remove all resources registered under one completed turn.
  async cleanupTurn(turnId: string): Promise<void> {
    const resources = this.resources.get(turnId);
    if (!resources || resources.length === 0) {
      return;
    }
    this.resources.delete(turnId);
    await this.removeResources(turnId, resources);
  }

  // Remove all tracked resources, typically during process shutdown.
  async cleanupAll(): Promise<void> {
    const entries = [...this.resources.entries()];
    this.resources.clear();
    for (const [turnId, resources] of entries) {
      await this.removeResources(turnId, resources);
    }
  }
  //#endregion

  // Best-effort cleanup with warning logs instead of teardown failures.
  private async removeResources(turnId: string, resources: TurnOwnedResource[]): Promise<void> {
    for (const resource of resources) {
      try {
        await rm(resource.path, { recursive: true, force: true });
      } catch (error) {
        this.logger.log("runtime/turn-resources", "cleanup failed", {
          turnId,
          path: resource.path,
          detail: error instanceof Error ? error.message : String(error),
        }, "warn");
      }
    }
  }
}
