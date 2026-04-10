export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const active = (this.windows.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (active.length >= this.maxRequests) {
      this.windows.set(key, active);
      return false;
    }
    active.push(now);
    this.windows.set(key, active);
    return true;
  }
}
