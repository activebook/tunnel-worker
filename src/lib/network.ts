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
 * Strategy: open a raw TCP socket to the proxy, fire a TLS ClientHello whose
 * SNI points at the target CF edge IP, and time until the first response byte.
 * We never complete the handshake — we only need the round-trip signal.
 *
 * @param proxyIp   Non-CF reverse proxy IP (source: KV store).
 * @param targetIp  CF Anycast edge IP to probe through the proxy.
 * @param timeoutMs Total budget for both hops (default 5 s).
 * @returns RTT in ms (≥ 1), or null if the proxy is unreachable / timed out.
 */
export async function checkLatencyViaProxy(
  proxyIp: string,
  targetIp: string,
  timeoutMs = 5000
): Promise<number | null> {
  const start = performance.now();
  let socket: Socket | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  // Single shared deadline for the entire two-hop operation.
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });

  try {
    socket = connect({ hostname: proxyIp, port: 443 });

    await Promise.race([socket.opened, timeoutPromise]);

    const writer = socket.writable.getWriter();
    try {
      await writer.write(buildTlsClientHello(targetIp));
    } finally {
      writer.releaseLock(); // must release even if write() throws
    }

    const reader = socket.readable.getReader();
    try {
      await Promise.race([reader.read(), timeoutPromise]);
    } finally {
      reader.releaseLock(); // must release even if race rejects
    }

    return Math.max(1, Math.round(performance.now() - start));
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId); // prevent dangling timer on success path
    try { socket?.close(); } catch { /* best-effort cleanup */ }
  }
}

/**
 * Constructs a minimal TLS 1.2 ClientHello containing only an SNI extension.
 * The handshake is intentionally never completed — we only need the packet
 * to provoke a response from the remote so we can measure RTT.
 *
 * Wire layout (RFC 5246 §7.4.1.2 + RFC 6066 §3):
 *   TLSPlaintext record
 *     └─ Handshake / ClientHello
 *          └─ Extensions [ server_name ]
 *               └─ ServerNameList [ host_name ]
 */
function buildTlsClientHello(sniHostname: string): Uint8Array {
  const sni = new TextEncoder().encode(sniHostname);

  // ── SNI extension_data (ServerNameList) ─────────────────────────────────
  // listLen(2) + nameType(1) + nameLen(2) + name(N)
  const sniExtData = new Uint8Array(2 + 1 + 2 + sni.length);
  const dvData = new DataView(sniExtData.buffer);
  dvData.setUint16(0, 1 + 2 + sni.length); // ServerNameList byte length
  sniExtData[2] = 0x00;                     // NameType: host_name
  dvData.setUint16(3, sni.length);           // HostName byte length
  sniExtData.set(sni, 5);                    // HostName bytes

  // ── Full SNI extension: type(2) + dataLen(2) + data ─────────────────────
  const sniExt = new Uint8Array(4 + sniExtData.length);
  const dvExt = new DataView(sniExt.buffer);
  dvExt.setUint16(0, 0x0000);              // ExtensionType: server_name
  dvExt.setUint16(2, sniExtData.length);   // extension_data length
  sniExt.set(sniExtData, 4);

  // ── ClientHello body ─────────────────────────────────────────────────────
  const random = crypto.getRandomValues(new Uint8Array(32));
  const hello = new Uint8Array([
    0x03, 0x03,           // client_version: TLS 1.2
    ...random,            // 32-byte client random
    0x00,                 // session_id length: 0 (no resumption)
    0x00, 0x02,           // cipher_suites length: 2 bytes (one suite)
    0x00, 0x2F,           // TLS_RSA_WITH_AES_128_CBC_SHA
    0x01, 0x00,           // compression_methods: [null]
    ...u16be(sniExt.length), // extensions total length  ← FIXED (was +2)
    ...sniExt,               // SNI extension             ← FIXED (was inline duplicate)
  ]);

  // ── Handshake header: msgType(1) + length(3) ────────────────────────────
  const handshake = new Uint8Array(4 + hello.length);
  handshake[0] = 0x01;                          // HandshakeType: client_hello
  handshake[1] = 0x00;
  handshake[2] = (hello.length >> 8) & 0xff;
  handshake[3] = hello.length & 0xff;
  handshake.set(hello, 4);

  // ── TLS record: contentType(1) + version(2) + length(2) + fragment ──────
  const record = new Uint8Array(5 + handshake.length);
  record[0] = 0x16;                              // ContentType: handshake
  record[1] = 0x03; record[2] = 0x01;            // record layer version: TLS 1.0 (standard)
  record[3] = (handshake.length >> 8) & 0xff;
  record[4] = handshake.length & 0xff;
  record.set(handshake, 5);

  return record;
}

function u16be(n: number): [number, number] {
  return [(n >> 8) & 0xff, n & 0xff];
}