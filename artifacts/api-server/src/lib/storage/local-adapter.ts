import fs from "fs";
import path from "path";
import type { Readable } from "stream";
import type { StorageAdapter } from "./index.js";

const UPLOADS_DIR = path.join(process.cwd(), "uploads");

export class LocalStorageAdapter implements StorageAdapter {
  constructor() {
    if (!fs.existsSync(UPLOADS_DIR)) {
      fs.mkdirSync(UPLOADS_DIR, { recursive: true, mode: 0o700 });
    }
  }

  async save(key: string, data: Buffer | Readable, _contentType?: string): Promise<string> {
    const filePath = this.safePath(key);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    if (Buffer.isBuffer(data)) {
      await fs.promises.writeFile(filePath, data);
    } else {
      const writeStream = fs.createWriteStream(filePath);
      for await (const chunk of data) {
        writeStream.write(chunk);
      }
      await new Promise<void>((resolve, reject) => {
        writeStream.on("finish", resolve);
        writeStream.on("error", reject);
        writeStream.end();
      });
    }

    return `/api/uploads/${key}`;
  }

  async read(key: string): Promise<Readable | null> {
    const filePath = this.safePath(key);
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
      return fs.createReadStream(filePath);
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.safePath(key);
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // No-op if not found
    }
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.safePath(key);
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }

  private safePath(key: string): string {
    const normalized = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, "");
    const resolved = path.resolve(UPLOADS_DIR, normalized);
    if (!resolved.startsWith(UPLOADS_DIR)) {
      throw new Error(`Invalid storage key: path traversal detected in "${key}"`);
    }
    return resolved;
  }
}