import type { Env } from '../types';
import { getReverseProxyIps, getSettings, type Settings, DEFAULT_SETTINGS } from './kv';

// Global isolate cache to prevent KV throttling on high-frequency WebSocket upgrades.
// These variables persist across requests within the same V8 isolate.
let cachedReverseIps: string[] | null = null;
let cachedSettings: Settings = { ...DEFAULT_SETTINGS };
let lastCacheTime = 0;

/**
 * Orchestrates the caching layer for expensive KV lookups.
 * Implementation ensures that high-frequency proxy connections do not exceed KV rate limits.
 * 
 * @param env - The Cloudflare Worker environment bindings.
 * @returns An object containing the current validated configuration matrix.
 */
export async function getCaches(env: Env): Promise<{
  reverseIps: string[] | null;
  settings: Settings;
}> {
  // Refresh the configuration cache every 5 minutes (300,000ms)
  const isExpired = Date.now() - lastCacheTime > 300000;

  if (!cachedReverseIps || isExpired) {
    console.log('[CACHE] Refreshing configuration matrix from KV');
    try {
      const [reverseObjs, settings] = await Promise.all([
        getReverseProxyIps(env),
        getSettings(env)
      ]);

      cachedReverseIps = reverseObjs.map(o => o.ip);
      cachedSettings = settings;
      lastCacheTime = Date.now();
    } catch (e) {
      console.error('[CACHE] Critical refresh failure — falling back to stale cache or empty defaults:', e);
      // If we already have a cache, keep it (stale-while-error pattern).
      // Otherwise, initialize with safe defaults to prevent runtime exceptions.
      cachedReverseIps = cachedReverseIps || [];
    }
  }

  return {
    reverseIps: cachedReverseIps,
    settings: cachedSettings
  };
}
