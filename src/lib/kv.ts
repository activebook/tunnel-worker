// ── KV abstraction layer ─────────────────────────────────────────────────────
//
// Wraps all Cloudflare KV operations behind a clean API so that the rest of the
// codebase never hard-codes key strings or calls env.TUNNEL directly.
// Swap the implementation here (e.g. to D1 or R2) without touching any handler.

import type { Env, PreferredIP, ReverseProxyIP } from '../types';

// The KV key under which the active connection token is stored.
const ADMIN_TOKEN_KEY = 'ADMIN_TOKEN';

/**
 * Reads the admin token from KV. Returns null if not yet bootstrapped.
 */
export async function getAdminToken(env: Env): Promise<string | null> {
  return env.TUNNEL.get(ADMIN_TOKEN_KEY);
}

/**
 * Persists a newly generated admin token to KV.
 * Called exactly once during the first-ever visit to /admin.
 */
export async function putAdminToken(env: Env, token: string): Promise<void> {
  await env.TUNNEL.put(ADMIN_TOKEN_KEY, token);
}

// The KV key under which the active connection token is stored.
const UUID_KEY = 'UUID';

/**
 * Reads the active connection token from the TUNNEL KV namespace.
 * Returns an empty string if the key has not yet been seeded.
 */
export async function getUuid(env: Env): Promise<string> {
  return (await env.TUNNEL.get(UUID_KEY)) ?? '';
}

/**
 * Persists a new connection token to the TUNNEL KV namespace.
 * The value propagates globally across Cloudflare's edge within seconds.
 */
export async function putUuid(env: Env, uuid: string): Promise<void> {
  await env.TUNNEL.put(UUID_KEY, uuid);
}

// The KV key under which the active preferred ip array is stored.
const PREFERRED_IPS_KEY = 'PREFERRED_IPS';

/**
 * Retrieves the aggregated array of optimized Cloudflare IPv4 nodes.
 * Automatically engineered to handle empty cache states natively.
 */
export async function getPreferredIps(env: Env): Promise<PreferredIP[]> {
  const data = await env.TUNNEL.get(PREFERRED_IPS_KEY);
  if (!data) return [];
  try {
    const parsed = JSON.parse(data);
    return parsed as PreferredIP[];
  } catch (_) {
    return [];
  }
}

/**
 * Persists the aggregated Preferred IP array to Cloudflare KV.
 */
export async function putPreferredIps(env: Env, ips: PreferredIP[]): Promise<void> {
  await env.TUNNEL.put(PREFERRED_IPS_KEY, JSON.stringify(ips));
}

// The KV key under which the active reverse proxy ip array is stored.
const REVERSE_PROXY_IPS_KEY = 'REVERSE_PROXY_IPS';

/**
 * Retrieves the aggregated array of optimized Cloudflare Reverse Proxy IPs.
 * Automatically engineered to handle empty cache states natively.
 */
export async function getReverseProxyIps(env: Env): Promise<ReverseProxyIP[]> {
  const data = await env.TUNNEL.get(REVERSE_PROXY_IPS_KEY);
  if (!data) return [];
  try {
    const parsed = JSON.parse(data);
    return parsed as ReverseProxyIP[];
  } catch (_) {
    return [];
  }
}

/**
 * Persists the aggregated Reverse Proxy IP array to Cloudflare KV.
 */
export async function putReverseProxyIps(env: Env, ips: ReverseProxyIP[]): Promise<void> {
  await env.TUNNEL.put(REVERSE_PROXY_IPS_KEY, JSON.stringify(ips));
}

// The KV key under which the active settings object is stored.
const SETTINGS_KEY = 'SETTINGS_V1';

export type RoutingPolicy = 'AUTO' | 'BRIDGE' | 'DIRECT';

export interface Settings {
  routingPolicy: RoutingPolicy;
  enableEarlyData: boolean;
  useFormalPaths: boolean;
  enableEch: boolean;
  autoTunMode: boolean;
  gamingMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  routingPolicy: 'AUTO',
  enableEarlyData: false,
  useFormalPaths: false,
  enableEch: false,
  autoTunMode: false,
  gamingMode: false
};

/**
 * Retrieves the consolidated settings object from KV.
 * Merges with DEFAULT_SETTINGS to ensure backward compatibility for new keys.
 */
export async function getSettings(env: Env): Promise<Settings> {
  const data = await env.TUNNEL.get(SETTINGS_KEY);
  if (!data) {
    return DEFAULT_SETTINGS;
  }
  try {
    const parsed = JSON.parse(data);
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch (_) {
    return DEFAULT_SETTINGS;
  }
}

/**
 * Persists the consolidated Settings to KV.
 */
export async function putSettings(env: Env, updates: Partial<Settings>): Promise<void> {
  const current = await getSettings(env);
  const updated = { ...current, ...updates };
  await env.TUNNEL.put(SETTINGS_KEY, JSON.stringify(updated));
}

// The KV key under which the telemetry auth is stored.
const TELEMETRY_AUTH_KEY = 'TELEMETRY_AUTH';

// The TelemetryAuth interface.
export interface TelemetryAuth {
  accountId: string;
  apiToken: string;
}

/**
 * Retrieves the Cloudflare API credentials for querying Analytics Engine/Usage Data.
 */
export async function getTelemetryAuth(env: Env): Promise<TelemetryAuth | null> {
  const data = await env.TUNNEL.get(TELEMETRY_AUTH_KEY);
  if (!data) return null;
  try {
    return JSON.parse(data) as TelemetryAuth;
  } catch (_) {
    return null;
  }
}

/**
 * Persists Cloudflare API credentials for the Telemetry Dashboard.
 */
export async function putTelemetryAuth(env: Env, auth: TelemetryAuth): Promise<void> {
  await env.TUNNEL.put(TELEMETRY_AUTH_KEY, JSON.stringify(auth));
}