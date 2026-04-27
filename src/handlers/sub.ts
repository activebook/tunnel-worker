// ── Custom Subscription Engine ───────────────────────────────────────────────
// Evaluates the active UUID and the decentralized Preferred IP array.
// Synthesizes a Base64-encoded block formatted identically to standard proxy requirements.

import type { Env } from '../types';
import { getUuid, getPreferredIps, getSettings } from '../lib/kv';

const HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];

const FORMAL_PATHS = [
  // Static asset delivery (CDN-style)
  '/assets/bundle.min.js',
  '/static/js/app.js',
  '/assets/v2/chunk-vendors.js',
  '/static/media/main.bundle.js',
  '/cdn/fonts/inter-var.woff2',
  '/dist/css/app.2d4f1c.css',
  // API endpoints (SPA-style)
  '/api/v1/stream',
  '/api/v2/events/stream',
  '/api/v1/notifications/live',
  '/graphql/subscriptions',
  '/api/realtime/feed',
  // Cloudflare/edge convention (your existing /cdn-cgi/trace is good)
  '/cdn-cgi/rum',
  '/cdn-cgi/trace',
  '/cdn-cgi/beacon/expect-ct',
  // Media/upload flows
  '/upload/chunk/progress',
  '/media/hls/live.m3u8',
  '/stream/video/manifest'
];

/**
 * Orchestrates the /sub request flow.
 * Validates the administrative token before generating the subscription payload.
 */
export async function handleSub(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const format = url.searchParams.get('format') || 'plain';

  const uuid = await getUuid(env);

  if (!uuid) {
    return new Response('Configuration Matrix Offline (UUID absent)', { status: 503 });
  }

  // Two-Tier Auth: The proxy UUID doubles as the carrier token for the subscription endpoint.
  // The root ADMIN_TOKEN is structurally isolated from this interface.
  if (token !== uuid) {
    console.warn('[SUB] 403: Invalid carrier identity');
    return new Response('403 Forbidden', { status: 403 });
  }

  return renderSubscription(env, url.hostname, uuid, format);
}


export async function renderSubscription(env: Env, host: string, uuid: string, format: string = 'plain'): Promise<Response> {
  const [optimizedIps, settings] = await Promise.all([
    getPreferredIps(env),
    getSettings(env)
  ]);

  // Defensive paradigm: If the crawler has never successfully invoked the KV store,
  // structurally fallback to the fundamental domain resolution to preserve uptime.
  const finalNodes = optimizedIps.length === 0 ? [{ ip: host, latency: 0 }] : optimizedIps;

  // Compute the stealth path based on edge configuration matrix.
  let wsPath = '/';
  if (settings.useFormalPaths) {
    wsPath = FORMAL_PATHS[Math.floor(Math.random() * FORMAL_PATHS.length)];
  }
  if (settings.enableEarlyData) {
    /**
     * 2048 bytes of raw data → ~2731 bytes in the header ✅ safe everywhere
     * 2560 bytes of raw data → ~3413 bytes in the header ✅ still safe on Cloudflare
     * 4096 bytes of raw data → ~5461 bytes in the header ❌ likely to be rejected by Cloudflare or some Nginx configs
     */
    // 2560 is the safe value for early data in the WebSocket handshake (4096 bytes limit)
    wsPath += wsPath.includes('?') ? '&ed=2560' : '?ed=2560';
  }

  const vlessUris = finalNodes.map(node => {
    const ipStr = typeof node === 'string' ? node : node.ip;

    // Probe-evasion cryptographic parameters engineered for secure transport.
    const params = new URLSearchParams({
      encryption: 'none',
      security: 'tls',
      sni: host,
      fp: 'chrome',
      type: 'ws',
      host: host,
      path: wsPath,
    });

    const randomPort = HTTPS_PORTS[Math.floor(Math.random() * HTTPS_PORTS.length)];
    // Explicit Node Labeling syntax enables granular proxy selection in UI Clients
    return `vless://${uuid}@${ipStr}:${randomPort}?${params.toString()}#Tunnel-${ipStr}`;
  });

  // Default to plain text links; Base64 is only applied if explicitly requested
  // for legacy compatibility with specific network aggregators.
  const payloadStr = vlessUris.join('\n');
  const finalPayload = format === 'base64' ? btoa(payloadStr) : payloadStr;

  return new Response(finalPayload, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Profile-Update-Interval': '24', // Advises the client to fetch dynamically every 24hrs
      'Subscription-Userinfo': 'upload=0; download=0; total=1073741824000; expire=0'
    }
  });
}
