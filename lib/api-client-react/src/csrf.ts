export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "X-CSRF-Token";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;

  for (const entry of document.cookie.split(";")) {
    const [rawName, ...rawValue] = entry.trim().split("=");
    if (rawName === CSRF_COOKIE_NAME) {
      return decodeURIComponent(rawValue.join("="));
    }
  }

  return null;
}

export function addCsrfHeader(headers: Headers, method: string): Headers {
  if (!MUTATING_METHODS.has(method.toUpperCase()) || headers.has(CSRF_HEADER_NAME)) {
    return headers;
  }

  const token = readCsrfToken();
  if (token) headers.set(CSRF_HEADER_NAME, token);
  return headers;
}

export function csrfFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  addCsrfHeader(headers, method);
  return fetch(input, { ...init, method, headers });
}