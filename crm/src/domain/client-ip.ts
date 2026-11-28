/**
 * Visitor IP for rate limiting, read from the headers nginx sets.
 *
 * Production nginx overwrites X-Real-IP with the TCP peer, but it APPENDS to a
 * client-supplied X-Forwarded-For (`$proxy_add_x_forwarded_for`), so the first
 * entry of that header is whatever the visitor sent. Trusting that first entry
 * let anyone rotate a fake header and get a fresh rate-limit bucket per request.
 *
 * Order: X-Real-IP (the CRM only listens on 127.0.0.1, so only nginx reaches
 * it), then the last X-Forwarded-For entry — the one the proxy added.
 */
export function clientIp(getHeader: (name: string) => string | undefined): string {
  const real = (getHeader("x-real-ip")?.split(",")[0] ?? "").trim();
  if (real) return real;
  const forwarded = getHeader("x-forwarded-for");
  const last = forwarded
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .pop();
  return last || "127.0.0.1";
}
