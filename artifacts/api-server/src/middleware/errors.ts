import type { ErrorRequestHandler } from "express";
import { logger } from "../lib/logger";

export const finalErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  logger.error({ err, method: req.method, url: req.originalUrl }, "Unhandled request error");
  const candidate = Number((err as { status?: unknown; statusCode?: unknown })?.statusCode ??
    (err as { status?: unknown })?.status);
  const status = Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  res.status(status).json({
    error: status >= 500 ? "Error interno del servidor" : "Solicitud rechazada",
  });
};