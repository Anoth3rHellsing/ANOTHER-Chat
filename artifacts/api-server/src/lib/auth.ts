import { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";

/**
 * Defensa en profundidad: aunque el baneo borra las sesiones, una petición
 * en vuelo podría volver a guardar la suya. Cada petición autenticada
 * comprueba que la cuenta sigue existiendo y no está baneada.
 */
async function rejectInactiveAccount(req: Request, res: Response): Promise<boolean> {
  const [user] = await db
    .select({ banned: usersTable.banned })
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId!));
  if (user && !user.banned) return false;
  await new Promise<void>((resolve) => req.session.destroy(() => resolve()));
  if (!user) {
    res.status(401).json({ error: "No autenticado" });
  } else {
    res.status(403).json({ error: "Tu cuenta ha sido baneada" });
  }
  return true;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.session.userId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  if (await rejectInactiveAccount(req, res)) return;
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.session.userId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  if (await rejectInactiveAccount(req, res)) return;
  if (req.session.userRole !== "admin") {
    res.status(403).json({ error: "Acceso denegado" });
    return;
  }
  next();
}
