/**
 * Tests for VisibilityStore - window snapshots and recent materials.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VisibilityStore } from "../src/mcp/visibility-store.js";

describe("VisibilityStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "visibility-store-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes and reads window snapshot", () => {
    const store = new VisibilityStore(tmpDir);

    store.writeWindowSnapshot("conv-1", {
      window: {
        window_key: "conv-1",
        chat_type: "p2p",
        mode: "multi",
        interaction_mode: "default",
        active_session_id: "ses-1",
        bound_sessions: [
          { session_id: "ses-1", short_id: "ses-1", label: "Test Session", is_active: true, last_used_at: new Date().toISOString() },
        ],
      },
      management_commands: ["/sessions", "/new", "/close"],
    });

    const snapshot = store.readWindowSnapshot("conv-1");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.window!.window_key).toBe("conv-1");
    expect(snapshot!.window!.bound_sessions).toHaveLength(1);
    expect(snapshot!.window!.bound_sessions[0]!.label).toBe("Test Session");
  });

  it("returns null for expired window snapshot", async () => {
    const store = new VisibilityStore(tmpDir);

    // Write a snapshot with old timestamp
    store.writeWindowSnapshot("conv-1", {
      window: {
        window_key: "conv-1",
        chat_type: "p2p",
        mode: "multi",
        interaction_mode: "default",
        active_session_id: null,
        bound_sessions: [],
      },
      management_commands: [],
    });

    // Manually modify the file to have an old timestamp
    const filePath = path.join(tmpDir, "agent-visibility", "current-window", "conv-1.json");
    const content = JSON.parse(await readFile(filePath, "utf-8"));
    content.as_of = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    await writeFile(filePath, JSON.stringify(content));

    const snapshot = store.readWindowSnapshot("conv-1");
    expect(snapshot).toBeNull();
  });

  it("appends and reads materials", () => {
    const store = new VisibilityStore(tmpDir);

    store.appendMaterial({
      window_key: "window-1",
      message_id: "msg-1",
      file_name: "合同.pdf",
      type: "pdf",
      size: 102400,
      received_at: new Date().toISOString(),
    });

    store.appendMaterial({
      window_key: "window-2",
      message_id: "msg-2",
      file_name: "发票.png",
      type: "image",
      size: 51200,
      received_at: new Date().toISOString(),
    });

    const snapshot = store.readMaterialsSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.materials).toHaveLength(2);
    expect(snapshot!.materials[0]!.file_name).toBe("发票.png"); // most recent first
    expect(snapshot!.materials[0]!.window_key).toBe("window-2");
    expect(snapshot!.materials[0]!.message_id).toBe("msg-2");
    expect(snapshot!.materials[1]!.file_name).toBe("合同.pdf");
    expect(snapshot!.suggested_actions).toContain("总结主要内容");
  });

  it("filters materials by window_key", () => {
    const store = new VisibilityStore(tmpDir);

    store.appendMaterial({
      window_key: "window-1",
      message_id: "msg-1",
      file_name: "合同.pdf",
      type: "pdf",
      size: 102400,
      received_at: new Date().toISOString(),
    });

    store.appendMaterial({
      window_key: "window-2",
      message_id: "msg-2",
      file_name: "发票.png",
      type: "image",
      size: 51200,
      received_at: new Date().toISOString(),
    });

    const snapshot = store.readMaterialsSnapshot({ window_key: "window-1" });
    expect(snapshot).not.toBeNull();
    expect(snapshot!.materials).toHaveLength(1);
    expect(snapshot!.materials[0]!.file_name).toBe("合同.pdf");
  });

  it("limits materials to MAX_MATERIALS", () => {
    const store = new VisibilityStore(tmpDir);

    for (let i = 0; i < 25; i++) {
      store.appendMaterial({
        window_key: "window-1",
        message_id: `msg-${i}`,
        file_name: `file-${i}.txt`,
        type: "txt",
        size: 100,
        received_at: new Date().toISOString(),
      });
    }

    const snapshot = store.readMaterialsSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.materials.length).toBeLessThanOrEqual(20);
  });

  it("returns null for expired materials snapshot", async () => {
    const store = new VisibilityStore(tmpDir);

    store.appendMaterial({
      window_key: "window-1",
      message_id: "msg-1",
      file_name: "old.pdf",
      type: "pdf",
      size: 1000,
      received_at: new Date().toISOString(),
    });

    // Manually modify the file to have an old timestamp
    const filePath = path.join(tmpDir, "agent-visibility", "recent-materials.json");
    const content = JSON.parse(await readFile(filePath, "utf-8"));
    content.as_of = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 min ago
    await writeFile(filePath, JSON.stringify(content));

    const snapshot = store.readMaterialsSnapshot();
    expect(snapshot).toBeNull();
  });

  it("returns null for non-existent snapshot", () => {
    const store = new VisibilityStore(tmpDir);
    expect(store.readWindowSnapshot("nonexistent")).toBeNull();
    expect(store.readMaterialsSnapshot()).toBeNull();
  });
});

// Helper to write file
import { writeFile } from "node:fs/promises";
