import type { Env, PreferredIP, ReverseProxyIP } from '../types';
import { putPreferredIps, putReverseProxyIps, getReverseProxyIps } from './kv';
import { checkHttpLatency, checkTcpLatency, checkLatencyViaProxy } from './network';

const BASE_PROXY_URL = 'https://raw.githubusercontent.com/activebook/tunnel-worker/main/proxy';

// Upstream matrix reservoirs identical to the original Node.js architecture.
const PREFERRED_IPS_SOURCES = [
  `${BASE_PROXY_URL}/cf-edge.txt`
];

// Per-country reverse proxy IP source files hosted in this repository.
// Each key matches the `region` value accepted by the sync API.
const REVERSE_PROXY_REGIONS: Record<string, string> = {
  all: `${BASE_PROXY_URL}/cf-proxy-all.txt`,
  auto: `${BASE_PROXY_URL}/cf-proxy-auto.txt`,
  hk: `${BASE_PROXY_URL}/cf-proxy-hk.txt`,
  sg: `${BASE_PROXY_URL}/cf-proxy-sg.txt`,
  jp: `${BASE_PROXY_URL}/cf-proxy-jp.txt`,
  kr: `${BASE_PROXY_URL}/cf-proxy-kr.txt`,
  us: `${BASE_PROXY_URL}/cf-proxy-us.txt`,
  ca: `${BASE_PROXY_URL}/cf-proxy-ca.txt`,
  gb: `${BASE_PROXY_URL}/cf-proxy-gb.txt`,
  de: `${BASE_PROXY_URL}/cf-proxy-de.txt`,
  fr: `${BASE_PROXY_URL}/cf-proxy-fr.txt`,
  nl: `${BASE_PROXY_URL}/cf-proxy-nl.txt`,
  se: `${BASE_PROXY_URL}/cf-proxy-se.txt`,
  fi: `${BASE_PROXY_URL}/cf-proxy-fi.txt`,
  pl: `${BASE_PROXY_URL}/cf-proxy-pl.txt`,
  ch: `${BASE_PROXY_URL}/cf-proxy-ch.txt`,
  lv: `${BASE_PROXY_URL}/cf-proxy-lv.txt`,
  ru: `${BASE_PROXY_URL}/cf-proxy-ru.txt`,
  in: `${BASE_PROXY_URL}/cf-proxy-in.txt`,
};

export async function aggregateReverseProxyIps(num: number, env: Env, region: string = 'all'): Promise<number> {
  const ipSet = new Set<string>();

  // Resolve the source URL; unknown region codes gracefully fall back to 'all'.
  const source = REVERSE_PROXY_REGIONS[region] ?? REVERSE_PROXY_REGIONS['all'];

  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(source, { signal: controller.signal });
    clearTimeout(id);
    if (!res.ok) return 0;

    const text = await res.text();
    text.split('\n').forEach(line => {
      const ip = line.trim().split(':')[0].split('#')[0].trim();
      if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
        ipSet.add(ip);
      }
    });
  } catch (_) { }


  const allIps = Array.from(ipSet);
  if (allIps.length === 0) {
    return 0; // Absolute mathematical failure; preserve existing KV cache
  }

  // O(K) Partial Fisher-Yates selection: Select exactly 10 unique nodes
  // without shuffling the entire array, saving CPU cycles on large datasets.
  const primeSubset: string[] = [];
  const needed = Math.min(num, allIps.length);
  for (let i = 0; i < needed; i++) {
    const j = i + Math.floor(Math.random() * (allIps.length - i));
    [allIps[i], allIps[j]] = [allIps[j], allIps[i]];
    primeSubset.push(allIps[i]);
  }

  // Measure latency for the selected subset
  const measuredIps: ReverseProxyIP[] = [];
  const latencyChecks = primeSubset.map(async (ip) => {
    const latency = await checkTcpLatency(ip);
    if (latency !== null) {
      measuredIps.push({ ip, latency });
    }
  });

  await Promise.allSettled(latencyChecks);

  // Sort by latency (lowest first). Handle -1 (dead nodes) by pushing them to the end.
  measuredIps.sort((a, b) => {
    if (a.latency < 0 && b.latency >= 0) return 1;
    if (b.latency < 0 && a.latency >= 0) return -1;
    return a.latency - b.latency;
  });

  if (measuredIps.length === 0 && primeSubset.length > 0) {
    // If all latency checks failed (likely due to edge networking restrictions),
    // we still want to persist the IPs to the user with a placeholder latency.
    primeSubset.forEach(ip => measuredIps.push({ ip, latency: -1 }));
  }

  // Persist directly to KV
  await putReverseProxyIps(env, measuredIps);

  return measuredIps.length;
}

/**
 * Crawls upstream Cloudflare Anycast IP repositories, deduplicates the results,
 * and returns a random subset of candidates for client-side latency measurement.
 *
 * This function is intentionally side-effect-free: it does NOT measure latency
 * and does NOT write to KV. Latency measurement must happen on the client side
 * (browser) to reflect real Client-to-Edge RTT rather than meaningless CF-to-CF RTT.
 *
 * @returns An array of raw IP strings ready to be probed by the client.
 */
