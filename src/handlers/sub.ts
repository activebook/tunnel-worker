// ── Custom Subscription Engine ───────────────────────────────────────────────
// Evaluates the active UUID and the decentralized Preferred IP array.
// Synthesizes a Base64-encoded block formatted identically to Clash/V2rayN requirements.

import type { Env } from '../types';
import { getUuid, getPreferredIps } from '../lib/kv';

/**
 * Orchestrates the /sub request flow.
 * Validates the administrative token before generating the subscription payload.
 */
export async function handleSub(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  if (token !== env.ADMIN_TOKEN) {
    console.warn('[SUB] 403: token mismatch');
    return new Response('403 Forbidden', { status: 403 });
  }

  return renderSubscription(env, url.hostname);
}


export async function renderSubscription(env: Env, host: string): Promise<Response> {
  const uuid = await getUuid(env);

  if (!uuid) {
    return new Response('Configuration Matrix Offline (UUID absent)', { status: 503 });
  }

  let optimizedIps = await getPreferredIps(env);

  // Defensive paradigm: If the crawler has never successfully invoked the KV store,
  // structurally fallback to the fundamental domain resolution to preserve uptime.
  if (optimizedIps.length === 0) {
    optimizedIps = [host];
  }

  const HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443];

  const vlessUris = optimizedIps.map(ip => {
    // Probe-evasion cryptographic parameters engineered for VLESS-WS
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
    return `vless://${uuid}@${ip}:${randomPort}?${params.toString()}#Tunnel-${ip}`;
  });

  // Base64 encoding transforms the uncompressed multiline payload into
  // the universally accepted monolithic scalar format.
  const payloadStr = vlessUris.join('\n');
  const base64Encoded = btoa(payloadStr);

  return new Response(base64Encoded, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Profile-Update-Interval': '24', // Advises the client to fetch dynamically every 24hrs
      'Subscription-Userinfo': 'upload=0; download=0; total=1073741824000; expire=0'
    }
  });
}
