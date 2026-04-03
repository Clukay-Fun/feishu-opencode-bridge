import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export class JsonStore<T> {
  constructor(private readonly dataDir: string, private readonly fileName: string, private readonly fallback: T) {}

  async load(): Promise<T> {
    try {
      const filePath = path.join(this.dataDir, this.fileName);
      const raw = await readFile(filePath, "utf8");
      return JSON.parse(raw) as T;
    } catch {
      return this.fallback;
    }
  }

  async save(value: T): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const filePath = path.join(this.dataDir, this.fileName);
    await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}
