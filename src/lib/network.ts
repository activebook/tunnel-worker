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

/**
 * Measures real network RTT to a target Cloudflare edge IP by bridging through
 * a non-CF reverse proxy server.
 *
 * @param proxyIp    Non-CF reverse proxy IP from KV.
 * @param targetIp   CF Anycast edge IP to probe through the proxy.
 * @param timeoutMs  Max total wait time (default 5s for two hops).
 * @returns Round-trip ms, or null if the proxy itself is unreachable or timed out.
 */
export async function checkLatencyViaProxy(
  proxyIp: string,
  targetIp: string,
  timeoutMs: number = 5000
): Promise<number | null> {
  const start = performance.now();
  let socket: Socket | null = null;

  try {
    socket = connect({ hostname: proxyIp, port: 443 });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeoutMs)
    );

    await Promise.race([socket.opened, timeoutPromise]);

    const writer = socket.writable.getWriter();
    await writer.write(buildTlsClientHello(targetIp));
    writer.releaseLock();

    const reader = socket.readable.getReader();
    await Promise.race([
      reader.read(), 
      timeoutPromise,
    ]);
    reader.releaseLock();

    return Math.max(1, Math.round(performance.now() - start));
  } catch (_) {
    return null;
  } finally {
    try { socket?.close(); } catch (_) { }
  }
}

/**
 * Constructs a minimal TLS 1.2 ClientHello with a given SNI hostname.
 * Allows passing raw IP strings which many SNI proxies blindly accept.
 */
function buildTlsClientHello(sniHostname: string): Uint8Array {
  const sni = new TextEncoder().encode(sniHostname);

  // SNI extension body: listLen(2) + nameType(1) + nameLen(2) + name
  const sniExtBody = new Uint8Array(2 + 1 + 2 + sni.length);
  const dv = new DataView(sniExtBody.buffer);
  dv.setUint16(0, 1 + 2 + sni.length);
  sniExtBody[2] = 0x00;
  dv.setUint16(3, sni.length);
  sniExtBody.set(sni, 5);

  const sniExt = new Uint8Array(4 + sniExtBody.length);
  const dvExt = new DataView(sniExt.buffer);
  dvExt.setUint16(0, 0x0000);
  dvExt.setUint16(2, sniExtBody.length);
  sniExt.set(sniExtBody, 4);

  const random = crypto.getRandomValues(new Uint8Array(32));
  const hello = new Uint8Array([
    0x03, 0x03,
    ...random,
    0x00,
    0x00, 0x02,
    0x00, 0x2F,
    0x01, 0x00,
    ...u16be(2 + sniExt.length),
    ...u16be(0x0000), ...u16be(sniExtBody.length), ...sniExtBody,
  ]);

  const handshake = new Uint8Array(1 + 3 + hello.length);
  handshake[0] = 0x01;
  handshake[1] = 0x00;
  handshake[2] = (hello.length >> 8) & 0xff;
  handshake[3] = hello.length & 0xff;
  handshake.set(hello, 4);

  const record = new Uint8Array(5 + handshake.length);
  record[0] = 0x16;
  record[1] = 0x03; record[2] = 0x01;
  record[3] = (handshake.length >> 8) & 0xff;
  record[4] = handshake.length & 0xff;
  record.set(handshake, 5);
  return record;
}

function u16be(n: number): [number, number] {
  return [(n >> 8) & 0xff, n & 0xff];
}
