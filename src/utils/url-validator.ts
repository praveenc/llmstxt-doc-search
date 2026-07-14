/**
 * URL validation and SSRF guards.
 */

export class URLValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "URLValidationError";
  }
}

/** Hosts we refuse to fetch (loopback / link-local / private ranges). */
const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.0\.0\.0|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?)/i;

/**
 * Ensure a URL is a public http(s) URL. Returns the normalized URL string.
 * @throws URLValidationError for bad scheme, unparseable URL, or private/internal host.
 */
export function assertPublicHttpUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new URLValidationError(`invalid URL: ${raw}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new URLValidationError(`unsupported scheme: ${u.protocol} (${raw})`);
  }
  if (PRIVATE_HOST_RE.test(u.hostname)) {
    throw new URLValidationError(`refusing private/internal host: ${u.hostname}`);
  }
  return u.toString();
}
