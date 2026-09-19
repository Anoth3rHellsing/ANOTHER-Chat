import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";

export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function issueCsrfToken(
  req: Request,
  res: Response,
  options: { rotate?: boolean } = {},
): string {
  const token = !options.rotate && req.session.csrfToken
    ? req.session.csrfToken
    : randomBytes(32).toString("hex");
  req.session.csrfToken = token;
  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_MS,
    path: "/",
  });
  return token;
}