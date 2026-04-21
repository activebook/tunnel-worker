// // ── Entry point — thin request router ───────────────────────────────────────
// //
// // Responsibilities:
// //   1. Route /admin/* requests to the administrative portal (handlers/admin.ts)
// //   2. Upgrade WebSocket connections and delegate to the proxy tunnel (handlers/proxy.ts)
// //   3. Handle plain HTTP health-check and info paths

// import type { Env } from './types';
// import { handleProxy }  from './handlers/proxy';
// import { renderAdminUI } from './handlers/admin';
// import { renderSubscription } from './handlers/sub';
// import { aggregatePreferredIps } from './lib/crawler';
// import { getUuid, putUuid } from './lib/kv';

// export default {
//   async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
//     const url = new URL(request.url);
//     const { method, headers } = request;
//     const upgradeHeader = headers.get('Upgrade') ?? '';

//     // Top-level diagnostic — emitted for every incoming request to wrangler tail
//     console.log(`[ROUTER] ${method} ${url.pathname} upgrade=${upgradeHeader}`);

//     try {
//       // ── /admin/* — authentication-gated configuration portal ────────────────
//       if (url.pathname.startsWith('/admin')) {
//         console.log('[ROUTER] → admin branch');
//         const token = url.searchParams.get('token');

//         if (token !== env.ADMIN_TOKEN) {
//           console.warn('[ADMIN] 403: token mismatch');
//           return new Response('403 Forbidden', { status: 403 });
//         }

//         // GET /admin/api — return current UUID from KV for the UI to display
//         if (method === 'GET' && url.pathname === '/admin/api') {
//           console.log('[ADMIN] GET /admin/api — reading UUID from KV');
//           const uuid = await getUuid(env);
//           return Response.json({ uuid });
//         }

//         // POST /admin/api — persist a new UUID sent by the UI
//         if (method === 'POST' && url.pathname === '/admin/api') {
//           console.log('[ADMIN] POST /admin/api — persisting UUID');
//           try {
//             const { uuid } = await request.json() as { uuid?: string };
//             // Basic RFC-4122 format guard before writing
//             if (typeof uuid === 'string' && /^[0-9a-f-]{32,36}$/i.test(uuid)) {
//               await putUuid(env, uuid);
//               console.log('[ADMIN] UUID persisted OK');
//               return new Response('OK', { status: 200 });
//             }
//             console.warn('[ADMIN] UUID failed format validation');
//           } catch (e) {
//             console.error('[ADMIN] Failed to parse request body:', e);
//           }
//           return new Response('Bad Request', { status: 400 });
//         }

//         // POST /admin/api/sync — autonomous crawler trigger
//         if (method === 'POST' && url.pathname === '/admin/api/sync') {
//           console.log('[ADMIN] POST /admin/api/sync — starting IP crawler');
//           const count = await aggregatePreferredIps(env);
//           console.log(`[CRAWLER] Completed: ${count} IPs written to KV`);
//           if (count > 0) {
//             return new Response(JSON.stringify({ status: 'ok', count }), { status: 200 });
//           }
//           return new Response('Sync Failed — Upstreams Offline', { status: 502 });
//         }

//         // GET /admin — serve the portal HTML; hostname is threaded through so the
//         // subscription URI is assembled correctly for whichever domain is in use.
//         console.log('[ADMIN] GET /admin — rendering portal HTML');
//         return new Response(renderAdminUI(token, url.hostname), {
//           headers: { 'Content-Type': 'text/html; charset=utf-8' },
//         });
//       }

//       // ── /sub — Base64 encoded proxy topology subscription ────────────────────
//       if (url.pathname.startsWith('/sub')) {
//         console.log('[ROUTER] → sub branch');
//         const token = url.searchParams.get('token');
//         if (token !== env.ADMIN_TOKEN) {
//           console.warn('[SUB] 403: token mismatch');
//           return new Response('403 Forbidden', { status: 403 });
//         }
//         return renderSubscription(env, url.hostname);
//       }

//       // ── Plain HTTP — health check or identity page ───────────────────────────
//       if (!upgradeHeader || upgradeHeader !== 'websocket') {
//         console.log('[ROUTER] → plain HTTP branch');
//         if (url.pathname === '/generate_204') return new Response(null, { status: 204 });
//         return new Response(`Edge Worker Active\nNode: ${url.hostname}`, { status: 200 });
//       }

//       // ── WebSocket upgrade ────────────────────────────────────────────────────
//       // Fetch the active UUID from KV before upgrading. Sub-10 ms on the edge;
//       // doing it here keeps the proxy module stateless and purely functional.
//       console.log('[ROUTER] → WebSocket upgrade branch');
//       const expectedUuid = await getUuid(env);
//       if (!expectedUuid) {
//         // KV not yet seeded — reject the connection gracefully
//         console.warn('[PROXY] No UUID in KV — rejecting WS upgrade with 503');
//         return new Response('Service Unavailable: not configured', { status: 503 });
//       }

//       const { 0: client, 1: webSocket } = new WebSocketPair();

//       // half open state
//       webSocket.accept({ allowHalfOpen: true });
//       console.log('[PROXY] WebSocket accepted, handing off to tunnel handler');

//       handleProxy(webSocket, ctx, expectedUuid);

//       // Returning 101 immediately hands the TCP connection over to the WebSocket
//       // protocol. The proxy pipeline runs independently via the registered event
//       // listeners and is kept alive by ctx.waitUntil inside handleProxy.
//       return new Response(null, { status: 101, webSocket: client });

//     } catch (err) {
//       // Catch-all: surface the full stacktrace to wrangler tail / CF dashboard
//       console.error('[ROUTER] Unhandled exception:', err);
//       return new Response('Internal Server Error', { status: 500 });
//     }
//   },
// };