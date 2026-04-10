import { createOpenCodeHeaders } from "./client.js";

type EventListener = (event: OpenCodeEvent) => void | Promise<void>;

type LoggerLike = {
  log: (scope: string, message: string, fields?: Record<string, unknown>, level?: "debug" | "info" | "warn" | "error") => void;
};

type StreamEndpoint = "/event" | "/global/event";

type OpenCodeEventPayload = {
  type: string;
  properties: Record<string, unknown>;
};

export const KNOWN_EVENTS = [
  "server.connected",
  "server.heartbeat",
  "session.created",
  "session.updated",
  "session.status",
  "session.idle",
  "session.diff",
  "session.error",
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "permission.asked",
  "question.asked",
] as const;

export type KnownOpenCodeEvent = (typeof KNOWN_EVENTS)[number];

export type OpenCodeConnectionState = "connecting" | "connected" | "reconnecting" | "stopped";

export type OpenCodeEvent = {
  type: string;
  properties: Record<string, unknown>;
  sessionId: string | null;
  receivedAt: number;
  streamEndpoint: StreamEndpoint;
  raw: unknown;
};

const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export class OpenCodeEventStream {
  private readonly listeners = new Set<EventListener>();
  private readonly seenUnknownEvents = new Set<string>();
  private controller: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  private state: OpenCodeConnectionState = "stopped";

  constructor(private readonly baseUrl: URL, private readonly logger: LoggerLike) {}

  async start(): Promise<void> {
    if (this.loopPromise) {
      return;
    }

    this.controller = new AbortController();
    this.state = "connecting";
    this.loopPromise = this.run(this.controller.signal).catch((error) => {
      if (!this.controller?.signal.aborted) {
        const detail = error instanceof Error ? error.message : String(error);
        this.logger.log("opencode/events", "event stream stopped unexpectedly", { detail }, "error");
      }
    });
  }

  async stop(): Promise<void> {
    this.state = "stopped";
    this.controller?.abort();
    this.controller = null;
    await this.loopPromise;
    this.loopPromise = null;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getConnectionState(): OpenCodeConnectionState {
    return this.state;
  }

  async emit(event: OpenCodeEvent): Promise<void> {
    for (const listener of this.listeners) {
      await listener(event);
    }
  }

  private async run(signal: AbortSignal): Promise<void> {
    let attempt = 0;

    while (!signal.aborted) {
      this.state = attempt === 0 ? "connecting" : "reconnecting";

      try {
        const stream = await this.connect(signal);
        attempt = 0;
        this.state = "connected";
        this.logger.log("opencode/events", "event stream connected", { endpoint: stream.endpoint });
        await this.consumeStream(stream.response, stream.endpoint, signal);
        if (signal.aborted) {
          break;
        }
        this.logger.log("opencode/events", "event stream disconnected", { endpoint: stream.endpoint }, "warn");
      } catch (error) {
        if (signal.aborted) {
          break;
        }

        const detail = error instanceof Error ? error.message : String(error);
        this.logger.log("opencode/events", "event stream connection failed", { detail, attempt }, "warn");
      }

      const delayMs = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)] ?? 30_000;
      attempt += 1;
      await sleep(delayMs, signal);
    }

    this.state = "stopped";
  }

  private async connect(signal: AbortSignal): Promise<{ response: Response; endpoint: StreamEndpoint }> {
    const endpoints: StreamEndpoint[] = ["/event", "/global/event"];
    let lastError: Error | null = null;

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(new URL(endpoint.replace(/^\//, ""), this.baseUrl), {
          method: "GET",
          headers: createOpenCodeHeaders({ Accept: "text/event-stream" }),
          signal,
        });

        if (!response.ok || !response.body) {
          lastError = new Error(`OpenCode event stream failed: ${response.status} ${response.statusText}`);
          continue;
        }

        return { response, endpoint };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw lastError ?? new Error("OpenCode event stream failed");
  }

  private async consumeStream(response: Response, endpoint: StreamEndpoint, signal: AbortSignal): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("OpenCode event stream has no readable body");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      const chunks = splitSseBuffer(buffer);
      buffer = chunks.rest;

      for (const rawBlock of chunks.blocks) {
        const parsed = parseSseBlock(rawBlock, endpoint);
        if (!parsed) {
          if (rawBlock.trim()) {
            this.logger.log("opencode/events", "unparseable SSE block skipped", {
              endpoint,
              preview: rawBlock.slice(0, 200),
            }, "warn");
          }
          continue;
        }
        if (!isKnownEventType(parsed.type) && !this.seenUnknownEvents.has(parsed.type)) {
          this.seenUnknownEvents.add(parsed.type);
          this.logger.log("opencode/events", "unknown event type received", { type: parsed.type }, "warn");
        }
        await this.emit(parsed);
      }
    }
  }
}

export function getEventSessionId(event: Pick<OpenCodeEvent, "properties" | "sessionId">): string | null {
  if (typeof event.sessionId === "string") {
    return event.sessionId;
  }

  if (typeof event.properties.sessionID === "string") {
    return event.properties.sessionID;
  }
  if (typeof event.properties.sessionId === "string") {
    return event.properties.sessionId;
  }

  const info = readRecord(event.properties.info);
  if (info && typeof info.sessionID === "string") {
    return info.sessionID;
  }
  if (info && typeof info.sessionId === "string") {
    return info.sessionId;
  }

  const part = readRecord(event.properties.part);
  if (part && typeof part.sessionID === "string") {
    return part.sessionID;
  }
  if (part && typeof part.sessionId === "string") {
    return part.sessionId;
  }

  return null;
}

function isKnownEventType(type: string): type is KnownOpenCodeEvent {
  return (KNOWN_EVENTS as readonly string[]).includes(type);
}

function splitSseBuffer(buffer: string): { blocks: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks: string[] = [];
  let cursor = 0;
  let separatorIndex = normalized.indexOf("\n\n", cursor);
  while (separatorIndex !== -1) {
    blocks.push(normalized.slice(cursor, separatorIndex));
    cursor = separatorIndex + 2;
    separatorIndex = normalized.indexOf("\n\n", cursor);
  }

  return { blocks, rest: normalized.slice(cursor) };
}

function parseSseBlock(block: string, endpoint: StreamEndpoint): OpenCodeEvent | null {
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(dataLines.join("\n")) as unknown;
  } catch {
    return null;
  }

  try {
    const payload = normalizeEventPayload(raw, endpoint);
    return {
      type: payload.type,
      properties: payload.properties,
      sessionId: getEventSessionId({ properties: payload.properties, sessionId: null }),
      receivedAt: Date.now(),
      streamEndpoint: endpoint,
      raw,
    };
  } catch {
    return null;
  }
}

function normalizeEventPayload(raw: unknown, endpoint: StreamEndpoint): OpenCodeEventPayload {
  const root = readRecord(raw);
  const maybePayload = endpoint === "/global/event" ? readRecord(root?.payload) ?? root : root;
  if (!maybePayload || typeof maybePayload.type !== "string") {
    throw new Error("OpenCode event payload missing type");
  }

  return {
    type: maybePayload.type,
    properties: readRecord(maybePayload.properties) ?? {},
  };
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    signal.addEventListener("abort", onAbort);
  });
}
