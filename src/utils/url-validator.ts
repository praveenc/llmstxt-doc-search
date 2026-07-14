/**
 * URL validation and SSRF guards.
 *
 * Two layers of defense:
 *  1. assertPublicHttpUrl - static checks on the URL string (scheme, and a
 *     fast reject of literal private/loopback/link-local IPs in the host).
 *  2. assertPublicAddress - checks a *resolved* IP address against the full set
 *     of private/reserved ranges. This is enforced at connection time by the
 *     fetcher (see doc-fetcher.ts) to close DNS-rebinding, and it re-runs on
 *     every redirect hop.
 */
import ipaddr from "ipaddr.js";

export class URLValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "URLValidationError";
  }
}

/**
 * ipaddr.js range categories we refuse to connect to. "unicast" is the only
 * range we allow; everything else (loopback, linkLocal, private, uniqueLocal,
 * carrierGradeNat, reserved, broadcast, multicast, ...) is rejected.
 */
const BLOCKED_RANGES = new Set([
  "unspecified",
  "broadcast",
  "multicast",
  "linkLocal",
  "loopback",
  "private",
  "reserved",
  "carrierGradeNat",
  "uniqueLocal",
  "ipv4Mapped",
  "rfc6145",
  "rfc6052",
  "6to4",
  "teredo",
]);

/**
 * True if a resolved IP address (string) is a public, routable unicast address.
 * Handles IPv4, IPv6, IPv4-mapped IPv6, and reserved ranges. This is the
 * authoritative SSRF check; the string-level host check is only a fast path.
 */
export function isPublicAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return false;
  }
  // Normalize IPv4-mapped IPv6 (e.g. ::ffff:169.254.169.254) to its IPv4 form
  // so the underlying v4 range is evaluated, not the v6 wrapper.
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address();
  }
  const range = addr.range();
  return !BLOCKED_RANGES.has(range);
}

/**
 * Assert a resolved IP is public/routable.
 * @throws URLValidationError for any private/reserved/loopback/link-local address.
 */
export function assertPublicAddress(ip: string, host?: string): void {
  if (!isPublicAddress(ip)) {
    const where = host ? `${host} -> ${ip}` : ip;
    throw new URLValidationError(`refusing private/internal address: ${where}`);
  }
}

/**
 * Ensure a URL is a public http(s) URL. Returns the normalized URL string.
 *
 * This performs static checks only: scheme allow-list and a fast reject when
 * the host is *already* a private IP literal. It cannot catch hosts that
 * resolve to private IPs (DNS rebinding) - the fetcher enforces
 * assertPublicAddress at connection time for that.
 *
 * @throws URLValidationError for bad scheme, unparseable URL, or literal private host.
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
  // Reject obvious names and any host that is already an IP literal in a
  // blocked range (covers decimal/hex/octal/IPv6 encodings via ipaddr.js).
  let host = u.hostname;
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new URLValidationError(`refusing private/internal host: ${host}`);
  }
  // Strip IPv6 brackets before parsing.
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (ipaddr.isValid(host) && !isPublicAddress(host)) {
    throw new URLValidationError(`refusing private/internal host: ${u.hostname}`);
  }
  return u.toString();
}
