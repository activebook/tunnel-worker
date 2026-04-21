// ── Shared utilities (compiled once, imported wherever needed) ──────────────

/**
 * Converts a 16-byte UUID Uint8Array extracted from the protocol header
 * into the canonical hyphenated string representation (8-4-4-4-12).
 */
export function stringifyUuid(uuidBytes: Uint8Array): string {
  const hex = Array.from(uuidBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Well-known connectivity-check hostnames used by Android, iOS, Windows and
// Firefox. Intercepting these avoids a full egress round-trip during health
// probing and returns a synthetic 204 straight from the edge.
export const HEALTH_CHECK_HOSTS = new Set([
  'www.gstatic.com',
  'cp.cloudflare.com',
  'connectivitycheck.gstatic.com',
  'detectportal.firefox.com',
]);

// Pre-encoded once at module load — avoids TextEncoder allocation on every
// health-check hit across the lifetime of the isolate.
export const FAKE_204 = new TextEncoder().encode(
  'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
);
