import { connect } from 'cloudflare:sockets';
import { stringifyUuid, HEALTH_CHECK_HOSTS, FAKE_204 } from '../lib/utils';

/**
 * Establishes the full-duplex tunnel for a single authenticated session.
 * Called only after the WebSocket upgrade handshake has been accepted.
 *
 * @param webSocket    - The server-side socket of the WebSocketPair.
 * @param ctx          - ExecutionContext used to extend isolate lifetime via waitUntil.
 * @param expectedUuid - UUID fetched from KV before the upgrade; validated on the
 *                       first message so we never touch a TCP socket for bad clients.
 */
export function handleProxy(
  webSocket: WebSocket,
  ctx: ExecutionContext,
  expectedUuid: string,
  reverseIps?: string[] | null,
  forceReverseBridge?: boolean
): void {

  // Per-connection mutable state — intentionally not shared across sessions
  let tcpSocket: Socket | null = null;
  let tcpWriter: WritableStreamDefaultWriter | null = null;
  let remoteConnectionReady = false;
  let queuedChunks: Uint8Array[] = [];

  // Consolidated cleanup — safe to call multiple times (all wrapped in try/catch)
  function cleanup() {
    try { tcpWriter?.releaseLock(); } catch (_) { }
    try { tcpSocket?.close(); } catch (_) { }
  }

  // ── WebSocket message handler ─────────────────────────────────────────────
  webSocket.addEventListener('message', async (event: MessageEvent) => {
    const rawData = event.data as ArrayBuffer;

    // ── First message: protocol handshake ─────────────────────────────────
    if (!remoteConnectionReady && !tcpSocket) {
      const data = new Uint8Array(rawData);

      // Mitigate malformed frames before touching any field offsets
      if (data.byteLength < 18) {
        webSocket.close(1003, 'Payload too short');
        return;
      }

      // Version byte + UUID (bytes 1–16)
      const version = data[0];
      const uuid = stringifyUuid(data.slice(1, 17));

      if (uuid !== expectedUuid) {
        webSocket.close(1008, 'Unauthorized');
        return;
      }

      // Optional addons (byte 17 = length, then skip that many bytes)
      const optLength = data[17];
      let offset = 18 + optLength;

      // Command: 1 = TCP (only supported), 2 = UDP (rejected)
      const command = data[offset++];
      if (command !== 1) {
        webSocket.close(1003, 'Unsupported command');
        return;
      }

      // Destination port (2 bytes, big-endian)
      const port = (data[offset++] << 8) | data[offset++];

      // Address type + address
      const addrType = data[offset++];
      let address = '';

      if (addrType === 1) {           // IPv4 — 4 bytes
        address = Array.from(data.slice(offset, offset + 4)).join('.');
        offset += 4;
      } else if (addrType === 2) {    // Domain name — 1-byte length prefix
        const domainLen = data[offset++];
        address = new TextDecoder().decode(data.slice(offset, offset + domainLen));
        offset += domainLen;
      } else if (addrType === 3) {    // IPv6 — 16 bytes
        const b = data.slice(offset, offset + 16);
        const parts: string[] = [];
        for (let i = 0; i < 16; i += 2) {
          parts.push(((b[i] << 8) | b[i + 1]).toString(16));
        }
        address = parts.join(':');
        offset += 16;
      } else {
        webSocket.close(1003, 'Unknown address type');
        return;
      }

      // Anything left in this frame is the first chunk of application data
      // The initialPayload is a raw TLS ClientHello packet.
      // It contains the SNI, which is the domain name.
      const initialPayload = data.slice(offset);

      // ── Health check intercept ──────────────────────────────────────────
      // Respond with a local synthetic 204 instead of opening a TCP connection
      // to a known connectivity-check host — eliminates the egress round-trip
      // that was causing proxy-client health checks to time out intermittently.
      if (port === 80 && HEALTH_CHECK_HOSTS.has(address)) {
        webSocket.send(new Uint8Array([version, 0])); // protocol response header
        webSocket.send(FAKE_204);                     // synthetic HTTP 204
        webSocket.close(1000, 'Health check OK');
        return;
      }

      // ── TCP proxying ────────────────────────────────────────────────────
      try {
        tcpSocket = await connectTo(address, port, reverseIps, forceReverseBridge);
        tcpWriter = tcpSocket.writable.getWriter();
        remoteConnectionReady = true; // set synchronously before any await

        // Send protocol response header to unblock the client
        webSocket.send(new Uint8Array([version, 0]));

        // Pipe TCP → WebSocket. ctx.waitUntil() keeps the worker alive for
        // the lifetime of the stream even after the HTTP response is sent.
        const pipePromise = tcpSocket.readable.pipeTo(new WritableStream({
          write(chunk) {
            try { webSocket.send(chunk); } catch (_) { }
          },
          close() {
            // Remote server closed the TCP connection — signal EOF to client
            try { webSocket.close(1000, 'TCP closed'); } catch (_) { }
          },
          abort() {
            try { webSocket.close(1011, 'TCP error'); } catch (_) { }
          },
        })).catch(() => { });

        ctx.waitUntil(pipePromise);

        // Flush initial payload + anything that arrived before TCP was ready
        if (initialPayload.byteLength > 0) await tcpWriter.write(initialPayload);
        for (const chunk of queuedChunks) await tcpWriter.write(chunk);
        queuedChunks = [];

      } catch (_) {
        cleanup();
        webSocket.close(1011, 'TCP connect failed');
      }

      // ── Subsequent messages: duplex data ──────────────────────────────────
    } else if (remoteConnectionReady && tcpWriter) {
      try {
        await tcpWriter.write(new Uint8Array(rawData));
      } catch (_) {
        cleanup();
        webSocket.close(1011, 'Write failed');
      }

      // ── TCP not ready yet: buffer the chunk ───────────────────────────────
    } else {
      queuedChunks.push(new Uint8Array(rawData));
    }
  });

  // ── WebSocket closed by client ─────────────────────────────────────────────
  webSocket.addEventListener('close', (event) => {
    cleanup();
    // Complete the WS close handshake (required on compat dates < 2026-04-07)
    try { webSocket.close(event.code || 1000, event.reason || ''); } catch (_) { }
  });

  // ── WebSocket error ────────────────────────────────────────────────────────
  webSocket.addEventListener('error', () => cleanup());
}

