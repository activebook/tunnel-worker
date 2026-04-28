// ── Custom Subscription Engine ────────────────────────────────────────────────

import type { Env } from '../types';
import { getUuid, getPreferredIps, getSettings, type Settings } from '../lib/kv';

// ── Constants ─────────────────────────────────────────────────────────────────

const HTTPS_PORTS = [443, 2053, 2083, 2087, 2096, 8443] as const;

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
  '/stream/video/manifest',
] as const;

const CLASH_TEMPLATE_URL =
  'https://raw.githubusercontent.com/activebook/tunnel-worker/main/template/clash.yaml';

/**
 * 2560 raw bytes → ~3413 header bytes: safe within Cloudflare's limit.
 * 4096 raw bytes → ~5461 header bytes: risks rejection by Cloudflare / Nginx.
 */
const EARLY_DATA_SIZE = 2560;

// ── Types ─────────────────────────────────────────────────────────────────────

interface IpNode {
  ip: string;
  latency: number;
}

/** All randomized, per-node values resolved in one place. */
interface ResolvedNode {
  ip: string;
  port: number;
  wsPath: string;
}

// ── Entry point ───────────────────────────────────────────────────────────────

/**
 * Orchestrates the /sub request flow.
 * Validates the administrative token before generating the subscription payload.
 * The proxy UUID doubles as the carrier token — the root ADMIN_TOKEN is
 * structurally isolated from this interface.
 */
export async function handleSub(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const format = url.searchParams.get('format') ?? 'plain';

  const uuid = await getUuid(env);
  if (!uuid) {
    return new Response('Configuration Matrix Offline (UUID absent)', { status: 503 });
  }

  if (token !== uuid) {
    console.warn('[SUB] 403: Invalid carrier identity');
    return new Response('403 Forbidden', { status: 403 });
  }

  return renderSubscription(env, url.hostname, uuid, format);
}

// ── Core renderer ─────────────────────────────────────────────────────────────

export async function renderSubscription(
  env: Env,
  host: string,
  uuid: string,
  format: string = 'plain',
): Promise<Response> {
  const [optimizedIps, settings] = await Promise.all([
    getPreferredIps(env),
    getSettings(env),
  ]);

  // Fallback to the fundamental domain if the IP crawler has never populated KV.
  const rawNodes: IpNode[] =
    optimizedIps.length > 0 ? optimizedIps : [{ ip: host, latency: 0 }];

  // ── Resolve per-node config (single source of truth for randomization) ──────
  const nodes: ResolvedNode[] = rawNodes.map(node => ({
    ip: typeof node === 'string' ? node : node.ip,
    port: pickRandom(HTTPS_PORTS),
    wsPath: buildWsPath(settings),
  }));

  return format === 'clash'
    ? renderClashYaml(nodes, uuid, host, settings)
    : renderPlain(nodes, uuid, host, format, settings);
}

// ── Format renderers ──────────────────────────────────────────────────────────

function renderPlain(
  nodes: ResolvedNode[],
  uuid: string,
  host: string,
  format: string,
  settings: Settings,
): Response {
  const uris = nodes.map(node => buildVlessUri(node, uuid, host, settings));
  const payload = uris.join('\n');

  return new Response(format === 'base64' ? btoa(payload) : payload, {
    status: 200,
    headers: subscriptionHeaders('text/plain; charset=utf-8'),
  });
}

let cachedClashTemplate: string | null = null;

async function renderClashYaml(
  nodes: ResolvedNode[],
  uuid: string,
  host: string,
  settings: Settings,
): Promise<Response> {
  const template = await fetchClashTemplate();
  if (!template) {
    return new Response('Remote configuration template unreachable', { status: 502 });
  }

  const proxies = nodes.map(node => buildClashProxy(node, uuid, host, settings));
  const proxyNames = nodes.map(({ ip }) => `      - Tunnel-${ip}`);

  let yaml = template
    .replace('{PROXIES}', proxies.join('\n'))
    .replace(/{PROXY_NAMES}/g, proxyNames.join('\n'));

  // If both Auto TUN Mode and Gaming Mode are disabled, strip the entire tun: section from the YAML.
  // it matches tun: followed by any number of indented lines, and stops naturally at the next non-indented line (i.e., any other top-level key).
  if (!settings.autoTunMode && !settings.gamingMode) {
    yaml = yaml.replace(/^tun:\n(?:[ \t]+.*\n)*/m, '');
  }

  return new Response(yaml, {
    status: 200,
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename=tunnel.yaml',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}

// ── Node builders ─────────────────────────────────────────────────────────────

/** Builds a VLESS URI for plain/base64 output. */
function buildVlessUri(node: ResolvedNode, uuid: string, host: string, settings: Settings): string {
  const params = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    sni: host,
    fp: 'chrome',
    type: 'ws',
    host,
    path: node.wsPath,
  });
  if (settings.enableEch) {
    params.set('ech', 'cloudflare-ech.com');
    params.set('allowInsecure', '0');
  } else {
    params.set('allowInsecure', '1');
  }
  return `vless://${uuid}@${node.ip}:${node.port}?${params}#Tunnel-${node.ip}`;
}

/** Builds a Clash YAML proxy block. */
function buildClashProxy(node: ResolvedNode, uuid: string, host: string, settings: Settings): string {
  /**
   * !!undefined  → false
   * !!null       → false
   * !!0          → false
   * !!""         → false
   * !!"on"       → true
   * !!1          → true
   * !!true       → true
   */
  const lines = [
    `  - name: Tunnel-${node.ip}`,
    `    type: vless`,
    `    server: ${node.ip}`,
    `    port: ${node.port}`,
    `    uuid: ${uuid}`,
    `    udp: ${!!settings.gamingMode}`, // The !! ensures you always get a proper true or false string.
    `    tls: true`,
    `    sni: ${host}`,
    `    skip-cert-verify: ${!settings.enableEch}`,
  ];

  if (settings.enableEch) {
    lines.push(`    ech-opts:`);
    lines.push(`      enable: true`);
    lines.push(`      query-server-name: cloudflare-ech.com`);
  }

  lines.push(
    `    network: ws`,
    `    ws-opts:`,
    `      path: ${node.wsPath}`,
    `      headers:`,
    `        Host: ${host}`,
  );

  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildWsPath(settings: { useFormalPaths?: boolean; enableEarlyData?: boolean }): string {
  const base = settings.useFormalPaths ? pickRandom(FORMAL_PATHS) : '/';
  if (!settings.enableEarlyData) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}ed=${EARLY_DATA_SIZE}`;
}

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function subscriptionHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Profile-Update-Interval': '24',
    'Subscription-Userinfo': 'upload=0; download=0; total=1073741824000; expire=0',
  };
}

async function fetchClashTemplate(): Promise<string | null> {
  if (cachedClashTemplate) return cachedClashTemplate;
  try {
    const res = await fetch(CLASH_TEMPLATE_URL);
    if (res.ok) cachedClashTemplate = await res.text();
  } catch (e) {
    console.error('[SUB] Failed to fetch remote Clash template:', e);
  }
  return cachedClashTemplate;
}