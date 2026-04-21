// ── Entry point — thin request router ───────────────────────────────────────
//
// Responsibilities:
//   1. Route /admin/* requests to the administrative portal (admin.ts)
//   2. Upgrade WebSocket connections and delegate to the proxy tunnel (proxy.ts)
//   3. Handle plain HTTP health-check and info paths

import { handleProxy } from './proxy';
import { renderAdminUI } from './admin';

export interface Env {
  RELAY: KVNamespace;
  ADMIN_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ── /admin/* — authentication-gated configuration portal ────────────────
    if (url.pathname.startsWith('/admin')) {
      const token = url.searchParams.get('token');

      if (token !== env.ADMIN_TOKEN) {
        return new Response('403 Forbidden', { status: 403 });
      }

      // GET /admin/api — return current UUID from KV for the UI to display
      if (request.method === 'GET' && url.pathname === '/admin/api') {
        const uuid = await env.RELAY.get('UUID') ?? '';
        return Response.json({ uuid });
      }

      // POST /admin/api — persist a new UUID sent by the UI
      if (request.method === 'POST' && url.pathname === '/admin/api') {
        try {
          const { uuid } = await request.json() as { uuid?: string };
          // Basic RFC-4122 format guard before writing
          if (typeof uuid === 'string' && /^[0-9a-f-]{32,36}$/i.test(uuid)) {
            await env.RELAY.put('UUID', uuid);
            return new Response('OK', { status: 200 });
          }
        } catch (_) { }
        return new Response('Bad Request', { status: 400 });
      }

      // GET /admin — serve the portal HTML
      return new Response(renderAdminUI(token), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // ── Plain HTTP — health check or identity page ───────────────────────────
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      if (url.pathname === '/generate_204') return new Response(null, { status: 204 });
      return new Response(`Edge Worker Active\nNode: ${url.hostname}`, { status: 200 });
    }

    // ── WebSocket upgrade ────────────────────────────────────────────────────
    // Fetch the active UUID from KV before upgrading. Sub-10 ms on the edge;
    // doing it here keeps the proxy module stateless and purely functional.
    const expectedUuid = await env.RELAY.get('UUID') ?? '';
    if (!expectedUuid) {
      // KV not yet seeded — reject the connection gracefully
      return new Response('Service Unavailable: not configured', { status: 503 });
    }

    // allowHalfOpen: true — prevents the runtime from auto-replying to Close
    // frames so we can coordinate both sides of the tunnel ourselves.
    const { 0: client, 1: webSocket } = new WebSocketPair();
    webSocket.accept({ allowHalfOpen: true });

    handleProxy(webSocket, ctx, expectedUuid);

    // Returning 101 immediately hands the TCP connection over to the WebSocket
    // protocol. The proxy pipeline runs independently via the registered event
    // listeners and is kept alive by ctx.waitUntil inside handleProxy.
    return new Response(null, { status: 101, webSocket: client });
  },
};