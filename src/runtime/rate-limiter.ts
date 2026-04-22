/**
 * 职责: 提供基于滑动时间窗的请求限流能力。
 * 关注点:
 * - 以用户维度记录请求时间戳并判断是否超限。
 * - 在入口处拦截短时间内的过量请求。
 */
export class SlidingWindowRateLimiter {
  private readonly windows = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  /** 判断当前请求是否可通过，并同步更新窗口状态。 */
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
