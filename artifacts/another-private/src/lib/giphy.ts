export const GIPHY_MESSAGE_PREFIX = "[[giphy-gif]]";

export interface GiphySelection {
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

export function serializeGiphyMessage(url: string): string {
  if (!isTrustedGiphyMediaUrl(url)) {
    throw new Error("La dirección del GIF no pertenece a GIPHY.");
  }
  return `${GIPHY_MESSAGE_PREFIX}${url}`;
}

export function parseGiphyMessage(content: string): string | null {
  if (!content.startsWith(GIPHY_MESSAGE_PREFIX)) return null;
  const url = content.slice(GIPHY_MESSAGE_PREFIX.length);
  return isTrustedGiphyMediaUrl(url) ? url : null;
}