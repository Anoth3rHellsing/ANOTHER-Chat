import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import fs from "fs";
import { openAsBlob } from "node:fs";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { createReadStream } from "fs";
import { setTimeout as delay } from "timers/promises";
import { and, asc, desc, eq, gt, lt, sql } from "drizzle-orm";
import {
  db, channelsTable, channelFilesTable, channelFileUploadsTable, usersTable,
  virusTotalRequestsTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { canAccessChannel, getMemberPermissions, hasPerm, PERM } from "../lib/permissions";
import { broadcast } from "../lib/websocket";
import { logger } from "../lib/logger";
import { channelFileVerifyRateLimit } from "../middleware/rate-limit";
import {
  CHANNEL_FILE_DATA_DIR, CHANNEL_FILE_TEMP_DIR, privateFilePath, removePrivateFile,
} from "../lib/channel-file-storage";

const router: IRouter = Router();
const CHUNK_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_MB = 100;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const VT_BASE = "https://www.virustotal.com/api/v3";
const VIRUSTOTAL_MAX_BYTES = 650 * 1024 * 1024;
const MAX_SCAN_MS = 4 * 60 * 1000;
const scanPollsInFlight = new Map<number, Promise<void>>();
const activeHashOperations = new Map<string, number>();

function holdHashOperation(sha256: string) {
  activeHashOperations.set(sha256, (activeHashOperations.get(sha256) ?? 0) + 1);
}

function releaseHashOperation(sha256: string) {
  const remaining = (activeHashOperations.get(sha256) ?? 1) - 1;
  if (remaining > 0) activeHashOperations.set(sha256, remaining);
  else activeHashOperations.delete(sha256);
}

function maxBytes(): number {
  const raw = Number(process.env.FILE_CHANNEL_MAX_MB ?? DEFAULT_MAX_MB);
  const mb = Number.isSafeInteger(raw) && raw > 0 && Number.isSafeInteger(raw * 1024 * 1024)
    ? raw
    : DEFAULT_MAX_MB;
  return mb * 1024 * 1024;
}

function virusTotalApiKey(): string | undefined {
  return process.env.VIRUSTOTAL_API_KEY || process.env.VirusTotal_Key || undefined;
}

function parseId(raw: unknown): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function safeFilename(input: string): string {
  const name = path.basename(input.replace(/\\/g, "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 255);
  return name && name !== "." && name !== ".." ? name : "download";
}

async function getAccessibleMediaChannel(req: Request, res: Response) {
  const channelId = parseId(req.params.channelId);
  if (!channelId) { res.status(400).json({ error: "Invalid channel ID" }); return null; }
  const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
  if (!channel) { res.status(404).json({ error: "Channel not found" }); return null; }
  if (channel.channelType !== "media") {
    res.status(403).json({ error: "Private file library is available only in media channels" });
    return null;
  }
  if (!(await canAccessChannel(channel, req.session.userId!, req.session.userRole))) {
    res.status(403).json({ error: "You cannot access this channel" }); return null;
  }
  return channel;
}

function canManageServer(globalRole: string | undefined, permissions: number): boolean {
  return globalRole === "admin" || permissions === 0xffffffff || hasPerm(permissions, PERM.MANAGE_CHANNELS);
}

async function fileHash(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function isUtf8Text(filePath: string): Promise<{ text: string } | null> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let prefix = "";
  let characterCount = 0;
  let printableCount = 0;
  try {
    for await (const bytes of createReadStream(filePath)) {
      const decoded = decoder.decode(bytes, { stream: true });
      if (decoded.includes("\0")) return null;
      if (prefix.length < 65536) prefix += decoded.slice(0, 65536 - prefix.length);
      for (const char of decoded) {
        characterCount++;
        if (char === "\n" || char === "\r" || char === "\t" || char >= " ") printableCount++;
      }
    }
    decoder.decode();
  } catch {
    return null;
  }
  if (printableCount / Math.max(characterCount, 1) <= 0.98) return null;
  return { text: prefix };
}

const mimeExtensions: Record<string, string[]> = {
  "application/zip": [".zip"],
  "application/x-7z-compressed": [".7z"],
  "application/vnd.rar": [".rar"],
  "application/x-tar": [".tar"],
  "application/gzip": [".gz", ".gzip", ".tgz"],
  "application/x-bzip2": [".bz2", ".bz"],
  "application/x-xz": [".xz"],
  "application/zstd": [".zst", ".zstd"],
  "application/vnd.microsoft.portable-executable": [".exe", ".dll", ".sys", ".scr", ".com"],
  "application/x-msi": [".msi", ".msp", ".mst"],
  "application/x-ole-storage": [".doc", ".dot", ".xls", ".xlt", ".ppt", ".pot", ".pps", ".msi", ".msp", ".mst"],
  "application/x-elf": [".elf", ".so", ".o"],
  "application/x-mach-binary": [".dylib", ".app", ".mach"],
  "application/vnd.android.package-archive": [".apk"],
  "application/java-archive": [".jar"],
  "application/java-vm": [".class"],
  "application/x-xar": [".xar", ".pkg"],
  "application/x-iso9660-image": [".iso"],
  "application/x-apple-diskimage": [".dmg"],
  "application/pdf": [".pdf"],
  "application/msword": [".doc", ".dot"],
  "application/vnd.ms-excel": [".xls", ".xlt"],
  "application/vnd.ms-powerpoint": [".ppt", ".pot", ".pps"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "application/vnd.oasis.opendocument.text": [".odt"],
  "application/vnd.oasis.opendocument.spreadsheet": [".ods"],
  "application/vnd.oasis.opendocument.presentation": [".odp"],
  "image/jpeg": [".jpg", ".jpeg", ".jpe"],
  "image/png": [".png"],
  "image/gif": [".gif"],
  "image/webp": [".webp"],
  "image/bmp": [".bmp", ".dib"],
  "image/tiff": [".tif", ".tiff"],
  "image/x-icon": [".ico"],
  "image/avif": [".avif"],
  "image/heic": [".heic", ".heif"],
  "image/svg+xml": [".svg", ".svgz"],
  "audio/mpeg": [".mp3", ".mp2"],
  "audio/wav": [".wav"],
  "audio/flac": [".flac"],
  "audio/aac": [".aac"],
  "audio/midi": [".mid", ".midi"],
  "audio/x-aiff": [".aif", ".aiff", ".aifc"],
  "audio/amr": [".amr"],
  "audio/ogg": [".ogg", ".oga", ".opus"],
  "video/ogg": [".ogv", ".ogg"],
  "audio/webm": [".webm", ".weba"],
  "audio/mp4": [".m4a"],
  "video/mp4": [".mp4", ".m4v"],
  "video/quicktime": [".mov"],
  "video/webm": [".webm"],
  "video/x-matroska": [".mkv", ".mka"],
  "audio/x-matroska": [".mkv", ".mka"],
  "video/x-msvideo": [".avi"],
  "video/x-flv": [".flv"],
  "video/mpeg": [".mpeg", ".mpg"],
  "text/plain": [".txt", ".text", ".log"],
  "text/html": [".html", ".htm"],
  "application/xml": [".xml", ".xsl", ".xslt"],
  "text/x-php": [".php", ".phtml"],
  "text/javascript": [".js", ".mjs", ".cjs"],
  "text/x-python": [".py", ".pyw"],
  "text/x-shellscript": [".sh", ".bash", ".zsh"],
  "text/x-msdos-batch": [".bat", ".cmd"],
  "text/x-powershell": [".ps1", ".psm1"],
  "text/x-perl": [".pl", ".pm"],
  "text/x-c": [".c", ".h"],
  "text/x-c++": [".cc", ".cpp", ".cxx", ".hpp", ".hh"],
  "text/x-java": [".java"],
  "text/x-rust": [".rs"],
  "text/x-go": [".go"],
  "text/x-ruby": [".rb"],
};

const MAX_ZIP_DIRECTORY_BYTES = 1024 * 1024;

async function zipEntryNames(filePath: string, fileSize: number): Promise<Set<string>> {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const tailLength = Math.min(fileSize, 65_557);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tail.length, fileSize - tail.length);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= Math.max(0, tail.length - 65_557); offset--) {
      if (tail[offset] === 0x50 && tail[offset + 1] === 0x4b && tail[offset + 2] === 0x05 && tail[offset + 3] === 0x06) {
        if (offset + 22 + tail.readUInt16LE(offset + 20) !== tail.length) continue;
        eocd = offset;
        break;
      }
    }
    if (eocd < 0) return new Set();
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directorySize > MAX_ZIP_DIRECTORY_BYTES || directoryOffset + directorySize > fileSize) return new Set();
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directory.length, directoryOffset);
    const names = new Set<string>();
    for (let offset = 0; offset + 46 <= directory.length;) {
      if (directory[offset] !== 0x50 || directory[offset + 1] !== 0x4b ||
          directory[offset + 2] !== 0x01 || directory[offset + 3] !== 0x02) break;
      const nameLength = directory.readUInt16LE(offset + 28);
      const extraLength = directory.readUInt16LE(offset + 30);
      const commentLength = directory.readUInt16LE(offset + 32);
      const nameStart = offset + 46;
      const next = nameStart + nameLength + extraLength + commentLength;
      if (next > directory.length) break;
      names.add(directory.subarray(nameStart, nameStart + nameLength).toString("utf8").toLowerCase());
      offset = next;
    }
    return names;
  } finally {
    await handle.close();
  }
}

