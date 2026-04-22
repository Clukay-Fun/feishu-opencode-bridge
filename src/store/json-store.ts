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
