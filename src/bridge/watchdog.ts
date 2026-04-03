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

  start(): void {
    this.firstEventTimer = setTimeout(() => this.handlers.onFirstEventTimeout(), this.config.firstEventTimeoutMs);
    this.totalTimer = setTimeout(() => this.handlers.onTotalTimeout(), this.config.totalTimeoutMs);
  }

  markEvent(): void {
    if (!this.seenEvent) {
      this.seenEvent = true;
      if (this.firstEventTimer) {
        clearTimeout(this.firstEventTimer);
        this.firstEventTimer = null;
      }
    }

    if (this.eventGapTimer) {
      clearTimeout(this.eventGapTimer);
    }

    this.eventGapTimer = setTimeout(() => this.handlers.onEventGapTimeout(), this.config.eventGapTimeoutMs);
  }

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
}
