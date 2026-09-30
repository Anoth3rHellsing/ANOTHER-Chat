const DEVELOPMENT_FALLBACK = "dev-secret-change-in-production";

/**
 * Firma las cookies de sesión. En producción es obligatorio: sin él el
 * servidor no arranca, igual que sin MESSAGE_ENCRYPTION_KEY (AGENTS.md §7.5).
 * El valor de respaldo solo existe fuera de producción y es público (está
 * en el repositorio), así que nunca debe firmar sesiones reales.
 */
export function loadSessionSecret(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.SESSION_SECRET?.trim();
  if (value) return value;
  if (env.NODE_ENV === "production") {
    throw new Error(
      "SESSION_SECRET is required in production. Set it to a long random value before starting the server.",
    );
  }
  return DEVELOPMENT_FALLBACK;
}

export const SESSION_SECRET = loadSessionSecret();