async function zipMimeType(filePath: string, bytes: Buffer, fileSize: number): Promise<string> {
  const names = await zipEntryNames(filePath, fileSize);
  if (names.has("[content_types].xml")) {
    if (names.has("word/document.xml")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    if (names.has("xl/workbook.xml")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (names.has("ppt/presentation.xml")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  }
  const odfTypes = [
    "application/vnd.oasis.opendocument.text",
    "application/vnd.oasis.opendocument.spreadsheet",
    "application/vnd.oasis.opendocument.presentation",
  ];
  for (const type of odfTypes) if (bytes.includes(Buffer.from(type))) return type;
  if (names.has("meta-inf/manifest.mf") && [...names].some((name) => name.endsWith(".class"))) return "application/java-archive";
  if (names.has("androidmanifest.xml") && (names.has("classes.dex") || names.has("resources.arsc"))) return "application/vnd.android.package-archive";
  return "application/zip";
}

function oggMimeType(bytes: Buffer): string {
  if (bytes.includes(Buffer.from("\x01vorbis")) ||
      bytes.includes(Buffer.from("OpusHead")) ||
      bytes.includes(Buffer.from("Speex   ")) ||
      bytes.includes(Buffer.from("\x7fFLAC"))) return "audio/ogg";
  if (bytes.includes(Buffer.from("\x80theora"))) return "video/ogg";
  return "application/octet-stream";
}

function matroskaMimeType(bytes: Buffer): string {
  const data = bytes.toString("latin1");
  const hasAudioCodec = /A_(?:OPUS|VORBIS|AAC|FLAC|MPEG|PCM|ALAC|AC3|E_AC3)\b/i.test(data);
  const hasVideoCodec = /V_(?:VP8|VP9|AV1|MPEG4|MPEGH|THEORA|AVC|HEVC)\b/i.test(data);
  const webm = /webm/i.test(data);
  if (hasAudioCodec && hasVideoCodec) return webm ? "video/webm" : "video/x-matroska";
  if (hasAudioCodec) return webm ? "audio/webm" : "audio/x-matroska";
  if (hasVideoCodec) return webm ? "video/webm" : "video/x-matroska";
  return "application/octet-stream";
}

async function detectAllowedType(filePath: string, filename: string): Promise<{ mimeType: string }> {
  const handle = await fs.promises.open(filePath, "r");
  const header = Buffer.alloc(65536);
  let length: number;
  try {
    ({ bytesRead: length } = await handle.read(header, 0, header.length, 0));
  } finally {
    await handle.close();
  }
  const bytes = header.subarray(0, length!);
  const ext = path.extname(filename).toLowerCase();
  const starts = (...values: number[]) => bytes.length >= values.length && values.every((value, index) => bytes[index] === value);
  const ascii = (start: number, count: number) => bytes.subarray(start, start + count).toString("ascii");
  const zip = starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06) || starts(0x50, 0x4b, 0x07, 0x08);
  let mimeType: string | undefined;

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) mimeType = "image/png";
  else if (starts(0xff, 0xd8, 0xff)) mimeType = "image/jpeg";
  else if (/^GIF8[79]a$/.test(ascii(0, 6))) mimeType = "image/gif";
  else if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") mimeType = "image/webp";
  else if (ascii(0, 2) === "BM" && bytes.length >= 26 && bytes.readUInt32LE(14) >= 12) mimeType = "image/bmp";
  else if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a) || starts(0x49, 0x49, 0x2b, 0x00)) mimeType = "image/tiff";
  else if (starts(0x00, 0x00, 0x01, 0x00)) mimeType = "image/x-icon";
  else if (bytes.length >= 12 && ascii(4, 4) === "ftyp" && /^(?:avif|avis|heic|heix|mif1)$/.test(ascii(8, 4))) mimeType = ascii(8, 4).startsWith("he") || ascii(8, 4) === "mif1" ? "image/heic" : "image/avif";
  else if (ascii(0, 4) === "fLaC") mimeType = "audio/flac";
  else if (ascii(0, 4) === "MThd") mimeType = "audio/midi";
  else if (ascii(0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(8, 4))) mimeType = "audio/x-aiff";
  else if (ascii(0, 5) === "#!AMR") mimeType = "audio/amr";
  else if (ascii(0, 3) === "ID3" || starts(0xff, 0xfb) || starts(0xff, 0xf3) || starts(0xff, 0xf2)) mimeType = "audio/mpeg";
  else if (ascii(0, 4) === "OggS") mimeType = oggMimeType(bytes);
  else if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") mimeType = "audio/wav";
  else if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") mimeType = "video/x-msvideo";
  else if (ascii(0, 3) === "FLV") mimeType = "video/x-flv";
  else if (starts(0, 0, 1, 0xba) || starts(0, 0, 1, 0xb3) ||
    (bytes.length > 376 && bytes[0] === 0x47 && bytes[188] === 0x47 && bytes[376] === 0x47)) mimeType = "video/mpeg";
  else if (bytes.length >= 12 && ascii(4, 4) === "ftyp") mimeType = ["M4A ", "M4B ", "F4A ", "F4B "].includes(ascii(8, 4)) ? "audio/mp4" : ascii(8, 4) === "qt  " ? "video/quicktime" : "video/mp4";
  else if (starts(0x1a, 0x45, 0xdf, 0xa3)) mimeType = matroskaMimeType(bytes);
  else if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) mimeType = "application/pdf";
  else if (ascii(0, 2) === "MZ") mimeType = "application/vnd.microsoft.portable-executable";
  else if (starts(0x7f, 0x45, 0x4c, 0x46)) mimeType = "application/x-elf";
  else if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) mimeType = "audio/aac";
  else if ([Buffer.from([0xfe, 0xed, 0xfa, 0xce]), Buffer.from([0xce, 0xfa, 0xed, 0xfe]), Buffer.from([0xfe, 0xed, 0xfa, 0xcf]), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from([0xca, 0xfe, 0xba, 0xbe])].some((magic) => bytes.subarray(0, 4).equals(magic))) {
    const javaClassVersion = bytes.length >= 8 ? bytes.readUInt16BE(6) : 0;
    mimeType = starts(0xca, 0xfe, 0xba, 0xbe) && javaClassVersion >= 45 && javaClassVersion <= 100
      ? "application/java-vm" : "application/x-mach-binary";
  } else if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) {
    mimeType = "application/x-ole-storage";
  } else if (zip) {
    mimeType = await zipMimeType(filePath, bytes, (await fs.promises.stat(filePath)).size);
  } else if (starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) mimeType = "application/x-7z-compressed";
  else if (ascii(0, 6) === "Rar!\x1a\x07\x00" || ascii(0, 7) === "Rar!\x1a\x07\x01") mimeType = "application/vnd.rar";
  else if (starts(0x1f, 0x8b)) mimeType = "application/gzip";
  else if (ascii(0, 3) === "BZh") mimeType = "application/x-bzip2";
  else if (starts(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) mimeType = "application/x-xz";
  else if (starts(0x28, 0xb5, 0x2f, 0xfd)) mimeType = "application/zstd";
  else if (bytes.length >= 262 && ascii(257, 5) === "ustar") mimeType = "application/x-tar";
  else if (ascii(0, 4) === "xar!") mimeType = "application/x-xar";
  else if (ascii(32769, 5) === "CD001") mimeType = "application/x-iso9660-image";
  else {
    let text = await isUtf8Text(filePath);
    if (!text && ext === ".dmg") {
      const stat = await fs.promises.stat(filePath);
      if (stat.size >= 512) {
        const tailHandle = await fs.promises.open(filePath, "r");
        const tail = Buffer.alloc(512);
        try { await tailHandle.read(tail, 0, tail.length, stat.size - tail.length); } finally { await tailHandle.close(); }
        if (tail.subarray(0, 4).toString("ascii") === "koly") mimeType = "application/x-apple-diskimage";
      }
    }
    if (!mimeType && text) {
      const content = text.text;
      if (/^\uFEFF?\s*(?:<\?xml\b[^?]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(content)) mimeType = "image/svg+xml";
      else if (/^\s*(?:<!doctype\s+html|<(?:html|head|body|script|form|iframe|object|meta|link|div|p|a)\b)/i.test(content)) mimeType = "text/html";
      else if (/<\?php\b/i.test(content)) mimeType = "text/x-php";
      else if ((ext === ".svg" || ext === ".svgz") && /<svg\b/i.test(content)) mimeType = "image/svg+xml";
      else if (/^\s*#!.*\b(?:sh|bash|zsh|python(?:3(?:\.\d+)?)?|perl|ruby|node|php)\b/i.test(content)) {
        const shebang = content.split(/\r?\n/, 1)[0].toLowerCase();
        mimeType = /python/.test(shebang) || ext === ".py" || ext === ".pyw" ? "text/x-python"
          : /node/.test(shebang) || ext === ".js" || ext === ".mjs" || ext === ".cjs" ? "text/javascript"
          : /perl/.test(shebang) || ext === ".pl" || ext === ".pm" ? "text/x-perl"
          : /ruby/.test(shebang) || ext === ".rb" ? "text/x-ruby"
          : /php/.test(shebang) ? "text/x-php" : "text/x-shellscript";
      } else if (/<\?xml\b/i.test(content) || ext === ".xml" && /^\s*<[a-z][\w:-]*(?:\s|>)/i.test(content)) mimeType = "application/xml";
      else if (/\b(?:@echo\s+off|function\s+\w+\s*\(|(?:const|let|var)\s+\w+\s*=|import\s+\w+|export\s+(?:default|function|const)|def\s+\w+\s*\(|from\s+\w+\s+import\b|javascript\s*:|console\.log\s*\(|=>)/i.test(content) ||
          /\.(?:py|pyw)$/.test(ext) && /\bprint\s*\(/i.test(content) ||
          /\.(?:js|mjs|cjs)$/.test(ext) && /\b(?:console\.|document\.|window\.)/i.test(content) ||
          ext === ".rb" && /\b(?:puts|require)\b/i.test(content) ||
          /\.(?:pl|pm)$/.test(ext) && /\b(?:use\s+strict|my\s+\$|print\s+)/i.test(content) ||
          /\.(?:ps1|psm1)$/.test(ext) && /\$[A-Za-z_]\w*\s*=/.test(content)) {
        mimeType = /@echo\s+off/i.test(content) ? "text/x-msdos-batch"
          : /\b(?:Write-(?:Host|Output|Error)|Get-\w+|Set-\w+)\b|\$[A-Za-z_]\w*\s*=/.test(content) ? "text/x-powershell"
          : /\bdef\s+\w+\s*\(|\bfrom\s+\w+\s+import\b|\.pyw?$/.test(content + ext) ? "text/x-python"
          : ext === ".java" ? "text/x-java"
          : /\.(?:pl|pm)$/.test(ext) ? "text/x-perl"
          : ext === ".rb" ? "text/x-ruby"
          : /\b(?:#include\s*<|int\s+main\s*\(|class\s+\w+\s*\{|fn\s+main\s*\(|package\s+main\b)/i.test(content) ? "application/octet-stream"
          : "text/javascript";
      }
      else if (/\b(?:#include\s*<|int\s+main\s*\(|class\s+\w+\s*\{|fn\s+main\s*\(|package\s+main\b)/i.test(content)) {
        mimeType = /#include\s*</i.test(content) ? (ext === ".cpp" || ext === ".cc" || ext === ".cxx" ? "text/x-c++" : "text/x-c")
          : /fn\s+main\s*\(/i.test(content) ? "text/x-rust"
          : /package\s+main\b/i.test(content) ? "text/x-go" : "text/x-java";
      } else mimeType = "text/plain";
    }
  }
  mimeType ??= "application/octet-stream";
  return { mimeType };
}

function fileExtensionMismatch(mimeType: string, filename: string): boolean {
  const ext = path.extname(filename).toLowerCase();
  const recognized = Object.values(mimeExtensions).some((extensions) => extensions.includes(ext));
  if (!recognized) return false;
  return !(mimeExtensions[mimeType] ?? []).includes(ext);
}

function scanEligibility(file: Pick<typeof channelFilesTable.$inferSelect, "mimeType" | "filename" | "sizeBytes">) {
  const extensionMismatch = fileExtensionMismatch(file.mimeType, file.filename);
  const tooLarge = file.sizeBytes > VIRUSTOTAL_MAX_BYTES;
  const outOfScope = file.mimeType !== "image/svg+xml" &&
    (file.mimeType.startsWith("image/") || file.mimeType.startsWith("audio/") ||
      file.mimeType.startsWith("video/") || file.mimeType === "text/plain");
  return {
    eligible: !tooLarge && (extensionMismatch || !outOfScope),
    reason: tooLarge ? "too_large" as const : outOfScope && !extensionMismatch ? "out_of_scope" as const : null,
    extensionMismatch,
    detectedMimeType: file.mimeType,
    maxBytes: VIRUSTOTAL_MAX_BYTES,
  };
}

function serializeScan(file: typeof channelFilesTable.$inferSelect, scannerAvailable: boolean) {
  return {
    status: file.scanStatus === "completed" || scannerAvailable ? file.scanStatus : "unavailable",
    sha256: file.sha256,
    harmless: file.scanHarmless,
    undetected: file.scanUndetected,
    suspicious: file.scanSuspicious,
    malicious: file.scanMalicious,
    source: file.scanSource,
    submittedBy: file.scanSubmittedBy,
    submittedAt: file.scanSubmittedAt,
    error: file.scanError,
    completedAt: file.scanCompletedAt,
  };
}

async function serializeFile(file: typeof channelFilesTable.$inferSelect, scannerAvailable = Boolean(virusTotalApiKey())) {
  const [uploader] = await db.select({ displayName: usersTable.displayName }).from(usersTable).where(eq(usersTable.id, file.uploadedBy));
  return {
    id: file.id,
    channelId: file.channelId,
    filename: file.filename,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    uploadedBy: file.uploadedBy,
    uploaderName: uploader?.displayName ?? "Unknown user",
    createdAt: file.createdAt,
    downloadPath: `/api/channels/${file.channelId}/files/${file.id}/download`,
    scanEligibility: scanEligibility(file),
    scan: serializeScan(file, scannerAvailable),
  };
}

function removeQuietly(filePath: string | null) {
  if (filePath) fs.unlink(filePath, () => {});
}

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, CHANNEL_FILE_TEMP_DIR),
    filename: (_req, _file, cb) => cb(null, `${randomUUID()}.chunk`),
  }),
  // Busboy reports LIMIT_FILE_SIZE even for a file exactly at its threshold.
  // Accept one extra byte at the parser boundary and reject it below.
  limits: { fileSize: CHUNK_BYTES + 1, files: 1, fields: 2 },
});

function receiveChunk(req: Request, res: Response, next: NextFunction) {
  chunkUpload.single("chunk")(req, res, (error: unknown) => {
    if (!error) { next(); return; }
    const tooLarge = typeof error === "object" && error !== null && "code" in error &&
      (error as { code?: string }).code === "LIMIT_FILE_SIZE";
    res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "Upload chunks may not exceed 4 MiB" : "Invalid multipart chunk upload" });
  });
}

router.get("/channels/:channelId/files", requireAuth, async (req, res): Promise<void> => {
  const channel = await getAccessibleMediaChannel(req, res);
  if (!channel) return;
  const files = await db.select().from(channelFilesTable).where(eq(channelFilesTable.channelId, channel.id)).orderBy(desc(channelFilesTable.createdAt));
  res.json({
    files: await Promise.all(files.map(async (file) => serializeFile(await recoverPendingScan(file)))),
    maxBytes: maxBytes(),
    scannerAvailable: Boolean(virusTotalApiKey()),
  });
});

router.post("/channels/:channelId/files/uploads", requireAuth, async (req, res): Promise<void> => {
  const channel = await getAccessibleMediaChannel(req, res);
  if (!channel) return;
  const filename = typeof req.body?.filename === "string" ? safeFilename(req.body.filename) : "";
  const sizeBytes = req.body?.sizeBytes;
  if (!filename || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    res.status(400).json({ error: "A filename and positive integer sizeBytes are required" }); return;
  }
  if (sizeBytes > maxBytes()) {
    res.status(413).json({ error: `File exceeds the ${Math.floor(maxBytes() / 1024 / 1024)} MiB channel file limit` }); return;
  }
  const uploadId = randomUUID();
  const storageKey = `${randomUUID()}.part`;
  const tempPath = privateFilePath(storageKey)!;
  await fs.promises.writeFile(tempPath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  try {
    await db.insert(channelFileUploadsTable).values({
      id: uploadId,
      channelId: channel.id,
      uploadedBy: req.session.userId!,
      filename,
      expectedBytes: sizeBytes,
      storageKey,
      expiresAt,
    });
  } catch (error) {
    removeQuietly(tempPath);
    throw error;
  }
  res.status(201).json({ uploadId, chunkSize: CHUNK_BYTES, maxBytes: maxBytes(), offset: 0, expiresAt });
});

async function requireMediaChannelBeforeUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (await getAccessibleMediaChannel(req, res)) next();
}

router.post("/channels/:channelId/files/uploads/:uploadId/chunks", requireAuth, requireMediaChannelBeforeUpload, receiveChunk, async (req, res): Promise<void> => {
  const channel = await getAccessibleMediaChannel(req, res);
  const incomingPath = req.file?.path ?? null;
  if (!channel) { removeQuietly(incomingPath); return; }
  const uploadId = typeof req.params.uploadId === "string" ? req.params.uploadId : "";
  const offset = Number(req.query.offset);
  if (!req.file) { res.status(400).json({ error: "Multipart field 'chunk' is required" }); return; }
  const chunkPath = req.file.path;
  try {
    if (!Number.isSafeInteger(offset) || offset < 0 || req.file.size < 1) {
      res.status(400).json({ error: "A nonnegative byte offset and nonempty chunk are required" }); return;
    }
    if (req.file.size > CHUNK_BYTES) {
      res.status(413).json({ error: "Upload chunks may not exceed 4 MiB" }); return;
    }
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('channel_file_upload'), hashtext(${uploadId}))`);
      const [session] = await tx.select().from(channelFileUploadsTable).where(and(
        eq(channelFileUploadsTable.id, uploadId),
        eq(channelFileUploadsTable.channelId, channel.id),
        eq(channelFileUploadsTable.uploadedBy, req.session.userId!),
      )).for("update");
      if (!session || session.expiresAt.getTime() <= Date.now()) return { kind: "missing" as const };
      if (session.completedFileId !== null) return { kind: "finished" as const, offset: session.receivedBytes };
      const sessionPath = privateFilePath(session.storageKey);
      if (!sessionPath) return { kind: "invalid-path" as const };
      if (offset > session.receivedBytes || offset + req.file!.size > session.expectedBytes) {
        return { kind: "conflict" as const, offset: session.receivedBytes };
      }
      if (req.file!.size !== Math.min(CHUNK_BYTES, session.expectedBytes - offset)) {
        return { kind: "invalid-chunk" as const };
      }
      if (offset < session.receivedBytes) {
        if (offset + req.file!.size > session.receivedBytes) {
          return { kind: "conflict" as const, offset: session.receivedBytes };
        }
        const [existing, incoming] = await Promise.all([
          fs.promises.open(sessionPath, "r"),
          fs.promises.open(chunkPath, "r"),
        ]);
        const oldBytes = Buffer.alloc(req.file!.size);
        const newBytes = Buffer.alloc(req.file!.size);
        try {
          await existing.read(oldBytes, 0, oldBytes.length, offset);
          await incoming.read(newBytes, 0, newBytes.length, 0);
        } finally {
          await existing.close();
          await incoming.close();
        }
        if (!oldBytes.equals(newBytes)) return { kind: "conflict" as const, offset: session.receivedBytes };
        return { kind: "ok" as const, offset: session.receivedBytes, expectedBytes: session.expectedBytes };
      }

      const handle = await fs.promises.open(sessionPath, "r+");
      try {
        const incoming = await fs.promises.readFile(chunkPath);
        let written = 0;
        while (written < incoming.length) {
          const result = await handle.write(incoming, written, incoming.length - written, offset + written);
          if (result.bytesWritten === 0) throw new Error("Could not persist the complete upload chunk");
          written += result.bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      const [updated] = await tx.update(channelFileUploadsTable)
        .set({ receivedBytes: session.receivedBytes + req.file!.size })
        .where(and(eq(channelFileUploadsTable.id, uploadId), eq(channelFileUploadsTable.receivedBytes, session.receivedBytes)))
        .returning({ receivedBytes: channelFileUploadsTable.receivedBytes });
      if (!updated) return { kind: "conflict" as const, offset: session.receivedBytes };
      return { kind: "ok" as const, offset: updated.receivedBytes, expectedBytes: session.expectedBytes };
    });
    if (result.kind === "missing") { res.status(404).json({ error: "Upload session not found or expired" }); return; }
    if (result.kind === "finished") { res.status(409).json({ error: "Upload session is already finalized", offset: result.offset }); return; }
    if (result.kind === "invalid-path") { res.status(500).json({ error: "Invalid server-side upload path" }); return; }
    if (result.kind === "invalid-chunk") { res.status(400).json({ error: "Chunks must be 4 MiB except for the final chunk" }); return; }
    if (result.kind === "conflict") {
      res.status(409).json({ error: "Chunk offset conflicts with upload session state", offset: result.offset }); return;
    }
    res.json({ uploadId, offset: result.offset, complete: result.offset === result.expectedBytes });
  } finally {
    removeQuietly(incomingPath);
  }
});

router.get("/channels/:channelId/files/uploads/:uploadId", requireAuth, async (req, res): Promise<void> => {
  const channel = await getAccessibleMediaChannel(req, res);
  if (!channel) return;
  const uploadId = typeof req.params.uploadId === "string" ? req.params.uploadId : "";
  const status = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('channel_file_upload'), hashtext(${uploadId}))`);
    const [session] = await tx.select().from(channelFileUploadsTable).where(and(
      eq(channelFileUploadsTable.id, uploadId),
      eq(channelFileUploadsTable.channelId, channel.id),
      eq(channelFileUploadsTable.uploadedBy, req.session.userId!),
    )).for("update");
    if (!session || session.expiresAt.getTime() <= Date.now()) return null;
    return {
      uploadId: session.id,
      offset: session.receivedBytes,
      expectedBytes: session.expectedBytes,
      chunkSize: CHUNK_BYTES,
      ...(session.completedFileId !== null ? { completedFileId: session.completedFileId } : {}),
    };
  });
  if (!status) { res.status(404).json({ error: "Upload session not found or expired" }); return; }
  res.json(status);
});

