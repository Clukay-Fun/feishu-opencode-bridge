declare module "@larksuiteoapi/node-sdk" {
  export class EventDispatcher {
    constructor(initial?: Record<string, unknown>);
    register(handlers: Record<string, (data: unknown) => Promise<void> | void>): EventDispatcher;
  }

  export class WSClient {
    constructor(options: {
      appId: string;
      appSecret: string;
    });
    start(params: {
      eventDispatcher: EventDispatcher;
    }): Promise<void>;
    stop(): void;
  }
}
