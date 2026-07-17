/**
 * Link preview (OG tag unfurl) with in-memory cache + SSRF protection.
 *
 * Safety guarantees:
 * - Only http/https on ports 80/443 (or unspecified)
 * - DNS-resolves every hostname; blocks all private/reserved IPv4 and IPv6
 * - IPv4-mapped IPv6 (::ffff:…) decoded from both dotted-decimal AND hex notation
 * - Validates each redirect hop before following (at most 1 hop)
 * - 3-second fetch timeout, reads at most 50 KB of HTML body
 * - Never throws — returns null on any error
 */

import dns from "dns/promises";
import net from "net";

export interface LinkPreview {
  url: string;
  domain: string;
  title?: string;
  description?: string;
  imageUrl?: string;
}

const cache = new Map<string, { data: LinkPreview | null; expiresAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_REGEX);
  if (!matches) return [];
  return [...new Set(matches)].slice(0, 3);
}

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Expand a compressed IPv6 address to its full 8-group form.
 * Returns null if the string is not a valid IPv6 address.
 */
function expandIPv6(addr: string): string | null {
  // Strip brackets from literals like [::1]
  addr = addr.replace(/^\[/, "").replace(/\]$/, "");
  if (!net.isIPv6(addr)) return null;

  // Handle :: expansion
  const halves = addr.split("::");
  if (halves.length > 2) return null;

  const [left, right = ""] = halves;
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const missing = 8 - leftGroups.length - rightGroups.length;
  const middle = Array(missing).fill("0");
  const all = [...leftGroups, ...middle, ...rightGroups];
  if (all.length !== 8) return null;

  return all.map(g => g.padStart(4, "0")).join(":");
}

/**
 * Returns true when the IP string is private/reserved and must be blocked.
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 in all notations.
 */
function isPrivateIp(ip: string): boolean {
  // Strip brackets
  const addr = ip.replace(/^\[/, "").replace(/\]$/, "");

  // ── IPv4 ──────────────────────────────────────────────────────────────────
  if (net.isIPv4(addr)) {
    const parts = addr.split(".").map(Number);
    const [a, b, c] = parts;
    if (a === 0) return true;                                           // 0.0.0.0/8
    if (a === 10) return true;                                          // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true;                 // 100.64.0.0/10 CGNAT
    if (a === 127) return true;                                         // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;                            // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true;                  // 172.16.0.0/12
    if (a === 192 && b === 0 && c === 0) return true;                  // 192.0.0.0/24 IANA special
    if (a === 192 && b === 0 && c === 2) return true;                  // 192.0.2.0/24 TEST-NET-1
    if (a === 192 && b === 168) return true;                           // 192.168.0.0/16
    if (a === 198 && b === 18) return true;                            // 198.18.0.0/15 benchmark
    if (a === 198 && b === 51 && c === 100) return true;               // 198.51.100.0/24 TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true;                // 203.0.113.0/24 TEST-NET-3
    if (a >= 224) return true;                                         // 224+ multicast/reserved/broadcast
    if (addr === "255.255.255.255") return true;
    return false;
  }

  // ── IPv6 ──────────────────────────────────────────────────────────────────
  if (!net.isIPv6(addr)) return false; // unknown format — block to be safe

  const expanded = expandIPv6(addr);
  if (!expanded) return true; // failed to parse — block

  const groups = expanded.split(":").map(g => parseInt(g, 16));

  // Loopback ::1  → 0:0:0:0:0:0:0:1
  if (groups.every((g, i) => g === (i === 7 ? 1 : 0))) return true;

  // Unspecified :: → all zeros
  if (groups.every(g => g === 0)) return true;

  // IPv4-mapped   ::ffff:w.x.y.z  (groups[5] === 0xffff, groups[0-4] === 0)
  // Also handles  ::ffff:0:w.x.y.z (RFC 6145 - IPv4-translated)
  const isMapped =
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0 && groups[5] === 0xffff;
  const isTranslated =
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 &&
    groups[4] === 0xffff && groups[5] === 0;

  if (isMapped || isTranslated) {
    // groups[6] and [7] encode the IPv4 address
    const a = (groups[6] >> 8) & 0xff;
    const b = groups[6] & 0xff;
    const c = (groups[7] >> 8) & 0xff;
    const d = groups[7] & 0xff;
    return isPrivateIp(`${a}.${b}.${c}.${d}`);
  }

  // 64:ff9b::/96  (RFC 6052 well-known prefix — maps to IPv4)
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
    const a = (groups[6] >> 8) & 0xff;
    const b = groups[6] & 0xff;
    const c = (groups[7] >> 8) & 0xff;
    const d = groups[7] & 0xff;
    return isPrivateIp(`${a}.${b}.${c}.${d}`);
  }

  // Link-local fe80::/10
  if ((groups[0] & 0xffc0) === 0xfe80) return true;

  // Unique-local fc00::/7  (fc00:: through fdff::)
  if ((groups[0] & 0xfe00) === 0xfc00) return true;

  // Documentation 2001:db8::/32
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;

  // Deprecated site-local fec0::/10
  if ((groups[0] & 0xffc0) === 0xfec0) return true;

  // Multicast ff00::/8
  if ((groups[0] & 0xff00) === 0xff00) return true;

  return false;
}

