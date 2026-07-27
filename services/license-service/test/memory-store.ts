import type { BlobStore } from "../src/types";

export class MemoryBlobStore implements BlobStore {
  private readonly values = new Map<string, unknown>();

  async setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }) {
    if (options?.onlyIfNew && this.values.has(key)) {
      throw new Error(`PRECONDITION_FAILED:${key}`);
    }
    this.values.set(key, structuredClone(value));
  }

  async get<T>(
    key: string,
    _options: { type: "json"; consistency: "strong" },
  ): Promise<T | null> {
    const value = this.values.get(key);
    return value === undefined ? null : structuredClone(value as T);
  }

  async delete(key: string) {
    this.values.delete(key);
  }

  async list(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? "";
    return {
      blobs: [...this.values.keys()]
        .filter((key) => key.startsWith(prefix))
        .sort()
        .map((key) => ({ key })),
    };
  }

  snapshot() {
    return structuredClone(Object.fromEntries(this.values));
  }
}
