// ── KV abstraction layer ─────────────────────────────────────────────────────
//
// Wraps all Cloudflare KV operations behind a clean API so that the rest of the
// codebase never hard-codes key strings or calls env.RELAY directly.
// Swap the implementation here (e.g. to D1 or R2) without touching any handler.

import type { Env } from '../types';

// The KV key under which the active connection token is stored.
const UUID_KEY = 'UUID';
const PREFERRED_IPS_KEY = 'PREFERRED_IPS';

/**
 * Reads the active connection token from the RELAY KV namespace.
 * Returns an empty string if the key has not yet been seeded.
 */
export async function getUuid(env: Env): Promise<string> {
  return (await env.RELAY.get(UUID_KEY)) ?? '';
}

/**
 * Persists a new connection token to the RELAY KV namespace.
 * The value propagates globally across Cloudflare's edge within seconds.
 */
export async function putUuid(env: Env, uuid: string): Promise<void> {
  await env.RELAY.put(UUID_KEY, uuid);
}

/**
 * Retrieves the aggregated array of optimized Cloudflare IPv4 nodes.
 * Automatically engineered to handle empty cache states natively.
 */
export async function getPreferredIps(env: Env): Promise<string[]> {
  const data = await env.RELAY.get(PREFERRED_IPS_KEY);
  if (!data) return [];
  try {
    return JSON.parse(data) as string[];
  } catch (_) {
    return [];
  }
}

/**
 * Persists the aggregated Preferred IP array to Cloudflare KV.
 */
export async function putPreferredIps(env: Env, ips: string[]): Promise<void> {
  await env.RELAY.put(PREFERRED_IPS_KEY, JSON.stringify(ips));
}


