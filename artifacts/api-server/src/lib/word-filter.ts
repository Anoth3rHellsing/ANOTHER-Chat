import { eq } from "drizzle-orm";
import { db, wordFiltersTable } from "@workspace/db";

/** Minúsculas y sin tildes: «Péndéjo» y «pendejo» cuentan igual. */
export function normalizeForFilter(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Devuelve el primer término filtrado que aparece como palabra completa.
 * Se compara por palabra entera para no bloquear palabras que solo lo
 * contienen («clase» no dispara un filtro de «las»).
 */
export function findFilteredTerm(content: string, terms: readonly string[]): string | null {
  const text = normalizeForFilter(content);
  for (const term of terms) {
    const needle = normalizeForFilter(term).trim();
    if (!needle) continue;
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "u");
    if (pattern.test(text)) return term;
  }
  return null;
}

/** Filtros del servidor que bloquean el mensaje; null si está limpio. */
export async function findBlockedTerm(serverId: number, content: string): Promise<string | null> {
  if (!content.trim()) return null;
  const rows = await db
    .select({ word: wordFiltersTable.word })
    .from(wordFiltersTable)
    .where(eq(wordFiltersTable.serverId, serverId));
  return findFilteredTerm(content, rows.map((row) => row.word));
}

export function blockedTermMessage(term: string): string {
  return `Tu mensaje contiene una palabra no permitida en este servidor: «${term}». Edítalo y vuelve a enviarlo.`;
}