/** Validate URL safety before ANY network contact. */
async function isSafeUrl(rawUrl: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  // Only http/https
  if (!["http:", "https:"].includes(parsed.protocol)) return false;

  // Only standard HTTP/HTTPS ports
  if (parsed.port && parsed.port !== "80" && parsed.port !== "443") return false;

  const hostname = parsed.hostname.toLowerCase();

  // Reject bare IP literals that are private without DNS lookup
  if (net.isIPv4(hostname) || net.isIPv6(hostname.replace(/^\[|\]$/g, ""))) {
    return !isPrivateIp(hostname);
  }

  // Block known dangerous hostnames
  const blocked = [
    "localhost", "localhost.localdomain",
    "metadata.google.internal", "metadata.goog",
    "169.254.169.254", // AWS/GCP/Azure instance metadata (as name, just in case)
  ];
  if (blocked.includes(hostname)) return false;
  if (hostname.endsWith(".internal") || hostname.endsWith(".local")) return false;

  // Resolve and check every IP the hostname resolves to
  try {
    const records = await dns.lookup(hostname, { all: true });
    for (const { address } of records) {
      if (isPrivateIp(address)) return false;
    }
    if (records.length === 0) return false; // no resolution — block
  } catch {
    return false; // DNS failure — block
  }

  return true;
}

function extractMeta(html: string, url: string): LinkPreview | null {
  const getTag = (prop: string): string | undefined => {
    const ogMatch =
      html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, "i")) ??
      html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, "i"));
    if (ogMatch) return ogMatch[1];
    const twitterProp = prop.replace("og:", "twitter:");
    const twMatch =
      html.match(new RegExp(`<meta[^>]+name=["']${twitterProp}["'][^>]+content=["']([^"']+)["']`, "i")) ??
      html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${twitterProp}["']`, "i"));
    return twMatch ? twMatch[1] : undefined;
  };

  const getTitle = (): string | undefined => {
    const ogTitle = getTag("og:title");
    if (ogTitle) return ogTitle;
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    return m ? m[1].trim() : undefined;
  };

  const title = getTitle();
  const description = getTag("og:description");
  const imageUrl = getTag("og:image");
  if (!title && !description && !imageUrl) return null;
  return { url, domain: getDomain(url), title, description, imageUrl };
}

const MAX_REDIRECTS = 1; // hard cap on redirect hops

export async function fetchLinkPreview(url: string): Promise<LinkPreview | null> {
  const now = Date.now();
  const cached = cache.get(url);
  if (cached && cached.expiresAt > now) return cached.data;

  /** Iterative fetch — follows at most MAX_REDIRECTS hops, breaks cycles. */
  const _fetch = async (startUrl: string): Promise<LinkPreview | null> => {
    const visited = new Set<string>();
    let currentUrl = startUrl;
    let hops = 0;

    while (true) {
      // Cycle guard
      if (visited.has(currentUrl)) return null;
      visited.add(currentUrl);

      // Safety check before every hop
      if (!(await isSafeUrl(currentUrl))) return null;

      let response: Response;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        response = await fetch(currentUrl, {
          signal: controller.signal,
          headers: {
            "User-Agent": "ANOTHERBot/1.0 link-preview",
            Accept: "text/html,application/xhtml+xml",
          },
          redirect: "manual", // We manage hops ourselves
        });
        clearTimeout(timeout);
      } catch {
        return null;
      }

      // Redirect handling — strictly bounded
      if (response.status >= 300 && response.status < 400) {
        if (hops >= MAX_REDIRECTS) return null; // hop limit exceeded
        const location = response.headers.get("location");
        if (!location) return null;
        let absLocation: string;
        try {
          absLocation = new URL(location, currentUrl).toString();
        } catch {
          return null;
        }
        currentUrl = absLocation;
        hops++;
        continue;
      }

      // Success — parse HTML
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) return null;

      const reader = response.body?.getReader();
      if (!reader) return null;
      let html = "";
      let bytes = 0;
      try {
        while (bytes < 50000) {
          const { done, value } = await reader.read();
          if (done) break;
          html += new TextDecoder().decode(value);
          bytes += value.length;
        }
      } finally {
        reader.cancel().catch(() => {});
      }

      return extractMeta(html, startUrl);
    }
  };

  try {
    const preview = await _fetch(url);
    cache.set(url, { data: preview, expiresAt: now + CACHE_TTL_MS });
    return preview;
  } catch {
    cache.set(url, { data: null, expiresAt: now + CACHE_TTL_MS });
    return null;
  }
}

export async function fetchFirstLinkPreview(text: string): Promise<LinkPreview | null> {
  const urls = extractUrls(text);
  for (const url of urls) {
    const preview = await fetchLinkPreview(url);
    if (preview) return preview;
  }
  return null;
}
