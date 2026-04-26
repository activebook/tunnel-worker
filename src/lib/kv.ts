// ── KV abstraction layer ─────────────────────────────────────────────────────
//
// Wraps all Cloudflare KV operations behind a clean API so that the rest of the
// codebase never hard-codes key strings or calls env.TUNNEL directly.
// Swap the implementation here (e.g. to D1 or R2) without touching any handler.

import type { Env, PreferredIP, ReverseProxyIP } from '../types';

// The KV key under which the active connection token is stored.
const ADMIN_TOKEN_KEY = 'ADMIN_TOKEN';
const UUID_KEY = 'UUID';
const PREFERRED_IPS_KEY = 'PREFERRED_IPS';
const REVERSE_PROXY_IPS_KEY = 'REVERSE_PROXY_IPS';
const ROUTING_POLICY_KEY = 'ROUTING_POLICY';

export type RoutingPolicy = 'AUTO' | 'BRIDGE' | 'DIRECT';

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

/**
 * Reads the routing policy from KV.
 * AUTO: Try direct, fallback to bridge.
 * BRIDGE: Bridge all traffic.
 * DIRECT: Try direct, fail on error.
 */
export async function getRoutingPolicy(env: Env): Promise<RoutingPolicy> {
  const val = await env.TUNNEL.get(ROUTING_POLICY_KEY);
  if (val === 'BRIDGE' || val === 'DIRECT') return val as RoutingPolicy;
  return 'AUTO';
}

/**
 * Persists the Routing Policy to KV.
 */
export async function setRoutingPolicy(env: Env, policy: RoutingPolicy): Promise<void> {
  await env.TUNNEL.put(ROUTING_POLICY_KEY, policy);
}