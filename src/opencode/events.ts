type EventListener = (event: OpenCodeEvent) => void | Promise<void>;

export type OpenCodeEvent = {
  type: string;
  properties: Record<string, unknown>;
};

export class OpenCodeEventStream {
  private readonly listeners = new Set<EventListener>();
  private controller: AbortController | null = null;

  constructor(private readonly baseUrl: URL, private readonly directory: string, private readonly logger: { log: (...args: any[]) => void }) {}

  async start(): Promise<void> {
    this.controller = new AbortController();
    this.logger.log("opencode/events", "event stream connected", {});
  }

  async stop(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async emit(event: OpenCodeEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }
}

export function getEventSessionId(event: OpenCodeEvent): string | null {
  if (typeof event.properties.sessionID === "string") {
    return event.properties.sessionID;
  }
  if (typeof event.properties.sessionId === "string") {
    return event.properties.sessionId;
  }

  return null;
}
