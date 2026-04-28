// ── Custom Subscription Engine ───────────────────────────────────────────────
// Evaluates the active UUID and the decentralized Preferred IP array.
// Synthesizes a Base64-encoded block formatted identically to standard proxy requirements.

import type { Env } from '../types';
import { getUuid, getPreferredIps, getSettings } from '../lib/kv';

const HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];

const CLASH_URL = 'https://raw.githubusercontent.com/activebook/tunnel-worker/main/template/clash.yaml';
let cachedClashTemplate: string | null = null;

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
  // Cloudflare/edge convention
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

  if (format === 'clash') {
    return await renderClashYaml(finalNodes, uuid, host, wsPath);
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

async function renderClashYaml(nodes: any[], uuid: string, host: string, wsPath: string): Promise<Response> {
  const proxies: string[] = [];
  const proxyNames: string[] = [];

  nodes.forEach((node, idx) => {
    const ipStr = typeof node === 'string' ? node : node.ip;
    const port = HTTPS_PORTS[Math.floor(Math.random() * HTTPS_PORTS.length)];
    const name = `Tunnel-${ipStr}`;

    const proxyBlock = [
      `  - name: ${name}`,
      `    type: vless`,
      `    server: ${ipStr}`,
      `    port: ${port}`,
      `    uuid: ${uuid}`,
      `    udp: true`,
      `    tls: true`,
      `    sni: ${host}`,
      `    network: ws`,
      `    ws-opts:`,
      `      path: ${wsPath}`,
      `      headers:`,
      `        Host: ${host}`
    ].join('\n');

    proxies.push(proxyBlock);
    proxyNames.push(`      - ${name}`);
  });

  let template = cachedClashTemplate;
  if (!template) {
    try {
      const res = await fetch(CLASH_URL);
      if (res.ok) {
        template = await res.text();
        cachedClashTemplate = template; // Cache for subsequent requests
      }
    } catch (e) {
      console.error('[SUB] Failed to fetch remote Clash template:', e);
    }
  }

  if (!template) {
    return new Response('Remote configuration template unreachable', { status: 502 });
  }

  const yaml = template
    .replace('{PROXIES}', proxies.join('\n'))
    .replace(/{PROXY_NAMES}/g, proxyNames.join('\n'));

  return new Response(yaml, {
    status: 200,
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename=tunnel.yaml',
      'Cache-Control': 'no-store, no-cache, must-revalidate'
    }
  });
}
