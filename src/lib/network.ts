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
 * Performs a lightweight HTTP probe to measure RTT.
 * Ideal for Cloudflare-to-Cloudflare loopback testing where raw TCP connect() is blocked.
 */
export async function checkHttpLatency(ip: string, timeoutMs: number = 2000): Promise<number | null> {
  const start = performance.now(); // monotonic, sub-ms precision
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Since Workers are already running inside the Cloudflare network, they are 
    // restricted from using raw TCP sockets to connect back to other Cloudflare Anycast IPs to prevent recursive loops.
    // We use port 80 and a standard diagnostic path.
    await fetch(`http://${ip}/cdn-cgi/trace`, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'Host': 'cloudflare.com' }
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

    return performance.now() - start;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(id);
  }
}
