import { connect } from 'cloudflare:sockets';

export interface Env {
  UUID: string;
}

// ── Module-level constants (computed once, not per-request) ─────────────────

function stringifyUuid(uuidBytes: Uint8Array): string {
  const hex = Array.from(uuidBytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const HEALTH_CHECK_HOSTS = new Set([
  'www.gstatic.com',
  'cp.cloudflare.com',
  'connectivitycheck.gstatic.com',
  'detectportal.firefox.com',
]);

// Pre-encoded once — avoids TextEncoder allocation on every health check hit
const FAKE_204 = new TextEncoder().encode(
  'HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
);

// ── Worker entry point ──────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {

    // ── Plain HTTP: health check or info page ───────────────────────────────
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      const { pathname, hostname } = new URL(request.url);
      if (pathname === '/generate_204') return new Response(null, { status: 204 });
      return new Response(`Relay Worker Active\nEdge Node: ${hostname}`, { status: 200 });
    }

    // ── WebSocket upgrade ───────────────────────────────────────────────────
    const { 0: client, 1: webSocket } = new WebSocketPair();

    // allowHalfOpen: true — prevents the runtime from auto-replying to Close
    // frames so we can coordinate both sides of the tunnel ourselves.
    webSocket.accept({ allowHalfOpen: true });

    // Per-connection mutable state
    let tcpSocket: Socket | null = null;
    let tcpWriter: WritableStreamDefaultWriter | null = null;
    let remoteConnectionReady = false;
    let queuedChunks: Uint8Array[] = [];

    // Consolidated cleanup — safe to call multiple times (all try/catch)
    function cleanup() {
      try { tcpWriter?.releaseLock(); } catch (_) { }
      try { tcpSocket?.close(); } catch (_) { }
    }

    // ── WebSocket message handler ───────────────────────────────────────────
    webSocket.addEventListener('message', async (event: MessageEvent) => {
      const rawData = event.data as ArrayBuffer;

      // ── First message: VLESS handshake ─────────────────────────────────
      if (!remoteConnectionReady && !tcpSocket) {
        const data = new Uint8Array(rawData);

        if (data.byteLength < 18) {
          webSocket.close(1003, 'Payload too short');
          return;
        }

        // Version byte + UUID (bytes 1–16)
        const version = data[0];
        const uuid = stringifyUuid(data.slice(1, 17));

        if (uuid !== env.UUID) {
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
        const initialPayload = data.slice(offset);

        // ── Health check intercept ────────────────────────────────────────
        // Respond with a local fake 204 instead of opening a TCP connection
        // to gstatic.com — eliminates the egress round-trip that was causing
        // Clash health checks to time out intermittently.
        if (port === 80 && HEALTH_CHECK_HOSTS.has(address)) {
          webSocket.send(new Uint8Array([version, 0])); // VLESS response header
          webSocket.send(FAKE_204);                     // fake HTTP 204
          webSocket.close(1000, 'Health check OK');
          return;
        }

        // ── TCP proxying ──────────────────────────────────────────────────
        try {
          tcpSocket = connect({ hostname: address, port });
          tcpWriter = tcpSocket.writable.getWriter();
          remoteConnectionReady = true; // set synchronously before any await

          // Send VLESS response header to unblock the client
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

        // ── Subsequent messages: duplex data ─────────────────────────────────
      } else if (remoteConnectionReady && tcpWriter) {
        try {
          await tcpWriter.write(new Uint8Array(rawData));
        } catch (_) {
          cleanup();
          webSocket.close(1011, 'Write failed');
        }

        // ── TCP not ready yet: buffer the chunk ──────────────────────────────
      } else {
        queuedChunks.push(new Uint8Array(rawData));
      }
    });

    // ── WebSocket closed by client ──────────────────────────────────────────
    webSocket.addEventListener('close', (event) => {
      cleanup();
      // Complete the WS close handshake (required on compat dates < 2026-04-07)
      try { webSocket.close(event.code || 1000, event.reason || ''); } catch (_) { }
    });

    // ── WebSocket error ─────────────────────────────────────────────────────
    webSocket.addEventListener('error', () => cleanup());

    return new Response(null, { status: 101, webSocket: client });
  },
};