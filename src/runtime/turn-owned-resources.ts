import { rm } from "node:fs/promises";

import type { Logger } from "../logging/logger.js";

type TurnOwnedResource = {
  path: string;
};

export class TurnOwnedResourceStore {
  private readonly resources = new Map<string, TurnOwnedResource[]>();

  constructor(private readonly logger: Logger) {}

  register(turnId: string, resource: TurnOwnedResource): void {
    const existing = this.resources.get(turnId) ?? [];
    existing.push(resource);
    this.resources.set(turnId, existing);
  }

  async cleanupTurn(turnId: string): Promise<void> {
    const resources = this.resources.get(turnId);
    if (!resources || resources.length === 0) {
      return;
    }
    this.resources.delete(turnId);
    await this.removeResources(turnId, resources);
  }

  async cleanupAll(): Promise<void> {
    const entries = [...this.resources.entries()];
    this.resources.clear();
    for (const [turnId, resources] of entries) {
      await this.removeResources(turnId, resources);
    }
  }

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
