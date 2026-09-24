import fs from "fs";
import path from "path";

export const PRIVATE_CHANNEL_FILES_DIR = path.join(process.cwd(), "private-channel-files");
export const CHANNEL_FILE_DATA_DIR = path.join(PRIVATE_CHANNEL_FILES_DIR, "data");
export const CHANNEL_FILE_TEMP_DIR = path.join(PRIVATE_CHANNEL_FILES_DIR, "temporary");

for (const directory of [PRIVATE_CHANNEL_FILES_DIR, CHANNEL_FILE_DATA_DIR, CHANNEL_FILE_TEMP_DIR]) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

export function privateFilePath(key: string): string | null {
  if (!/^[0-9a-f-]{36}(?:\.part|\.chunk)?$/i.test(key)) return null;
  const target = path.resolve(PRIVATE_CHANNEL_FILES_DIR, key.endsWith(".part") ? "temporary" : "data", key);
  const root = path.resolve(key.endsWith(".part") ? CHANNEL_FILE_TEMP_DIR : CHANNEL_FILE_DATA_DIR);
  return path.dirname(target) === root ? target : null;
}

export async function removePrivateFile(key: string): Promise<void> {
  const target = privateFilePath(key);
  if (!target) return;
  try {
    await fs.promises.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}