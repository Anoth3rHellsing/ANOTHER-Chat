import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

const message = { error: "Demasiadas solicitudes. Inténtalo de nuevo más tarde." };

function keyBySessionOrIp(req: Request): string {
  if (req.session?.userId) return `user:${req.session.userId}`;
  return `ip:${ipKeyGenerator(req.ip ?? "")}`;
}

export const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message,
});

export const inviteRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyBySessionOrIp,
  message,
});

export const messageRateLimit = rateLimit({
  windowMs: 10 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyBySessionOrIp,
  message,
});

export const soundboardTriggerRateLimit = rateLimit({
  windowMs: 2 * 1000,
  limit: 1,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyBySessionOrIp,
  message: { error: "Espera 2 segundos antes de disparar otro sonido." },
});

export const channelFileVerifyRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 4,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyBySessionOrIp,
  message: { error: "File verification requests are limited to 4 per minute." },
});