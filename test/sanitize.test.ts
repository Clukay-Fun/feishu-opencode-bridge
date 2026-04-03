import { describe, expect, it } from "vitest";

import { cleanAssistantReply } from "../src/runtime/sanitize.js";

describe("cleanAssistantReply", () => {
  it("removes system reminders", () => {
    const value = cleanAssistantReply("hello\n<system-reminder>internal</system-reminder>\nworld");
    expect(value).toBe("hello\n\nworld");
  });
});
