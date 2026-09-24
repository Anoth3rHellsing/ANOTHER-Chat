export const GIPHY_RATING = "g";
export const GIPHY_PAGE_SIZE = 24;
export const GIPHY_MESSAGE_PREFIX = "[[giphy-gif]]";

export interface GiphySearchResult {
  id: string;
  url: string;
  title: string;
}

export function isTrustedGiphyMediaUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.port === ""
      && url.username === ""
      && url.password === ""
      && /^(?:media\d*|images)\.giphy\.com$/i.test(url.hostname);
  } catch {
    return false;
  }
}

export function parseGiphyMessage(content: unknown): string | null {
  if (typeof content !== "string" || !content.startsWith(GIPHY_MESSAGE_PREFIX)) return null;
  const url = content.slice(GIPHY_MESSAGE_PREFIX.length);
  return isTrustedGiphyMediaUrl(url) ? url : null;
}

export function isMalformedGiphyMessage(content: unknown): boolean {
  return typeof content === "string"
    && content.startsWith(GIPHY_MESSAGE_PREFIX)
    && parseGiphyMessage(content) === null;
}

export function buildGiphyApiUrl(apiKey: string, query: string, offset: number): URL {
  const endpoint = new URL(query ? "https://api.giphy.com/v1/gifs/search" : "https://api.giphy.com/v1/gifs/trending");
  endpoint.searchParams.set("api_key", apiKey);
  endpoint.searchParams.set("rating", GIPHY_RATING);
  endpoint.searchParams.set("limit", String(GIPHY_PAGE_SIZE));
  endpoint.searchParams.set("offset", String(offset));
  if (query) endpoint.searchParams.set("q", query);
  return endpoint;
}

export function normalizeGiphyResponse(payload: unknown, offset: number): {
  data: GiphySearchResult[];
  nextOffset: number;
  hasMore: boolean;
} {
  if (!payload || typeof payload !== "object") throw new Error("Respuesta Giphy inválida");
  const body = payload as {
    data?: Array<{ id?: unknown; title?: unknown; images?: { fixed_width?: { url?: unknown } } }>;
    pagination?: { total_count?: unknown };
  };
  const data = (Array.isArray(body.data) ? body.data : []).flatMap(item => {
    if (!item || typeof item.id !== "string" || !isTrustedGiphyMediaUrl(item.images?.fixed_width?.url)) return [];
    return [{
      id: item.id.slice(0, 100),
      url: item.images.fixed_width.url,
      title: typeof item.title === "string" ? item.title.slice(0, 160) : "GIF de GIPHY",
    }];
  });
  const nextOffset = offset + (Array.isArray(body.data) ? body.data.length : 0);
  const totalCount = Number(body.pagination?.total_count);
  return {
    data,
    nextOffset,
    hasMore: data.length > 0 && Number.isFinite(totalCount) && nextOffset < totalCount,
  };
}