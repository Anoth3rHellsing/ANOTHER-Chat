const UPLOAD_PATH = /^\/api\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]{0,254})$/;

/**
 * Legacy upload URLs were persisted with an absolute preview host. Rewrite only
 * that exact HTTP(S) upload route to the current origin so browser media
 * requests include the current session cookies. Preserve unrelated external
 * URLs, blob/data previews, and malformed upload-like URLs unchanged.
 */
export function sameOriginUploadUrl(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (!/^https?:\/\//i.test(value)) return value;

  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
        url.username || url.password || url.search || url.hash) {
      return value;
    }
    const match = UPLOAD_PATH.exec(url.pathname);
    if (!match || match[1] === '.' || match[1] === '..') return value;
    return `/api/uploads/${match[1]}`;
  } catch {
    return value;
  }
}