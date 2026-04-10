import { describe, expect, it } from "vitest";

import { SlidingWindowRateLimiter } from "../src/runtime/rate-limiter.js";

describe("SlidingWindowRateLimiter", () => {
  it("allows up to 20 requests within the window", () => {
    const limiter = new SlidingWindowRateLimiter(20, 60_000);

    for (let index = 0; index < 20; index += 1) {
      expect(limiter.allow("ou_123", index)).toBe(true);
    }

    expect(limiter.allow("ou_123", 20)).toBe(false);
  });

  it("allows requests again after the window expires", () => {
    const limiter = new SlidingWindowRateLimiter(2, 1_000);

    expect(limiter.allow("ou_123", 0)).toBe(true);
    expect(limiter.allow("ou_123", 100)).toBe(true);
    expect(limiter.allow("ou_123", 200)).toBe(false);
    expect(limiter.allow("ou_123", 1_101)).toBe(true);
  });
});
