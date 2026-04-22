/**
 * 职责: 为飞书 Node SDK 补充项目内需要的类型声明。
 * 关注点:
 * - 弥补上游类型不完整或缺失的部分。
 * - 让 TypeScript 能安全消费 SDK 暴露的关键能力。
 */
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