router.post("/channels/:channelId/files/uploads/:uploadId/finish", requireAuth, async (req, res): Promise<void> => {
  const channel = await getAccessibleMediaChannel(req, res);
  if (!channel) return;
  const uploadId = typeof req.params.uploadId === "string" ? req.params.uploadId : "";
  let movedTempToFinal = false;
  let tempPath = "";
  let finalPath = "";
  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('channel_file_upload'), hashtext(${uploadId}))`);
      const [session] = await tx.select().from(channelFileUploadsTable).where(and(
        eq(channelFileUploadsTable.id, uploadId),
        eq(channelFileUploadsTable.channelId, channel.id),
        eq(channelFileUploadsTable.uploadedBy, req.session.userId!),
      )).for("update");
      if (!session || session.expiresAt.getTime() <= Date.now()) return { kind: "missing" as const };
      if (session.completedFileId !== null) {
        const [completedFile] = await tx.select().from(channelFilesTable)
          .where(and(eq(channelFilesTable.id, session.completedFileId), eq(channelFilesTable.channelId, channel.id)));
        return completedFile
          ? { kind: "complete" as const, file: completedFile, created: false }
          : { kind: "missing" as const };
      }
      if (session.expectedBytes > maxBytes()) return { kind: "too-large" as const };
      if (session.receivedBytes !== session.expectedBytes) {
        return { kind: "incomplete" as const, receivedBytes: session.receivedBytes, expectedBytes: session.expectedBytes };
      }
      tempPath = privateFilePath(session.storageKey) ?? "";
      if (!tempPath) return { kind: "invalid-path" as const };
      let detected: { mimeType: string };
      let sha256: string;
      try {
        detected = await detectAllowedType(tempPath, session.filename);
        sha256 = await fileHash(tempPath);
      } catch (error) {
        return { kind: "unsupported" as const, error: error instanceof Error ? error.message : "File signature is not supported" };
      }
      const storageKey = randomUUID();
      finalPath = path.join(CHANNEL_FILE_DATA_DIR, storageKey);
      await fs.promises.rename(tempPath, finalPath);
      movedTempToFinal = true;
      const [created] = await tx.insert(channelFilesTable).values({
        channelId: channel.id,
        uploadedBy: req.session.userId!,
        filename: session.filename,
        mimeType: detected.mimeType,
        sizeBytes: session.expectedBytes,
        sha256,
        storageKey,
      }).returning();
      await tx.update(channelFileUploadsTable)
        .set({ completedFileId: created.id })
        .where(eq(channelFileUploadsTable.id, uploadId));
      return { kind: "complete" as const, file: created, created: true };
    });
    if (result.kind === "missing") { res.status(409).json({ error: "Upload session not found or expired" }); return; }
    if (result.kind === "too-large") { res.status(413).json({ error: "File exceeds configured channel file limit" }); return; }
    if (result.kind === "invalid-path") { res.status(500).json({ error: "Invalid server-side upload path" }); return; }
    if (result.kind === "incomplete") {
      res.status(409).json({ error: "Upload is incomplete", receivedBytes: result.receivedBytes, expectedBytes: result.expectedBytes }); return;
    }
    if (result.kind === "unsupported") {
      res.status(415).json({ error: result.error }); return;
    }
    const data = await serializeFile(result.file);
    if (result.created) broadcast(`channel:${channel.id}`, { type: "file:created", data });
    res.status(result.created ? 201 : 200).json(data);
  } catch (error) {
    if (movedTempToFinal && tempPath && finalPath) {
      try {
        await fs.promises.rename(finalPath, tempPath);
      } catch (rollbackError) {
        logger.error({ err: rollbackError, finalPath, tempPath }, "Failed to restore private upload after finish transaction rollback");
      }
    }
    throw error;
  }
});

router.delete("/channels/:channelId/files/uploads/:uploadId", requireAuth, async (req, res): Promise<void> => {
  const channel = await getAccessibleMediaChannel(req, res);
  if (!channel) return;
  const uploadId = typeof req.params.uploadId === "string" ? req.params.uploadId : "";
  const perms = await getMemberPermissions(channel.serverId, req.session.userId!);
  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('channel_file_upload'), hashtext(${uploadId}))`);
    const [session] = await tx.select().from(channelFileUploadsTable).where(and(
      eq(channelFileUploadsTable.id, uploadId),
      eq(channelFileUploadsTable.channelId, channel.id),
    )).for("update");
    if (!session) return "missing" as const;
    if (session.uploadedBy !== req.session.userId && !canManageServer(req.session.userRole, perms)) return "forbidden" as const;
    if (session.completedFileId === null) await removePrivateFile(session.storageKey);
    await tx.delete(channelFileUploadsTable).where(eq(channelFileUploadsTable.id, uploadId));
    return "aborted" as const;
  });
  if (result === "forbidden") {
    res.status(403).json({ error: "Only the uploader or a server administrator can abort this upload" }); return;
  }
  res.sendStatus(204);
});