// Choose lowest latency IPs for reverse proxy, top-k lowest latency IPs
const LOWEST_LATENCY_CHOICE_NUM = 5;

/**
 * Orchestrates the TCP connection lifecycle, implementing the SNI-bridge fallback.
 */
async function connectTo(
  address: string,
  port: number,
  reverseIps: string[] | null | undefined,
  forceReverseBridge?: boolean
): Promise<Socket> {
  const canBridge = reverseIps && reverseIps.length > 0 && port === 443;

  if (forceReverseBridge && canBridge) {
    // Pick from top-k lowest-latency IPs for a balance of speed and redundancy
    const pool = reverseIps!.slice(0, Math.min(LOWEST_LATENCY_CHOICE_NUM, reverseIps!.length));
    const picked = pool[Math.floor(Math.random() * pool.length)];
    console.log(`[PROXY] Force Reverse Proxy Bridge active — routing ${address} via Reverse Proxy: ${picked} (pool: ${pool.join(', ')})`);
    const socket = connect({ hostname: picked, port });
    await socket.opened;
    return socket;
  }

  try {
    const socket = connect({ hostname: address, port });
    // Await opened so CF loopback rejections (which happen during handshake) are caught
    await socket.opened;
    return socket;
  } catch (directError) {
    // If direct connection fails (CF loopback block) and we have reverse IPs, bridge it
    if (canBridge) {
      const pool = reverseIps!.slice(0, Math.min(LOWEST_LATENCY_CHOICE_NUM, reverseIps!.length));
      const picked = pool[Math.floor(Math.random() * pool.length)];
      console.log(`[PROXY] Direct connect to ${address} failed. Bridging via Reverse Proxy: ${picked} (pool: ${pool.join(', ')})`);
      // The Reverse Proxy server is an SNI-aware TCP relay — reads the TLS ClientHello SNI,
      // opens the correct upstream connection, and passes all bytes through bidirectionally
      // without ever touching the encrypted payload. Since it's outside CF IP ranges,
      // it survives when direct CF IPs are blocked.
      const socket = connect({ hostname: picked, port });
      await socket.opened;
      return socket;
    }
    throw directError;
  }
}

