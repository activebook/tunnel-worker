import type { Env, PreferredIP, ReverseProxyIP } from '../types';
import { putPreferredIps, getPreferredIps, putReverseProxyIps, getReverseProxyIps } from './kv';
import { checkTcpLatency, checkHttpLatency } from './network';

// Upstream matrix reservoirs identical to the original Node.js architecture.
const PREFERRED_IPS_SOURCES = [
  'https://raw.githubusercontent.com/Alvin9999-newpac/fanqiang/refs/heads/main/cloudflare%E4%BC%98%E9%80%89ip',
  'https://raw.githubusercontent.com/ymyuuu/IPDB/refs/heads/main/BestCF/bestcfv4.txt',
  'https://raw.githubusercontent.com/gslege/CloudflareIP/refs/heads/main/Cfxyz.txt'
];

const REVERSE_PROXY_SOURCES = [
  'https://raw.githubusercontent.com/activebook/tunnel-worker/refs/heads/main/proxy/cf-proxy.txt'
];

export async function aggregateReverseProxyIps(num: number, env: Env): Promise<number> {
  const ipSet = new Set<string>();

  // Utilizing Promise.allSettled to parallelize fetches, bypassing slow upstreams
  // without sacrificing the pipeline payload if one repository stalls.
  const fetches = REVERSE_PROXY_SOURCES.map(async (source) => {
    try {
      // Create a timeout controller to prevent the Edge execution from hanging
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 3000);

      const res = await fetch(source, { signal: controller.signal });
      clearTimeout(id);

      if (!res.ok) return;

      const text = await res.text();
      text.split('\n').forEach(line => {
        let ip = line.trim().split(':')[0].split('#')[0].trim();
        // Formal IPv4 validation
        if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
          ipSet.add(ip);
        }
      });
    } catch (_) {
      // Silently consume edge aborts or HTTP exceptions
    }
  });

  await Promise.allSettled(fetches);

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

  // Sort by latency (lowest first)
  measuredIps.sort((a, b) => a.latency - b.latency);

  if (measuredIps.length === 0 && primeSubset.length > 0) {
    // If all latency checks failed (likely due to edge networking restrictions),
    // we still want to persist the IPs to the user with a placeholder latency.
    primeSubset.forEach(ip => measuredIps.push({ ip, latency: 0 }));
  }

  // Persist directly to KV
  await putReverseProxyIps(env, measuredIps);

  return measuredIps.length;
}

/**
 * Executes a massively parallel autonomous crawl against external upstream IP repositories.
 * Operates natively within the Cloudflare V8 memory isolate.
 * 
 * @returns The number of deduplicated IPs successfully pushed to KV.
 */
export async function aggregatePreferredIps(num: number, env: Env): Promise<number> {
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
        let ip = line.trim().split(':')[0].split('#')[0].trim();
        // Formal IPv4 validation
        if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(ip)) {
          ipSet.add(ip);
        }
      });
    } catch (_) {
      // Silently consume edge aborts or HTTP exceptions
    }
  });

  await Promise.allSettled(fetches);

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
  const measuredIps: PreferredIP[] = [];
  const latencyChecks = primeSubset.map(async (ip) => {
    const latency = await checkHttpLatency(ip);
    if (latency !== null) {
      measuredIps.push({ ip, latency });
    }
  });

  await Promise.allSettled(latencyChecks);

  // Sort by latency (lowest first)
  measuredIps.sort((a, b) => a.latency - b.latency);

  if (measuredIps.length === 0 && primeSubset.length > 0) {
    // If all latency checks failed (common for Cloudflare IPs due to loopback block),
    // we still want to provide the IPs with a placeholder latency.
    primeSubset.forEach(ip => measuredIps.push({ ip, latency: 0 }));
  }

  // Persist directly to KV
  await putPreferredIps(env, measuredIps);

  return measuredIps.length;
}