router.get("/channels/:channelId/files/:fileId/download", requireAuth, async (req, res, next): Promise<void> => {
  const channel = await getAccessibleMediaChannel(req, res);
  if (!channel) return;
  const fileId = parseId(req.params.fileId);
  if (!fileId) { res.status(404).json({ error: "File not found" }); return; }
  const [file] = await db.select().from(channelFilesTable).where(and(
    eq(channelFilesTable.id, fileId),
    eq(channelFilesTable.channelId, channel.id),
  ));
  if (!file) { res.status(404).json({ error: "File not found" }); return; }
  const filePath = privateFilePath(file.storageKey);
  if (!filePath) { res.status(404).json({ error: "File bytes not found" }); return; }
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile()) { res.status(404).json({ error: "File bytes not found" }); return; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { res.status(404).json({ error: "File bytes not found" }); return; }
    next(error); return;
  }
  const filename = safeFilename(file.filename);
  const fallback = filename.replace(/[^\x20-\x7e]|["\\;]/g, "_");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Content-Disposition", `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Content-Type", file.mimeType);
  res.sendFile(filePath, { cacheControl: false }, (error) => {
    if (!error) return;
    if (res.headersSent) { res.destroy(error); return; }
    next(error);
  });
});

router.delete("/channels/:channelId/files/:fileId", requireAuth, async (req, res): Promise<void> => {
  const channel = await getAccessibleMediaChannel(req, res);
  if (!channel) return;
  const fileId = parseId(req.params.fileId);
  if (!fileId) { res.status(404).json({ error: "File not found" }); return; }
  const [file] = await db.select().from(channelFilesTable).where(and(
    eq(channelFilesTable.id, fileId),
    eq(channelFilesTable.channelId, channel.id),
  ));
  if (!file) { res.status(404).json({ error: "File not found" }); return; }
  const perms = await getMemberPermissions(channel.serverId, req.session.userId!);
  if (file.uploadedBy !== req.session.userId && !canManageServer(req.session.userRole, perms)) {
    res.status(403).json({ error: "Only the uploader or a server administrator can delete this file" }); return;
  }
  const filePath = privateFilePath(file.storageKey);
  if (!filePath) { res.status(500).json({ error: "Stored file path is invalid; file record was retained" }); return; }
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile()) {
      res.status(500).json({ error: "Stored file is not a regular file; file record was retained" }); return;
    }
    await fs.promises.unlink(filePath);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    res.status(missing ? 409 : 500).json({
      error: missing ? "Stored file bytes are missing; file record was retained" : "Could not remove stored file; file record was retained",
    });
    return;
  }
  await db.delete(channelFilesTable).where(eq(channelFilesTable.id, fileId));
  broadcast(`channel:${channel.id}`, { type: "file:deleted", data: { id: file.id, channelId: channel.id } });
  res.sendStatus(204);
});

async function reserveVirusTotalRequest(): Promise<{ allowed: boolean; retryAfterMs: number; dailyLimit: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('channel_file_virus_total_quota'))`);
    const minuteAgo = new Date(Date.now() - 60_000);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await tx.delete(virusTotalRequestsTable).where(lt(virusTotalRequestsTable.requestedAt, dayAgo));
    const recentMinute = await tx.select({ requestedAt: virusTotalRequestsTable.requestedAt })
      .from(virusTotalRequestsTable)
      .where(gt(virusTotalRequestsTable.requestedAt, minuteAgo))
      .orderBy(asc(virusTotalRequestsTable.requestedAt));
    const recentDay = await tx.select({ requestedAt: virusTotalRequestsTable.requestedAt })
      .from(virusTotalRequestsTable)
      .where(gt(virusTotalRequestsTable.requestedAt, dayAgo))
      .orderBy(asc(virusTotalRequestsTable.requestedAt));
    if (recentDay.length >= 500) {
      return { allowed: false, retryAfterMs: 0, dailyLimit: true };
    }
    if (recentMinute.length >= 4) {
      return {
        allowed: false,
        retryAfterMs: Math.max(1000, recentMinute[0].requestedAt.getTime() + 60_000 - Date.now() + 100),
        dailyLimit: false,
      };
    }
    await tx.insert(virusTotalRequestsTable).values({});
    return { allowed: true, retryAfterMs: 0, dailyLimit: false };
  });
}

