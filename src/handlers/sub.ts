// ── Custom Subscription Engine ───────────────────────────────────────────────
// Evaluates the active UUID and the decentralized Preferred IP array.
// Synthesizes a Base64-encoded block formatted identically to standard proxy requirements.

import type { Env } from '../types';
import { getUuid, getPreferredIps, getReverseProxyIps } from '../lib/kv';

const HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];

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
  let optimizedIps = await getPreferredIps(env);

  // Defensive paradigm: If the crawler has never successfully invoked the KV store,
  // structurally fallback to the fundamental domain resolution to preserve uptime.
  if (optimizedIps.length === 0) {
    optimizedIps = [{ ip: host, latency: 0 }];
  }

  const vlessUris = optimizedIps.map(node => {
    const ipStr = typeof node === 'string' ? node : node.ip;

    // Probe-evasion cryptographic parameters engineered for secure transport.
    const params = new URLSearchParams({
      encryption: 'none',
      security: 'tls',
      sni: host,
      fp: 'chrome',
      type: 'ws',
      host: host,
      path: '/',
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
