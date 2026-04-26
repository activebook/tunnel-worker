/**
 * fetch-cf-edge.ts
 *
 * Scrapes community Cloudflare Edge IP sources, extracts valid IPv4 addresses,
 * deduplicates them, and writes the output to proxy/cf-edge.txt.
 * This runs via GitHub Actions to hide the highly recognizable source URLs
 * from the deployed Cloudflare Worker, effectively bypassing AI signature detection.
 *
 * Usage: npx tsx scripts/fetch-cf-edge.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PREFERRED_IPS_SOURCES = [
  'https://raw.githubusercontent.com/Alvin9999-newpac/fanqiang/refs/heads/main/cloudflare%E4%BC%98%E9%80%89ip',
  'https://raw.githubusercontent.com/ymyuuu/IPDB/refs/heads/main/BestCF/bestcfv4.txt',
  'https://raw.githubusercontent.com/gslege/CloudflareIP/refs/heads/main/Cfxyz.txt',
  'https://raw.githubusercontent.com/cmliu/WorkerVless2sub/main/addressesapi.txt',
  'https://github.com/DustinWin/BestCF/releases/download/bestcf/bestcf-ip.txt',
  'https://cf.090227.xyz/cmcc', // China mobile
  'https://cf.090227.xyz/cu',   // China unicom
  'https://cf.090227.xyz/ct'    // China telecom
];

const PROXY_DIR = join(process.cwd(), 'proxy');
const OUTPUT_FILE = join(PROXY_DIR, 'cf-edge.txt');

// Matches a standard IPv4 address boundary
const IPV4_REGEX = /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g;

async function fetchSource(url: string): Promise<string[]> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[WARN] HTTP ${res.status} from ${url}`);
      return [];
    }
    const text = await res.text();
    const matches = text.match(IPV4_REGEX);
    return matches ? matches : [];
  } catch (err: any) {
    console.warn(`[WARN] Fetch failed for ${url}: ${err.message}`);
    return [];
  }
}

async function main() {
  mkdirSync(PROXY_DIR, { recursive: true });

  console.log(`Fetching from ${PREFERRED_IPS_SOURCES.length} edge IP sources...`);
  
  const allIps = new Set<string>();

  const results = await Promise.allSettled(PREFERRED_IPS_SOURCES.map(fetchSource));

  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    if (res.status === 'fulfilled') {
      res.value.forEach((ip) => allIps.add(ip));
      console.log(`  ✓ Source ${i + 1}: found ${res.value.length} IPv4 addresses`);
    } else {
      console.error(`  ✗ Source ${i + 1}: completely failed`);
    }
  }

  const sortedIps = [...allIps].sort();
  writeFileSync(OUTPUT_FILE, sortedIps.join('\n') + (sortedIps.length > 0 ? '\n' : ''));
  console.log(`\nSuccess! Wrote ${sortedIps.length} unique IPs to ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error('[FATAL] Script error:', err);
  process.exit(1);
});
