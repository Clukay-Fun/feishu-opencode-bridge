import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, createTextPreview, runWithLogContext } from "../src/logging/logger.js";

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("creates previews", () => {
    expect(createTextPreview("a".repeat(120)).length).toBeLessThanOrEqual(80);
  });

  it("writes transcript logs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir);
    logger.logTranscript("inbound", { chatId: "c" }, "hello");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const day = localDay();
    const content = await readFile(path.join(dir, `transcript-${day}.log`), "utf8");
    expect(content).toContain("hello");
  });

  it("writes bridge logs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir);
    logger.log("scope", "message", { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const day = localDay();
    const content = await readFile(path.join(dir, `bridge-${day}.log`), "utf8");
    expect(content).toContain("scope");
  });

  it("keeps transcript type labels stable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir);
    logger.logTranscript("reasoning-raw", { chatId: "c" }, "think");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const day = localDay();
    const content = await readFile(path.join(dir, `transcript-${day}.log`), "utf8");
    expect(content).toContain("OpenCode思考原文");
  });

  it("normalizes preview whitespace", () => {
    expect(createTextPreview("a\n\n b")).toBe("a b");
  });

  it("preserves short preview", () => {
    expect(createTextPreview("hello")).toBe("hello");
  });

  it("writes outbound process transcripts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir);
    logger.logTranscript("outbound-process", { chatId: "c" }, "payload");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const day = localDay();
    const content = await readFile(path.join(dir, `transcript-${day}.log`), "utf8");
    expect(content).toContain("payload");
  });

  it("writes outbound final transcripts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir);
    logger.logTranscript("outbound-final", { chatId: "c" }, "final");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const day = localDay();
    const content = await readFile(path.join(dir, `transcript-${day}.log`), "utf8");
    expect(content).toContain("final");
  });

  it("writes opencode reply transcripts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir);
    logger.logTranscript("opencode-reply", { sessionId: "s" }, "reply");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const day = localDay();
    const content = await readFile(path.join(dir, `transcript-${day}.log`), "utf8");
    expect(content).toContain("reply");
  });

  it("honors level filtering and console output settings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = await createLogger(dir, {
      level: "warn",
      enableConsole: false,
      enableColor: false,
    });

    logger.log("scope", "info message", {}, "info");
    logger.log("scope", "warn message", {}, "warn");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const day = localDay();
    const content = await readFile(path.join(dir, `bridge-${day}.log`), "utf8");
    expect(content).not.toContain("info message");
    expect(content).toContain("warn message");
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("honors transcript and rotation settings", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir, {
      enableTranscript: false,
      rotateDaily: false,
    });

    logger.log("scope", "message", {});
    logger.logTranscript("inbound", { chatId: "c" }, "hidden");
    await new Promise((resolve) => setTimeout(resolve, 20));

    const bridgeContent = await readFile(path.join(dir, "bridge.log"), "utf8");
    expect(bridgeContent).toContain("message");
    await expect(readFile(path.join(dir, "transcript.log"), "utf8")).rejects.toThrow();
  });

  it("rotates daily using the local date instead of UTC", async () => {
    vi.spyOn(Date.prototype, "getFullYear").mockReturnValue(2026);
    vi.spyOn(Date.prototype, "getMonth").mockReturnValue(3);
    vi.spyOn(Date.prototype, "getDate").mockReturnValue(12);
    vi.spyOn(Date.prototype, "toISOString").mockReturnValue("2026-04-11T16:00:00.000Z");

    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir);
    logger.log("scope", "message", {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    const content = await readFile(path.join(dir, "bridge-2026-04-12.log"), "utf8");
    expect(content).toContain("scope");
    expect(content).toContain("message");
  });

  it("adds async log context to bridge logs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir, { enableConsole: false });
    await runWithLogContext({ correlationId: "corr-1", turnId: "turn-1" }, async () => {
      logger.log("scope", "message", { ok: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const content = await readFile(path.join(dir, `bridge-${localDay()}.log`), "utf8");
    expect(content).toContain("correlationId=\"corr-1\"");
    expect(content).toContain("turnId=\"turn-1\"");
  });

  it("writes json bridge logs and redacts configured fields", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir, {
      enableConsole: false,
      format: "json",
      redactFields: ["secret"],
    });

    logger.event?.("scope", "turn.started", {
      turnId: "turn-1",
      sessionId: "session-1",
      chatId: "chat-1",
      conversationKey: "conversation-1",
      secret: "hidden",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const content = await readFile(path.join(dir, `bridge-${localDay()}.log`), "utf8");
    const line = JSON.parse(content) as Record<string, unknown>;
    expect(line.event).toBe("turn.started");
    expect(line.turnId).toBe("turn-1");
    expect(line.secret).toBe("[REDACTED]");
  });
});

function localDay(value = new Date()): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
