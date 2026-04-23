/**
 * fetch-reverse-proxy-ips.ts
 *
 * Queries Cloudflare DoH for A records across all cmliussss.net reverse proxy
 * domains, deduplicates IPs, and writes per-country files to proxy/cf-proxy-<cc>.txt.
 *
 * Usage: npx tsx scripts/fetch-reverse-proxy-ips.ts
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
const PROXY_DIR = join(process.cwd(), 'proxy');

// Map of subdomains → country/region code used in output filename
const DOMAIN_MAP: [subdomain: string, cc: string, label: string][] = [
  ['proxyip.cmliussss.net', 'auto',    'Global'],
  ['proxyip.hk.cmliussss.net', 'hk',      'Hong Kong'],
  ['proxyip.sg.cmliussss.net', 'sg',      'Singapore'],
  ['proxyip.jp.cmliussss.net', 'jp',      'Japan'],
  ['proxyip.kr.cmliussss.net', 'kr',      'South Korea'],
  ['proxyip.in.cmliussss.net', 'in',      'India'],
  ['proxyip.gb.cmliussss.net', 'gb',      'United Kingdom'],
  ['proxyip.fr.cmliussss.net', 'fr',      'France'],
  ['proxyip.de.cmliussss.net', 'de',      'Germany'],
  ['proxyip.nl.cmliussss.net', 'nl',      'Netherlands'],
  ['proxyip.se.cmliussss.net', 'se',      'Sweden'],
  ['proxyip.fi.cmliussss.net', 'fi',      'Finland'],
  ['proxyip.pl.cmliussss.net', 'pl',      'Poland'],
  ['proxyip.ru.cmliussss.net', 'ru',      'Russia'],
  ['proxyip.ch.cmliussss.net', 'ch',      'Switzerland'],
  ['proxyip.lv.cmliussss.net', 'lv',      'Latvia'],
  ['proxyip.us.cmliussss.net', 'us',      'United States'],
  ['proxyip.ca.cmliussss.net', 'ca',      'Canada'],
];

interface DnsAnswer { type: number; data: string; }
interface DoHResponse { Answer?: DnsAnswer[]; }

/**
 * Fetch A records for a single domain via Cloudflare DoH.
 * Returns deduplicated array of IPv4 addresses.
 */
async function fetchARecords(domain: string): Promise<string[]> {
  const url = `${DOH_ENDPOINT}?name=${domain}&type=A`;
  const res = await fetch(url, { headers: { accept: 'application/dns-json' } });

  if (!res.ok) throw new Error(`HTTP ${res.status} for ${domain}`);

  const json = (await res.json()) as DoHResponse;

  // Cloudflare DoH type=1 = A record
  const ips = (json.Answer ?? [])
    .filter((a) => a.type === 1)
    .map((a) => a.data.trim())
    .filter((ip) => isValidIPv4(ip));

  return [...new Set(ips)];
}

function isValidIPv4(ip: string): boolean {
  return /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)$/.test(ip);
}

function outputFilename(cc: string): string {
  return `cf-proxy-${cc}.txt`;
}

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(PROXY_DIR, { recursive: true });

  const allIps = new Set<string>();
  const results: { domain: string; cc: string; label: string; ips: string[] }[] = [];
  let hasError = false;

  for (const [domain, cc, label] of DOMAIN_MAP) {
    try {
      console.log(`Querying ${label} (${domain})...`);
      const ips = await fetchARecords(domain);
      results.push({ domain, cc, label, ips });
      ips.forEach((ip) => allIps.add(ip));

      if (ips.length === 0) {
        console.log(`  ⚠  No A records found`);
      } else {
        console.log(`  ✓  ${ips.length} IP(s): ${ips.join(', ')}`);
      }
    } catch (err) {
      hasError = true;
      console.error(`  ✗  Failed: ${(err as Error).message}`);
    }
  }

  // Write per-country files
  for (const { cc, ips } of results) {
    const filename = join(PROXY_DIR, outputFilename(cc));
    writeFileSync(filename, ips.join('\n') + (ips.length > 0 ? '\n' : ''));
    console.log(`Written ${filename} (${ips.length} IPs)`);
  }

  // Write combined all-countries file
  const allPath = join(PROXY_DIR, 'cf-proxy-all.txt');
  const sortedAll = [...allIps].sort();
  writeFileSync(allPath, sortedAll.join('\n') + (sortedAll.length > 0 ? '\n' : ''));
  console.log(`Written ${allPath} (${sortedAll.length} unique IPs total)`);

  process.exit(hasError ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
