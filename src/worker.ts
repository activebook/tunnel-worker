// ── Entry point — thin request router ───────────────────────────────────────
//
// Responsibilities:
//   1. Route /admin/* requests to the administrative portal (handlers/admin.ts)
//   2. Upgrade WebSocket connections and delegate to the proxy tunnel (handlers/proxy.ts)
//   3. Handle plain HTTP health-check and info paths

import type { Env } from './types';
import { handleProxy } from './handlers/proxy';
import { handleAdmin } from './handlers/admin';
import { handleServices } from './handlers/services';
import { handleSub } from './handlers/sub';
import { getUuid } from './lib/kv';
import { getCaches } from './lib/cache';
import { crawlForAll } from './lib/crawler';
import { decodeEarlyData } from './lib/utils';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { method, headers } = request;
    const upgradeHeader = headers.get('Upgrade') ?? '';

    // Top-level diagnostic — emitted for every incoming request to wrangler tail
    console.log(`[ROUTER] ${method} ${url.pathname} upgrade=${upgradeHeader}`);

    try {
      // ── /admin/* — gated admin portal (presentation) ────────────────────────
      if (url.pathname.startsWith('/admin')) {
        console.log('[ROUTER] → admin branch');
        return handleAdmin(request, env);
      }

      // ── /services/* — internal infrastructure API for admin UI ─────────────
      if (url.pathname.startsWith('/services')) {
        console.log('[ROUTER] → services branch');
        return handleServices(request, env);
      }

      // ── /sub — Base64 encoded proxy topology subscription ────────────────────
      if (url.pathname.startsWith('/sub')) {
        console.log('[ROUTER] → sub branch');
        return handleSub(request, env);
      }

      // ── Plain HTTP — health check or identity page ───────────────────────────
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        console.log('[ROUTER] → plain HTTP branch');
        if (url.pathname === '/generate_204') return new Response(null, { status: 204 });
        return new Response(`Edge Worker Active\nNode: ${url.hostname}`, { status: 200 });
      }

      // ── WebSocket upgrade ────────────────────────────────────────────────────
      // Fetch the active UUID from KV before upgrading. Sub-10 ms on the edge;
      // doing it here keeps the proxy module stateless and purely functional.
      console.log('[ROUTER] → WebSocket upgrade branch');
      const expectedUuid = await getUuid(env);
      if (!expectedUuid) {
        // KV not yet seeded — reject the connection gracefully
        console.warn('[PROXY] No UUID in KV — rejecting WS upgrade with 503');
        return new Response('Service Unavailable: not configured', { status: 503 });
      }

      // Refresh the Reverse Proxy IP cache every 5 minutes (300,000ms)
      // Retrieve the latest configuration from the caching layer
      const { reverseIps, settings } = await getCaches(env);

      const { 0: client, 1: webSocket } = new WebSocketPair();

      // half open state
      webSocket.accept({ allowHalfOpen: true });
      console.log('[PROXY] WebSocket accepted, handing off to tunnel handler');

      // Extract early data from the Sec-WebSocket-Protocol header
      const earlyDataHeader = headers.get('sec-websocket-protocol') || '';
      const earlyData = earlyDataHeader ? decodeEarlyData(earlyDataHeader) : null;

      // Handle proxy tunnel connection
      handleProxy(webSocket, ctx, expectedUuid, reverseIps, settings.routingPolicy, earlyData);

      // Return early data in Sec-WebSocket-Protocol header to allow client to send it
      const responseHeaders = new Headers();
      if (earlyDataHeader) {
        responseHeaders.set('Sec-WebSocket-Protocol', earlyDataHeader);
      }

      // Returning 101 immediately hands the TCP connection over to the WebSocket
      // protocol. The proxy pipeline runs independently via the registered event
      // listeners and is kept alive by ctx.waitUntil inside handleProxy.
      return new Response(null, { status: 101, webSocket: client, headers: responseHeaders });

    } catch (err) {
      // Catch-all: surface the full stacktrace to wrangler tail / CF dashboard
      console.error('[ROUTER] Unhandled exception:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // We wrap this in ctx.waitUntil so the worker isolate doesn't terminate prematurely
    // while the latency measurements are running against the edge IPs.
    ctx.waitUntil(crawlForAll(env));
  }
};