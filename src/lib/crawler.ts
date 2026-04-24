import type { Env, PreferredIP, ReverseProxyIP } from '../types';
import { putPreferredIps, getPreferredIps, putReverseProxyIps, getReverseProxyIps } from './kv';
import { checkTcpLatency } from './network';


// Upstream matrix reservoirs identical to the original Node.js architecture.
const PREFERRED_IPS_SOURCES = [
  'https://raw.githubusercontent.com/Alvin9999-newpac/fanqiang/refs/heads/main/cloudflare%E4%BC%98%E9%80%89ip',
  'https://raw.githubusercontent.com/ymyuuu/IPDB/refs/heads/main/BestCF/bestcfv4.txt',
  'https://raw.githubusercontent.com/gslege/CloudflareIP/refs/heads/main/Cfxyz.txt'
];

// Per-country reverse proxy IP source files hosted in this repository.
// Each key matches the `region` value accepted by the sync API.
const BASE_PROXY_URL = 'https://raw.githubusercontent.com/activebook/tunnel-worker/refs/heads/main/proxy';

const REVERSE_PROXY_REGIONS: Record<string, string> = {
  all:  `${BASE_PROXY_URL}/cf-proxy-all.txt`,
  auto: `${BASE_PROXY_URL}/cf-proxy-auto.txt`,
  hk:   `${BASE_PROXY_URL}/cf-proxy-hk.txt`,
  sg:   `${BASE_PROXY_URL}/cf-proxy-sg.txt`,
  jp:   `${BASE_PROXY_URL}/cf-proxy-jp.txt`,
  kr:   `${BASE_PROXY_URL}/cf-proxy-kr.txt`,
  us:   `${BASE_PROXY_URL}/cf-proxy-us.txt`,
  ca:   `${BASE_PROXY_URL}/cf-proxy-ca.txt`,
  gb:   `${BASE_PROXY_URL}/cf-proxy-gb.txt`,
  de:   `${BASE_PROXY_URL}/cf-proxy-de.txt`,
  fr:   `${BASE_PROXY_URL}/cf-proxy-fr.txt`,
  nl:   `${BASE_PROXY_URL}/cf-proxy-nl.txt`,
  se:   `${BASE_PROXY_URL}/cf-proxy-se.txt`,
  fi:   `${BASE_PROXY_URL}/cf-proxy-fi.txt`,
  pl:   `${BASE_PROXY_URL}/cf-proxy-pl.txt`,
  ch:   `${BASE_PROXY_URL}/cf-proxy-ch.txt`,
  lv:   `${BASE_PROXY_URL}/cf-proxy-lv.txt`,
  ru:   `${BASE_PROXY_URL}/cf-proxy-ru.txt`,
  in:   `${BASE_PROXY_URL}/cf-proxy-in.txt`,
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

