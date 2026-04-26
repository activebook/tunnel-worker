import { connect } from 'cloudflare:sockets';

/**
 * Performs a TCP connection to measure the network-level round-trip latency to a specific IP.
 * Utilizes the Cloudflare sockets API for accurate proxy latency measurement.
 * 
 * @param ip The IPv4 address to test.
 * @param timeoutMs Maximum time to wait for a connection in milliseconds.
 * @returns The latency in milliseconds, or null if the connection fails or times out.
 */
export async function checkTcpLatency(ip: string, timeoutMs: number = 2000): Promise<number | null> {
  const start = performance.now(); // monotonic, sub-ms precision
  try {
    // We connect to port 443 as it's the standard TLS port for VLESS tunnels
    const socket = connect({ hostname: ip, port: 443 });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });

    // Race the TCP handshake against the timeout
    await Promise.race([socket.opened, timeoutPromise]);

    const latency = performance.now() - start;

    // Clean up the socket immediately after handshake
    socket.close();

    return latency;
  } catch (_) {
    return null;
  }
}

/**
 * Performs a lightweight HTTPS probe to measure RTT from within a Worker isolate.
 *
 * Strategy mirrors the Admin portal's client-side probe (admin.ts):
 *   1. Use HTTPS so the TLS handshake starts — this gives a more accurate RTT.
 *   2. We EXPECT the request to fail with a TypeError (cert mismatch or CF loop
 *      restriction) — that is fine; the time to that failure IS the network RTT.
 *   3. A real AbortError / TimeoutError means the node is unreachable → return null.
 *   4. Subtract a small constant (~10 ms) to account for TLS overhead.
 *
 * Ideal for Cloudflare-to-Cloudflare loopback testing where raw TCP connect() is blocked.
 */
export async function checkHttpLatency(ip: string, timeoutMs: number = 3000): Promise<number | null> {
  const start = performance.now();
  try {
    await fetch(`https://${ip}/`, {
      method: 'HEAD',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    /* Response Example:
     * ---------------------------------------------------
     * HTTP/1.1 502 Bad Gateway        ← CF edge is alive and speaking HTTP
     * Connection: keep-alive          ← it's a proxy (origin servers don't typically set this)
     * Keep-Alive: timeout=4           ← proxy-layer header, not an app server header
     * Proxy-Connection: keep-alive    ← legacy proxy header, confirms it's acting as a middleman
     * Content-Length: 0               ← no body, lightweight — ideal for HEAD probing
     * ---------------------------------------------------
     */
    // Successful response — node is definitely alive; return raw RTT.
    return Math.max(1, Math.round(performance.now() - start));
  } catch (e: any) {
    const elapsed = Math.round(performance.now() - start);
    // Real timeout → dead node
    if (e.name === 'AbortError' || e.name === 'TimeoutError' || elapsed >= timeoutMs - 50) {
      return null;
    }
    // TypeError (cert mismatch / CF loop restriction) → node responded! RTT is accurate.
    // Subtract TLS overhead for a more realistic round-trip estimate.
    return Math.max(1, elapsed - 10);
  }
}
