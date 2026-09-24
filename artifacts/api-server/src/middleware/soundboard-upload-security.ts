import type { RequestHandler } from "express";
import path from "path";

export const soundboardUploadSecurity: RequestHandler = (req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'");

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(req.path);
  } catch {
    res.status(404).json({ error: "Not found" });
    return;
  }
  if (path.basename(decodedPath).toLowerCase().startsWith("soundboard-")) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const extension = (req.path.split(".").pop() ?? "").toLowerCase();
  const inlineAllowed = new Set(["jpg", "jpeg", "png", "gif", "webp", "mp4", "webm", "ogg"]);
  if (!inlineAllowed.has(extension)) {
    res.setHeader("Content-Disposition", "attachment");
  }
  next();
};