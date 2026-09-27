/** Normaliza el nombre de un canal igual al crearlo y al renombrarlo: minúsculas, guiones, sin símbolos. */
export function normalizeChannelName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-_]/g, '');
}
