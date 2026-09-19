import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../lib/csrf";

const PROTECTED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const EXEMPT_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/register",
  "/api/healthz",
  "/ws",
]);

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer);
}

export const csrfProtection: RequestHandler = (req, res, next) => {
  if (
    !PROTECTED_METHODS.has(req.method) ||
    req.method === "OPTIONS" ||
    EXEMPT_PATHS.has(req.path)
  ) {
    next();
    return;
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.get(CSRF_HEADER_NAME);
  const sessionToken = req.session.csrfToken;

  const valid = typeof cookieToken === "string" &&
    typeof headerToken === "string" &&
    typeof sessionToken === "string" &&
    constantTimeEqual(cookieToken, headerToken) &&
    constantTimeEqual(headerToken, sessionToken);

  if (!valid) {
    res.status(403).json({
      error: "Token CSRF ausente o inválido. Recarga la página e inténtalo de nuevo.",
    });
    return;
  }

  next();
};