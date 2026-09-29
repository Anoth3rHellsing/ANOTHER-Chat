import { existsSync, statSync } from "node:fs";
import path from "node:path";
import express, { type Express, type RequestHandler, type Response } from "express";

/**
 * Entrega opcional del frontend compilado (Vite) desde este mismo proceso.
 *
 * En Replit el frontend lo sirve la plataforma como un servicio estático aparte,
 * así que ahí `FRONTEND_DIST_DIR` no se define y nada de esto se monta.
 * En un despliegue de un solo contenedor (Coolify, Docker) se define apuntando a
 * `artifacts/another-private/dist/public` y la API entrega también la interfaz.
 *
 * Reglas:
 * - Nunca atiende `/api` ni `/ws`: esas rutas siguen siendo de la API y del WebSocket.
 * - Solo sirve el build público de Vite. Las subidas de usuarios viven en otro
 *   directorio y siguen pasando por la reautorización de `/api/uploads`.
 * - Se monta antes de la sesión: los archivos estáticos no consultan la base.
 * - Se monta antes de Helmet a propósito: Helmet envía `Referrer-Policy: no-referrer`,
 *   y el reproductor incrustado de YouTube falla sin cabecera Referer. Aquí se usa
 *   `strict-origin-when-cross-origin`, el valor por defecto de los navegadores.
 */

const RESERVED_PREFIXES = ["/api", "/ws"];

function isReservedPath(requestPath: string): boolean {
  return RESERVED_PREFIXES.some(prefix =>
    requestPath === prefix || requestPath.startsWith(`${prefix}/`),
  );
}

function setDocumentHeaders(res: Response): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
}

/**
 * Devuelve la ruta absoluta del build del frontend, o `null` si no está configurada.
 * Si está configurada pero no contiene `index.html`, lanza: un despliegue mal
 * construido debe fallar al arrancar, no servir 404 en silencio.
 */
export function resolveFrontendDir(raw: string | undefined = process.env.FRONTEND_DIST_DIR): string | null {
  if (raw === undefined || raw.trim() === "") return null;
  const dir = path.resolve(raw.trim());
  const indexFile = path.join(dir, "index.html");
  if (!existsSync(indexFile) || !statSync(indexFile).isFile()) {
    throw new Error(`FRONTEND_DIST_DIR=${raw} no contiene index.html. Compila el frontend antes de arrancar.`);
  }
  return dir;
}

export function mountFrontend(app: Express, dir: string): void {
  const indexFile = path.join(dir, "index.html");

  const staticFiles = express.static(dir, {
    index: false,
    redirect: false,
    fallthrough: true,
    setHeaders(res, filePath) {
      setDocumentHeaders(res);
      // Vite pone un hash en el nombre de todo lo que hay en assets/: nunca cambia.
      const relative = path.relative(dir, filePath).split(path.sep);
      res.setHeader(
        "Cache-Control",
        relative[0] === "assets" ? "public, max-age=31536000, immutable" : "no-cache",
      );
    },
  });

  const guardedStatic: RequestHandler = (req, res, next) => {
    if (isReservedPath(req.path)) { next(); return; }
    staticFiles(req, res, next);
  };

  // Rutas del cliente (wouter): cualquier GET de navegación que no sea un archivo
  // devuelve index.html. Un archivo inexistente (con extensión) sigue dando 404.
  const spaFallback: RequestHandler = (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") { next(); return; }
    if (isReservedPath(req.path) || path.extname(req.path) !== "") { next(); return; }
    if (!req.accepts("html")) { next(); return; }
    setDocumentHeaders(res);
    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexFile, { cacheControl: false }, error => {
      if (error) next(error);
    });
  };

  app.use(guardedStatic);
  app.use(spaFallback);
}
