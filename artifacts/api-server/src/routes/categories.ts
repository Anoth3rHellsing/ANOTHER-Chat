import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod/v4";
import { db, channelCategoriesTable, serversTable, serverMembersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth.js";
import { getMemberPermissions, getMembership, hasPerm, PERM } from "../lib/permissions.js";

const router: IRouter = Router();

function parsePositiveId(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function requireManageChannels(req: Request, res: Response, serverId: number): Promise<boolean> {
  if (req.session.userRole === "admin") return true;
  const membership = await getMembership(serverId, req.session.userId!);
  if (!membership) {
    res.status(403).json({ error: "No perteneces a este servidor." });
    return false;
  }
  const perms = await getMemberPermissions(req.session.userId!, serverId);
  if (!hasPerm(perms, PERM.MANAGE_CHANNELS) && perms !== 0xffffffff) {
    res.status(403).json({ error: "Necesitas permiso para administrar canales." });
    return false;
  }
  return true;
}

// POST /servers/:serverId/categories
router.post("/servers/:serverId/categories", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const serverId = parsePositiveId(req.params.serverId);
  if (!serverId) { res.status(400).json({ error: "ID de servidor no válido." }); return; }
  const [server] = await db.select({ id: serversTable.id }).from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) { res.status(404).json({ error: "Servidor no encontrado." }); return; }
  if (!(await requireManageChannels(req, res, serverId))) return;

  const body = z.object({ name: z.string().min(1).max(100) }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Nombre de categoría inválido." }); return; }

  const [maxRow] = await db.select({ maxPos: channelCategoriesTable.position })
    .from(channelCategoriesTable)
    .where(eq(channelCategoriesTable.serverId, serverId))
    .orderBy(desc(channelCategoriesTable.position))
    .limit(1);
  const position = (maxRow?.maxPos ?? -1) + 1;

  const [created] = await db.insert(channelCategoriesTable)
    .values({ serverId, name: body.data.name, position })
    .returning();
  res.status(201).json(created);
});

// PATCH /categories/:categoryId
router.patch("/categories/:categoryId", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const categoryId = parsePositiveId(req.params.categoryId);
  if (!categoryId) { res.status(400).json({ error: "ID de categoría no válido." }); return; }
  const [category] = await db.select().from(channelCategoriesTable).where(eq(channelCategoriesTable.id, categoryId));
  if (!category) { res.status(404).json({ error: "Categoría no encontrada." }); return; }
  if (!(await requireManageChannels(req, res, category.serverId))) return;

  const body = z.object({
    name: z.string().min(1).max(100).optional(),
    position: z.number().int().min(0).optional(),
  }).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Datos de actualización inválidos." }); return; }

  const updates: Record<string, unknown> = {};
  if (body.data.name !== undefined) updates.name = body.data.name;
  if (body.data.position !== undefined) updates.position = body.data.position;
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No se proporcionaron campos para actualizar." }); return; }

  const [updated] = await db.update(channelCategoriesTable)
    .set(updates)
    .where(eq(channelCategoriesTable.id, categoryId))
    .returning();
  res.json(updated);
});

// DELETE /categories/:categoryId
router.delete("/categories/:categoryId", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const categoryId = parsePositiveId(req.params.categoryId);
  if (!categoryId) { res.status(400).json({ error: "ID de categoría no válido." }); return; }
  const [category] = await db.select().from(channelCategoriesTable).where(eq(channelCategoriesTable.id, categoryId));
  if (!category) { res.status(404).json({ error: "Categoría no encontrada." }); return; }
  if (!(await requireManageChannels(req, res, category.serverId))) return;

  await db.delete(channelCategoriesTable).where(eq(channelCategoriesTable.id, categoryId));
  res.sendStatus(204);
});

// PUT /servers/:serverId/categories/reorder
router.put("/servers/:serverId/categories/reorder", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const serverId = parsePositiveId(req.params.serverId);
  if (!serverId) { res.status(400).json({ error: "ID de servidor no válido." }); return; }
  const [server] = await db.select({ id: serversTable.id }).from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) { res.status(404).json({ error: "Servidor no encontrado." }); return; }
  if (!(await requireManageChannels(req, res, serverId))) return;

  const body = z.array(z.object({
    categoryId: z.number().int().positive(),
    position: z.number().int().min(0),
  })).safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: "Formato de reordenamiento inválido." }); return; }

  // Pre-validate that all categoryIds belong to this server
  const submittedIds = body.data.map(item => item.categoryId);
  const existing = await db.select({ id: channelCategoriesTable.id })
    .from(channelCategoriesTable)
    .where(and(
      eq(channelCategoriesTable.serverId, serverId),
    ));
  const validIds = new Set(existing.map(r => r.id));
  const invalidIds = submittedIds.filter(id => !validIds.has(id));
  if (invalidIds.length > 0) {
    res.status(400).json({ error: `IDs de categoría inválidos para este servidor: ${invalidIds.join(", ")}` });
    return;
  }

  await db.transaction(async (tx) => {
    for (const item of body.data) {
      await tx.update(channelCategoriesTable)
        .set({ position: item.position })
        .where(and(
          eq(channelCategoriesTable.id, item.categoryId),
          eq(channelCategoriesTable.serverId, serverId),
        ));
    }
  });
  res.sendStatus(204);
});

// GET /servers/:serverId/categories
router.get("/servers/:serverId/categories", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const serverId = parsePositiveId(req.params.serverId);
  if (!serverId) { res.status(400).json({ error: "ID de servidor no válido." }); return; }

  const membership = await db.select({ id: serverMembersTable.id })
    .from(serverMembersTable)
    .where(and(
      eq(serverMembersTable.serverId, serverId),
      eq(serverMembersTable.userId, req.session.userId!),
    ))
    .limit(1);
  if (membership.length === 0 && req.session.userRole !== "admin") {
    res.status(403).json({ error: "No perteneces a este servidor." });
    return;
  }

  const categories = await db.select()
    .from(channelCategoriesTable)
    .where(eq(channelCategoriesTable.serverId, serverId))
    .orderBy(channelCategoriesTable.position);
  res.json(categories);
});

export default router;