export async function fetchPreferredIps(num: number): Promise<string[]> {
  const ipSet = new Set<string>();

  // Utilizing Promise.allSettled to parallelize fetches, bypassing slow upstreams
  // without sacrificing the pipeline payload if one repository stalls.
  const fetches = PREFERRED_IPS_SOURCES.map(async (source) => {
    try {
      // Create a timeout controller to prevent the Edge execution from hanging
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(source, { signal: controller.signal });
      clearTimeout(id);
      if (!res.ok) return;

      const text = await res.text();
      text.split('\n').forEach(line => {
        const ip = line.trim().split(':')[0].split('#')[0].trim();
        if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
          ipSet.add(ip);
        }
      });
    } catch (_) { }
  });

  await Promise.allSettled(fetches);

  const allIps = Array.from(ipSet);
  if (allIps.length === 0) return [];

  // O(K) Partial Fisher-Yates selection: select exactly `num` unique nodes
  // without shuffling the entire array, saving CPU cycles on large datasets.
  const needed = Math.min(num, allIps.length);
  for (let i = 0; i < needed; i++) {
    const j = i + Math.floor(Math.random() * (allIps.length - i));
    [allIps[i], allIps[j]] = [allIps[j], allIps[i]];
  }

  return allIps.slice(0, needed);
}

/**
 * Persists a client-measured, pre-sorted ranked IP list to KV.
 * The caller (admin portal browser JS) is responsible for measuring real
 * Client-to-Edge latency and submitting results sorted ascending by latency.
 *
 * @param env       - Cloudflare Worker environment bindings.
 * @param rankedIps - Validated, sorted array from the client POST body.
 */
export async function setRankedPreferredIps(env: Env, rankedIps: PreferredIP[]): Promise<void> {
  await putPreferredIps(env, rankedIps);
}

/**
 * Automates the fetching, latency measurement, and persistence of Preferred IPs
 * from the Cloudflare Worker environment. Used by the scheduled CRON job to 
 * ensure the KV store is never empty.
 */
export async function aggregatePreferredIps(num: number, env: Env): Promise<number> {
  // Fetch a larger pool to account for dead IPs
  const allIps = await fetchPreferredIps(num * 2);

  if (allIps.length === 0) {
    return 0; // Absolute mathematical failure; preserve existing KV cache
  }

  // Measure latency for the selected subset
  const measuredIps: PreferredIP[] = [];

  // Attempt to fetch a bridge proxy IP from KV. We just need one working proxy
  // to serve as the gateway for the TLS ClientHello probes.
  const reverseIps = await getReverseProxyIps(env);
  const bridgeIp = reverseIps.length > 0 ? reverseIps[0].ip : null;

  if (bridgeIp) {
    console.log(`[CRON] Bridge Proxy Selected for 2-hop RTT: ${bridgeIp}`);
  } else {
    console.log(`[CRON] No Bridge Proxy available. Falling back to 1-hop HTTP probes.`);
  }

  const latencyChecks = allIps.map(async (ip) => {
    let latency: number | null = null;

    // True 2-hop RTT via Reverse Proxy SNI routing
    if (bridgeIp) {
      latency = await checkLatencyViaProxy(bridgeIp, ip);
    }

    if (latency !== null) {
      measuredIps.push({ ip, latency });
    }
  });

  await Promise.allSettled(latencyChecks);

  // Sort by latency (lowest first). Handle -1 (dead nodes) by pushing them to the end.
  measuredIps.sort((a, b) => {
    if (a.latency < 0 && b.latency >= 0) return 1;
    if (b.latency < 0 && a.latency >= 0) return -1;
    return a.latency - b.latency;
  });

  if (measuredIps.length === 0 && allIps.length > 0) {
    // If all latency checks failed (likely due to edge networking restrictions),
    // persist with placeholder latency.
    allIps.forEach(ip => measuredIps.push({ ip, latency: -1 }));
  }

  const finalIps = measuredIps.slice(0, num);
  await putPreferredIps(env, finalIps);

  return finalIps.length;
}

/**
 * Encapsulates the CRON scheduled sync logic to keep the worker entry point clean.
 * Synchronizes both the Reverse Proxy Bridge matrix and Preferred Edge matrix concurrently.
 */
export async function crawlForAll(env: Env): Promise<void> {
  console.log('[CRON] Initiating Autonomous Matrix Maintenance');
  try {
    const [bridgeCount, preferredCount] = await Promise.all([
      aggregateReverseProxyIps(20, env, 'auto'),
      aggregatePreferredIps(20, env)
    ]);
    console.log(`[CRON] Matrix synced successfully: ${bridgeCount} bridge nodes, ${preferredCount} preferred edge nodes optimized.`);
  } catch (err) {
    console.error('[CRON] Failed to sync Matrix during scheduled maintenance:', err);
  }
}

