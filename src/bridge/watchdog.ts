/**
 * 职责: 监控 turn 执行过程中的关键超时，并触发对应兜底回调。
 * 关注点:
 * - 检查首个事件超时、事件间隔超时和总执行时长超时。
 * - 将超时处理与具体业务逻辑解耦，交由外部回调完成。
 */
type WatchdogHandlers = {
  onFirstEventTimeout: () => void;
  onEventGapTimeout: () => void;
  onTotalTimeout: () => void;
};

type WatchdogConfig = {
  firstEventTimeoutMs: number;
  eventGapTimeoutMs: number;
  totalTimeoutMs: number;
};

export class TurnWatchdog {
  private firstEventTimer: NodeJS.Timeout | null = null;
  private eventGapTimer: NodeJS.Timeout | null = null;
  private totalTimer: NodeJS.Timeout | null = null;
  private seenEvent = false;

  constructor(private readonly config: WatchdogConfig, private readonly handlers: WatchdogHandlers) {}

  /** 启动首包和总时长两个超时计时器。 */
  start(): void {
    this.firstEventTimer = setTimeout(() => this.handlers.onFirstEventTimeout(), this.config.firstEventTimeoutMs);
    this.totalTimer = setTimeout(() => this.handlers.onTotalTimeout(), this.config.totalTimeoutMs);
  }

  /** 标记收到新事件，并刷新事件间隔超时。 */
  markEvent(): void {
    if (!this.seenEvent) {
      this.markFirstEventSeen();
    }

    this.scheduleEventGap(this.config.eventGapTimeoutMs);
  }

  /** 在权限等待等场景临时延长事件间隔超时。 */
  snoozeEventGap(timeoutMs: number): void {
    if (!this.seenEvent) {
      this.markFirstEventSeen();
    }
    this.scheduleEventGap(timeoutMs);
  }

  /** 清理所有计时器。 */
  clear(): void {
    if (this.firstEventTimer) {
      clearTimeout(this.firstEventTimer);
      this.firstEventTimer = null;
    }
    if (this.eventGapTimer) {
      clearTimeout(this.eventGapTimer);
      this.eventGapTimer = null;
    }
    if (this.totalTimer) {
      clearTimeout(this.totalTimer);
      this.totalTimer = null;
    }
  }

  /** 标记已经见到首个事件，并关闭首包超时。 */
  private markFirstEventSeen(): void {
    this.seenEvent = true;
    if (this.firstEventTimer) {
      clearTimeout(this.firstEventTimer);
      this.firstEventTimer = null;
    }
  }

  /** 重新安排事件间隔超时。 */
  private scheduleEventGap(timeoutMs: number): void {
    if (this.eventGapTimer) {
      clearTimeout(this.eventGapTimer);
    }
    this.eventGapTimer = setTimeout(() => this.handlers.onEventGapTimeout(), timeoutMs);
  }
}
