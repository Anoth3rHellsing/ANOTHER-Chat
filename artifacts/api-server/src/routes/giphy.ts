import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { buildGiphyApiUrl, GIPHY_PAGE_SIZE, normalizeGiphyResponse } from "../lib/giphy";
import { giphySearchRateLimit } from "../middleware/rate-limit";

interface GiphyRouterOptions {
  getApiKey?: () => string | undefined;
  fetchImpl?: typeof fetch;
}

export function createGiphyRouter(options: GiphyRouterOptions = {}): IRouter {
  const router: IRouter = Router();
  const getApiKey = options.getApiKey ?? (() => process.env.Giphy);
  const fetchImpl = options.fetchImpl ?? fetch;

  router.get("/giphy/status", requireAuth, (_req, res): void => {
    res.json({
      available: !!getApiKey()?.trim(),
      ...(getApiKey()?.trim() ? {} : { message: "Selector de GIF no disponible: falta configurar la clave de GIPHY en el servidor." }),
    });
  });

  router.get("/giphy/search", requireAuth, giphySearchRateLimit, async (req, res): Promise<void> => {
    const apiKey = getApiKey()?.trim();
    if (!apiKey) {
      res.status(503).json({ error: "La búsqueda de GIF no está disponible en este momento." });
      return;
    }

    const rawQuery = typeof req.query.q === "string" ? req.query.q : "";
    const query = rawQuery.trim();
    if (query.length > 80) {
      res.status(400).json({ error: "La búsqueda no puede superar los 80 caracteres." });
      return;
    }

    const rawOffset = typeof req.query.offset === "string" ? req.query.offset : "0";
    const offset = Number(rawOffset);
    if (!Number.isInteger(offset) || offset < 0 || offset > 4990) {
      res.status(400).json({ error: "Desplazamiento de resultados inválido." });
      return;
    }

    try {
      const response = await fetchImpl(buildGiphyApiUrl(apiKey, query, offset), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        req.log.warn({ status: response.status }, "GIPHY request failed");
        res.status(502).json({ error: "No se pudieron cargar los GIF. Inténtalo de nuevo." });
        return;
      }
      const result = normalizeGiphyResponse(await response.json(), offset);
      res.json({
        ...result,
        pageSize: GIPHY_PAGE_SIZE,
        rating: "g",
      });
    } catch {
      req.log.warn("GIPHY request failed");
      res.status(502).json({ error: "No se pudieron cargar los GIF. Inténtalo de nuevo." });
    }
  });

  return router;
}

export default createGiphyRouter();