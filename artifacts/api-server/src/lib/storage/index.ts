import type { Readable } from "stream";
import { LocalStorageAdapter } from "./local-adapter.js";
import { R2StorageAdapter } from "./r2-adapter.js";

export interface StorageAdapter {
  /** Save data under a key. Returns the public URL or path to access it. */
  save(key: string, data: Buffer | Readable, contentType?: string): Promise<string>;
  /** Read data as a stream. Returns null if not found. */
  read(key: string): Promise<Readable | null>;
  /** Delete data by key. No-op if not found. */
  delete(key: string): Promise<void>;
  /** Check if data exists. */
  exists(key: string): Promise<boolean>;
  /** Get a signed URL for temporary access (optional, only supported by remote adapters). */
  getSignedUrl?(key: string, expiresInSec: number): Promise<string>;
}

let adapterInstance: StorageAdapter | null = null;

export function createStorageAdapter(): StorageAdapter {
  if (adapterInstance) return adapterInstance;

  const backend = process.env.STORAGE_BACKEND || "local";

  switch (backend) {
    case "r2":
      adapterInstance = new R2StorageAdapter();
      break;
    case "local":
    default:
      adapterInstance = new LocalStorageAdapter();
      break;
  }

  return adapterInstance;
}

/** Reset the cached adapter (useful for testing). */
export function resetStorageAdapter(): void {
  adapterInstance = null;
}