type VtResult = { response: globalThis.Response; json: any };
async function vtRequest(
  url: string,
  init: RequestInit = {},
  waitForQuota = false,
  timeoutMs = 30_000,
): Promise<VtResult> {
  const key = virusTotalApiKey();
  if (!key) throw new Error("VirusTotal is not configured (VIRUSTOTAL_API_KEY or VirusTotal_Key is unset)");
  let reservation = await reserveVirusTotalRequest();
  while (!reservation.allowed) {
    if (!waitForQuota || reservation.dailyLimit) {
      const error = new Error(reservation.dailyLimit
        ? "VirusTotal public API daily request quota reached (500/day)"
        : "VirusTotal public API request quota reached (4/minute)");
      (error as Error & { status: number }).status = 429;
      throw error;
    }
    await delay(reservation.retryAfterMs);
    reservation = await reserveVirusTotalRequest();
  }
  const response = await fetch(url, {
    ...init,
    headers: { "x-apikey": key, ...init.headers },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  const text = await response.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* handled as explicit provider error below */ }
  if (!response.ok) {
    const error = new Error(`VirusTotal returned HTTP ${response.status}${json?.error?.message ? `: ${json.error.message}` : ""}`);
    (error as Error & { status: number }).status = response.status;
    throw error;
  }
  return { response, json };
}

function resultStats(json: any) {
  const stats = json?.data?.attributes?.last_analysis_stats ?? json?.data?.attributes?.stats;
  if (!stats) return null;
  const counts = [stats.harmless, stats.undetected, stats.suspicious, stats.malicious];
  if (!counts.every((count) => Number.isSafeInteger(count) && count >= 0) ||
      counts.every((count) => count === 0)) return null;
  return stats as { harmless: number; undetected: number; suspicious: number; malicious: number };
}

async function pollAnalysis(fileId: number, channelId: number, analysisId: string, startedAt: number) {
  const deadline = startedAt + MAX_SCAN_MS;
  try {
    while (Date.now() < deadline) {
      await delay(3_000);
      const { json } = await vtRequest(`${VT_BASE}/analyses/${encodeURIComponent(analysisId)}`, {}, true);
      if (Date.now() > deadline) throw new Error("VirusTotal analysis exceeded the polling deadline");
      const status = json?.data?.attributes?.status;
      if (status === "completed") {
        const stats = resultStats(json);
        if (!stats) throw new Error("VirusTotal completed without usable antivirus statistics");
        const [updated] = await db.update(channelFilesTable).set({
          scanStatus: "completed",
          scanHarmless: stats.harmless,
          scanUndetected: stats.undetected,
          scanSuspicious: stats.suspicious,
          scanMalicious: stats.malicious,
          scanCompletedAt: new Date(),
          scanError: null,
        }).where(eq(channelFilesTable.id, fileId)).returning();
        if (updated) broadcast(`channel:${channelId}`, { type: "file:scanned", data: await serializeFile(updated) });
        return;
      }
      if (status !== "queued" && status !== "in-progress" && status !== "in_progress") {
        throw new Error(`VirusTotal analysis ended in unexpected state: ${String(status)}`);
      }
      await db.update(channelFilesTable).set({ scanStatus: status === "queued" ? "queued" : "in_progress" })
        .where(eq(channelFilesTable.id, fileId));
    }
    throw new Error("VirusTotal analysis exceeded the polling deadline");
  } catch (error) {
    const message = error instanceof Error ? error.message : "VirusTotal analysis failed";
    const [updated] = await db.update(channelFilesTable)
      .set({ scanStatus: "error", scanError: message.slice(0, 500) })
      .where(eq(channelFilesTable.id, fileId)).returning();
    if (updated) broadcast(`channel:${channelId}`, { type: "file:scanned", data: await serializeFile(updated) });
  }
}

function startScanPolling(file: typeof channelFilesTable.$inferSelect): Promise<void> | undefined {
  if (!file.scanAnalysisId) return undefined;
  const existing = scanPollsInFlight.get(file.id);
  if (existing) return existing;
  const startedAt = file.scanSubmittedAt?.getTime() ?? file.createdAt.getTime();
  holdHashOperation(file.sha256);
  const poll = pollAnalysis(file.id, file.channelId, file.scanAnalysisId, startedAt)
    .finally(() => {
      scanPollsInFlight.delete(file.id);
      releaseHashOperation(file.sha256);
    });
  scanPollsInFlight.set(file.id, poll);
  return poll;
}

async function recoverPendingScan(file: typeof channelFilesTable.$inferSelect): Promise<typeof channelFilesTable.$inferSelect> {
  if (file.scanStatus !== "queued" && file.scanStatus !== "in_progress") return file;
  const startedAt = file.scanSubmittedAt?.getTime() ?? file.createdAt.getTime();
  if (virusTotalApiKey() && file.scanAnalysisId && startedAt + MAX_SCAN_MS > Date.now()) {
    startScanPolling(file);
    return file;
  }
  const reason = !virusTotalApiKey()
    ? "VirusTotal API key is unavailable; pending scan cannot be resumed"
    : file.scanAnalysisId
    ? "VirusTotal analysis exceeded its polling deadline and was not resumed"
    : "Pending VirusTotal scan has no analysis ID and cannot be resumed";
  const [updated] = await db.update(channelFilesTable)
    .set({ scanStatus: "error", scanError: reason })
    .where(eq(channelFilesTable.id, file.id))
    .returning();
  if (updated) broadcast(`channel:${file.channelId}`, { type: "file:scanned", data: await serializeFile(updated) });
  return updated ?? file;
}

router.post("/channels/:channelId/files/:fileId/verify", requireAuth, channelFileVerifyRateLimit, async (req, res): Promise<void> => {
  const channel = await getAccessibleMediaChannel(req, res);
  if (!channel) return;
  const fileId = parseId(req.params.fileId);
  if (!fileId) { res.status(404).json({ error: "File not found" }); return; }
  const [file] = await db.select().from(channelFilesTable).where(and(
    eq(channelFilesTable.id, fileId),
    eq(channelFilesTable.channelId, channel.id),
  ));
  if (!file) { res.status(404).json({ error: "File not found" }); return; }
  if (req.body?.consent !== true) {
    res.status(400).json({ error: "Explicit consent:true is required before sharing this file or its hash with VirusTotal" }); return;
  }
  const eligibility = scanEligibility(file);
  if (eligibility.reason === "too_large") {
    res.status(413).json({ error: `File exceeds the VirusTotal ${VIRUSTOTAL_MAX_BYTES}-byte scan limit`, scanEligibility: eligibility }); return;
  }
  if (!eligibility.eligible) {
    res.status(422).json({ error: "This file type is outside VirusTotal scanning scope", scanEligibility: eligibility }); return;
  }
  const pendingScan = await recoverPendingScan(file);
  if (pendingScan.scanStatus === "queued" || pendingScan.scanStatus === "in_progress") {
    res.status(202).json(serializeScan(pendingScan, Boolean(virusTotalApiKey()))); return;
  }
  const existingCompleted = await db.select().from(channelFilesTable).where(and(
    eq(channelFilesTable.sha256, file.sha256),
    eq(channelFilesTable.scanStatus, "completed"),
  )).orderBy(desc(channelFilesTable.scanCompletedAt)).limit(1);
  if (existingCompleted[0]) {
    const prior = existingCompleted[0];
    const [updated] = await db.update(channelFilesTable).set({
      scanStatus: "completed",
      scanSource: "local",
      scanHarmless: prior.scanHarmless,
      scanUndetected: prior.scanUndetected,
      scanSuspicious: prior.scanSuspicious,
      scanMalicious: prior.scanMalicious,
      scanSubmittedBy: prior.scanSubmittedBy,
      scanSubmittedAt: prior.scanSubmittedAt,
      scanCompletedAt: prior.scanCompletedAt,
      scanError: null,
    }).where(eq(channelFilesTable.id, file.id)).returning();
    broadcast(`channel:${channel.id}`, { type: "file:scanned", data: await serializeFile(updated) });
    res.status(200).json(serializeScan(updated, true)); return;
  }
  const key = virusTotalApiKey();
  if (!key) { res.status(503).json({ error: "VirusTotal scanning is unavailable because neither VIRUSTOTAL_API_KEY nor VirusTotal_Key is configured" }); return; }
  const filePath = privateFilePath(file.storageKey);
  if (!filePath) { res.status(404).json({ error: "File bytes not found" }); return; }
  if (activeHashOperations.has(file.sha256)) {
    res.status(409).json({ error: "A VirusTotal verification for this file hash is already in progress" }); return;
  }
  holdHashOperation(file.sha256);
  let hashLockReleased = false;
  const submittedAt = new Date();
  let source: string | null = null;
  let analysisId: string | undefined;
  let contentMayHaveBeenSent = false;
  try {
    let lookupStats: ReturnType<typeof resultStats> = null;
    let lookupFound = false;
    try {
      const lookup = await vtRequest(`${VT_BASE}/files/${file.sha256}`);
      source = "hash";
      lookupFound = true;
      lookupStats = resultStats(lookup.json);
    } catch (error) {
      if ((error as Error & { status?: number }).status !== 404) throw error;
    }
    if (lookupStats) {
      const [updated] = await db.update(channelFilesTable).set({
        scanStatus: "completed", scanSource: source,
        scanHarmless: lookupStats.harmless, scanUndetected: lookupStats.undetected,
        scanSuspicious: lookupStats.suspicious, scanMalicious: lookupStats.malicious,
        scanSubmittedBy: null, scanSubmittedAt: null,
        scanCompletedAt: new Date(), scanError: null,
      }).where(eq(channelFilesTable.id, file.id)).returning();
      const data = serializeScan(updated, true);
      broadcast(`channel:${channel.id}`, { type: "file:scanned", data: { ...(await serializeFile(updated)) } });
      res.status(200).json(data); return;
    }
    if (lookupFound) {
      const [updated] = await db.update(channelFilesTable).set({
        scanStatus: "error",
        scanSource: "hash",
        scanSubmittedBy: null,
        scanSubmittedAt: null,
        scanError: "VirusTotal has a hash report but its analysis statistics are incomplete",
      }).where(eq(channelFilesTable.id, file.id)).returning();
      broadcast(`channel:${channel.id}`, { type: "file:scanned", data: await serializeFile(updated) });
      res.status(200).json(serializeScan(updated, true)); return;
    }
    const fileBlob = await openAsBlob(filePath, { type: file.mimeType });
    const form = new FormData();
    form.set("file", fileBlob, file.filename);
    if (file.sizeBytes > 32 * 1024 * 1024) {
      const { json } = await vtRequest(`${VT_BASE}/files/upload_url`);
      const rawUploadUrl = json?.data;
      let uploadUrl: URL;
      try { uploadUrl = new URL(rawUploadUrl); } catch { throw new Error("VirusTotal returned an invalid upload URL"); }
      if (uploadUrl.protocol !== "https:" || (uploadUrl.hostname !== "virustotal.com" && !uploadUrl.hostname.endsWith(".virustotal.com")) ||
          uploadUrl.username || uploadUrl.password || (uploadUrl.port && uploadUrl.port !== "443")) {
        throw new Error("VirusTotal returned an unsafe upload URL; upload refused");
      }
      contentMayHaveBeenSent = true;
      const { json: uploaded } = await vtRequest(uploadUrl.toString(), { method: "POST", body: form }, false, 5 * 60 * 1000);
      analysisId = uploaded?.data?.id;
    } else {
      contentMayHaveBeenSent = true;
      const { json: uploaded } = await vtRequest(`${VT_BASE}/files`, { method: "POST", body: form }, false, 5 * 60 * 1000);
      analysisId = uploaded?.data?.id;
    }
    if (typeof analysisId !== "string" || !analysisId) throw new Error("VirusTotal did not return an analysis ID");
    source = "upload";
    const [updated] = await db.update(channelFilesTable).set({
      scanStatus: "queued", scanSource: source, scanSubmittedBy: req.session.userId!,
      scanSubmittedAt: submittedAt, scanAnalysisId: analysisId,
      scanHarmless: null, scanUndetected: null, scanSuspicious: null, scanMalicious: null,
      scanCompletedAt: null, scanError: null,
    }).where(eq(channelFilesTable.id, file.id)).returning();
    const data = serializeScan(updated, true);
    broadcast(`channel:${channel.id}`, { type: "file:scanned", data: await serializeFile(updated) });
    startScanPolling(updated);
    releaseHashOperation(file.sha256);
    hashLockReleased = true;
    res.status(202).json(data);
  } catch (error) {
    const status = (error as Error & { status?: number }).status;
    const message = error instanceof Error ? error.message : "VirusTotal request failed";
    const [updated] = await db.update(channelFilesTable).set({
      scanStatus: "error", scanSource: source ?? null,
      scanSubmittedBy: contentMayHaveBeenSent ? req.session.userId! : null,
      scanSubmittedAt: contentMayHaveBeenSent ? submittedAt : null,
      scanError: message.slice(0, 500),
    }).where(eq(channelFilesTable.id, file.id)).returning();
    if (updated) broadcast(`channel:${channel.id}`, { type: "file:scanned", data: await serializeFile(updated) });
    if (status === 429) { res.status(429).json({ error: message }); return; }
    res.status(status && status >= 400 && status < 600 ? status : 502).json({ error: message }); return;
  } finally {
    if (!hashLockReleased) releaseHashOperation(file.sha256);
  }
});

router.get("/channels/:channelId/files/:fileId/scan", requireAuth, async (req, res): Promise<void> => {
  const channel = await getAccessibleMediaChannel(req, res);
  if (!channel) return;
  const fileId = parseId(req.params.fileId);
  if (!fileId) { res.status(404).json({ error: "File not found" }); return; }
  const [file] = await db.select().from(channelFilesTable).where(and(
    eq(channelFilesTable.id, fileId),
    eq(channelFilesTable.channelId, channel.id),
  ));
  if (!file) { res.status(404).json({ error: "File not found" }); return; }
  const current = await recoverPendingScan(file);
  res.json(serializeScan(current, Boolean(virusTotalApiKey())));
});

async function cleanupExpiredUploads() {
  const allUploads = await db.select().from(channelFileUploadsTable);
  for (const upload of allUploads) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('channel_file_upload'), hashtext(${upload.id}))`);
        const [current] = await tx.select().from(channelFileUploadsTable)
          .where(eq(channelFileUploadsTable.id, upload.id)).for("update");
        if (!current || current.expiresAt.getTime() > Date.now()) return;
        if (current.completedFileId === null) await removePrivateFile(current.storageKey);
        await tx.delete(channelFileUploadsTable).where(eq(channelFileUploadsTable.id, current.id));
      });
    } catch (error) {
      logger.warn({ err: error, uploadId: upload.id }, "Failed to clean expired channel file upload session");
    }
  }
  const stagedChunks = await fs.promises.readdir(CHANNEL_FILE_TEMP_DIR, { withFileTypes: true });
  const staleBefore = Date.now() - 60 * 60 * 1000;
  for (const entry of stagedChunks) {
    if (!entry.isFile() || !/^[0-9a-f-]{36}\.chunk$/i.test(entry.name)) continue;
    const stagedPath = path.join(CHANNEL_FILE_TEMP_DIR, entry.name);
    const stat = await fs.promises.stat(stagedPath);
    if (stat.mtimeMs < staleBefore) removeQuietly(stagedPath);
  }
}
const cleanupTimer = setInterval(() => {
  void cleanupExpiredUploads().catch((error) => logger.warn({ err: error }, "Channel file temporary upload cleanup failed"));
}, 60 * 60 * 1000);
cleanupTimer.unref();
void cleanupExpiredUploads().catch((error) => logger.warn({ err: error }, "Channel file temporary upload cleanup failed"));

export async function removeChannelFileData(channelId: number): Promise<void> {
  const [files, uploads] = await Promise.all([
    db.select({ storageKey: channelFilesTable.storageKey }).from(channelFilesTable).where(eq(channelFilesTable.channelId, channelId)),
    db.select({ storageKey: channelFileUploadsTable.storageKey }).from(channelFileUploadsTable).where(eq(channelFileUploadsTable.channelId, channelId)),
  ]);
  for (const item of [...files, ...uploads]) await removePrivateFile(item.storageKey);
}

export default router;