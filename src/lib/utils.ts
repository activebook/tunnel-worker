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

/**
 * Generates a natively compliant, cryptographically secure V4 UUID.
 * Utilizes the globally available Web Crypto API in Cloudflare Workers.
 */
export function generateUuid(): string {
  return crypto.randomUUID();
}

/**
 * Generates a cryptographically secure, URL-safe admin token.
 *
 * Produces 16 random bytes (128 bits of entropy) encoded as lowercase hex,
 * yielding a 32-character opaque string. Deliberately NOT a UUID — the
 * two credential types serve distinct purposes and must remain unambiguous.
 */
export function generateToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Decodes Base64URL early data from Sec-WebSocket-Protocol.
 */
export function decodeEarlyData(base64Url: string): ArrayBuffer | null {
  try {
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, '=');
    const binaryStr = atob(padded);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes.buffer;
  } catch (err) {
    return null;
  }
}
