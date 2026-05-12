/**
 * 职责: 提供通用的 JSON 文件持久化基类。
 * 关注点:
 * - 封装目录创建、读取、写入和默认值回退逻辑。
 * - 为轻量本地存储提供一致的 load/save 接口。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class JsonStore<T> {
  constructor(private readonly dataDir: string, private readonly fileName: string, private readonly fallback: T) {}

  /** 读取 JSON 文件；缺失或解析失败时返回 fallback。 */
  async load(): Promise<T> {
    try {
      const filePath = path.join(this.dataDir, this.fileName);
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return this.fallback;
    }
  }

  /** 把值格式化后写回 JSON 文件。 */
  async save(value: T): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const filePath = path.join(this.dataDir, this.fileName);
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

type DebouncedJsonStoreOptions = {
  debounceMs?: number | undefined;
  onError?(error: unknown): void;
};

export class DebouncedJsonStore<T> extends JsonStore<T> {
  private readonly debounceMs: number;
  private readonly onError?: ((error: unknown) => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingValue: T | null = null;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string, fileName: string, fallback: T, options: DebouncedJsonStoreOptions = {}) {
    super(dataDir, fileName, fallback);
    this.debounceMs = options.debounceMs ?? 2_000;
    this.onError = options.onError;
  }

  /** 安排一次延迟写入；多次调用会合并为最近的一份值。 */
  scheduleSave(value: T): void {
    this.pendingValue = value;
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.persistLatest();
    }, this.debounceMs);
  }

  /** 立即写入最近一次排队的值。 */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.persistLatest();
    await this.persistChain;
  }

  /** 关闭延迟写入器并刷盘。 */
  async stop(): Promise<void> {
    await this.flush();
  }

  private persistLatest(): void {
    const value = this.pendingValue;
    if (value === null) {
      return;
    }
    this.pendingValue = null;
    this.persistChain = this.persistChain
      .catch(() => undefined)
      .then(async () => {
        await this.save(value);
      })
      .catch((error) => {
        if (this.pendingValue === null) {
          this.pendingValue = value;
        }
        this.onError?.(error);
      });
  }
}
