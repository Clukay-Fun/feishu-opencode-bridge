import { JsonStore } from "./json-store.js";

export type MappingRecord = Record<string, string>;

export class MappingStore extends JsonStore<MappingRecord> {
  constructor(dataDir: string, fileName: string) {
    super(dataDir, fileName, {});
  }
}
