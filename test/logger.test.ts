import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createLogger, createTextPreview } from "../src/logging/logger.js";

describe("logger", () => {
  it("creates previews", () => {
    expect(createTextPreview("a".repeat(120)).length).toBeLessThanOrEqual(80);
  });

  it("writes transcript logs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir);
    logger.logTranscript("inbound", { chatId: "c" }, "hello");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(path.join(dir, `transcript-${day}.log`), "utf8");
    expect(content).toContain("hello");
  });

  it("writes bridge logs", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir);
    logger.log("scope", "message", { ok: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(path.join(dir, `bridge-${day}.log`), "utf8");
    expect(content).toContain("scope");
  });

  it("keeps transcript type labels stable", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir);
    logger.logTranscript("reasoning-raw", { chatId: "c" }, "think");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const day = new Date().toISOString().slice(0, 10);
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
    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(path.join(dir, `transcript-${day}.log`), "utf8");
    expect(content).toContain("payload");
  });

  it("writes outbound final transcripts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir);
    logger.logTranscript("outbound-final", { chatId: "c" }, "final");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(path.join(dir, `transcript-${day}.log`), "utf8");
    expect(content).toContain("final");
  });

  it("writes opencode reply transcripts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "bridge-logger-"));
    const logger = await createLogger(dir);
    logger.logTranscript("opencode-reply", { sessionId: "s" }, "reply");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(path.join(dir, `transcript-${day}.log`), "utf8");
    expect(content).toContain("reply");
  });
});
