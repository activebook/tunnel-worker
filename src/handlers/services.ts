import type { Env } from '../types';
import { getUuid, putUuid, getPreferredIps, getReverseProxyIps, getSettings, putSettings, type Settings, type RoutingPolicy, getTelemetryAuth, putTelemetryAuth } from '../lib/kv';
import { generateUuid } from '../lib/utils';
import { aggregateReverseProxyIps, fetchPreferredIps, setRankedPreferredIps, crawlForAll } from '../lib/crawler';

import { verifyAdminAuth } from '../lib/auth';

const MAX_PREFERRED_IPS = 20;
const MAX_REVERSE_PROXY_IPS = 20;

// Module scope — runs ONCE when the isolate starts, never again
const SPEEDTEST_CHUNK = (() => {
  const buf = new Uint8Array(1 * 1024 * 1024); // 1MB
  for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff; // non-compressible pattern
  return buf;
})();

/**
 * Handles all /services/* infrastructure and state management requests.
 */
export async function handleServices(request: Request, env: Env): Promise<Response> {
  const { authorized, response } = await verifyAdminAuth(request, env);
  if (!authorized) return response!;

  const url = new URL(request.url);
  const { method } = request;

  // GET /services/settings — return current state
  if (method === 'GET' && url.pathname === '/services/settings') {
    let uuid = await getUuid(env);
    if (!uuid) {
      uuid = generateUuid();
      await putUuid(env, uuid);
    }
    const [ips, reverseIps, settings] = await Promise.all([
      getPreferredIps(env),
      getReverseProxyIps(env),
      getSettings(env)
    ]);
    return Response.json({ uuid, ips, reverseIps, settings });
  }

  // POST /services/uuid — update UUID
  if (method === 'POST' && url.pathname === '/services/uuid') {
    try {
      const { uuid } = await request.json() as { uuid?: string };
      if (typeof uuid === 'string' && /^[0-9a-f-]{32,36}$/i.test(uuid)) {
        await putUuid(env, uuid);
        return new Response('OK', { status: 200 });
      }
    } catch (e) { }
    return new Response('Bad Request', { status: 400 });
  }

  // POST /services/settings — update consolidated settings
  if (method === 'POST' && url.pathname === '/services/settings') {
    try {
      const updates = await request.json() as Partial<Settings>;
      // Basic validation for routingPolicy if present
      if (updates.routingPolicy && !['AUTO', 'BRIDGE', 'DIRECT'].includes(updates.routingPolicy)) {
        return new Response('Invalid Policy', { status: 400 });
      }
      await putSettings(env, updates);
      return new Response('OK', { status: 200 });
    } catch (e) { }
    return new Response('Bad Request', { status: 400 });
  }

  // GET /services/cron — Manually trigger scheduled matrix maintenance (Secret URL)
  // Protected by the same verifyAdminAuth token requirement as the rest of the file
  if (method === 'GET' && url.pathname === '/services/cron') {
    // We await it directly instead of waitUntil so the caller knows when it finishes.
    // The 30s Cloudflare HTTP timeout limit is plenty for our optimized parallel probes.
    await crawlForAll(env);
    return new Response('CRON Manual Trigger Completed successfully', { status: 200 });
  }

  // GET /services/preferred — crawl upstream sources and return raw IP list for client-side latency measurement
  if (method === 'GET' && url.pathname === '/services/preferred') {
    const candidates = await fetchPreferredIps(MAX_PREFERRED_IPS);
    return candidates.length > 0
      ? Response.json({ candidates })
      : new Response('Sync Failed: no IPs retrieved from upstream sources', { status: 502 });
  }

  // POST /services/preferred/ranked — accept client-measured { ip, latency }[] and persist to KV
  if (method === 'POST' && url.pathname === '/services/preferred/ranked') {
    try {
      const body = await request.json() as unknown;
      if (!Array.isArray(body)) return new Response('Bad Request: expected array', { status: 400 });

      const rankedIps = (body as { ip?: unknown; latency?: unknown }[])
        .filter(e => typeof e.ip === 'string' && typeof e.latency === 'number')
        .map(e => ({ ip: e.ip as string, latency: e.latency as number }))
        // Sort ascending server-side as a defence-in-depth measure.
        // Correctly handle -1 (dead nodes) by pushing them to the end.
        .sort((a, b) => {
          if (a.latency < 0 && b.latency >= 0) return 1;
          if (b.latency < 0 && a.latency >= 0) return -1;
          return a.latency - b.latency;
        });

      if (rankedIps.length === 0) return new Response('Bad Request: no valid entries', { status: 400 });

      await setRankedPreferredIps(env, rankedIps);
      return Response.json({ status: 'ok', count: rankedIps.length });
    } catch (_) {
      return new Response('Bad Request', { status: 400 });
    }
  }

  // POST /services/reverse — sync bridge IPs from a specific region (defaults to 'all')
  if (method === 'POST' && url.pathname === '/services/reverse') {
    let region = 'all';
    try {
      const body = await request.json() as { region?: string };
      if (typeof body.region === 'string' && body.region.length > 0) {
        region = body.region;
      }
    } catch (_) { /* body is optional; default to 'all' */ }

    const count = await aggregateReverseProxyIps(MAX_REVERSE_PROXY_IPS, env, region);
    return count > 0
      ? Response.json({ status: 'ok', count })
      : new Response('Sync Failed', { status: 502 });
  }

  // GET /services/myip — return network identity and location info
  if (method === 'GET' && url.pathname === '/services/myip') {
    const cf = request.cf || {} as any;
    const ip = (request.headers.get('cf-connecting-ip') || 'Unknown').split(',')[0].trim();

    // Base Cloudflare data
    let location = `${cf.city || 'Unknown'}, ${cf.region || ''}, ${cf.country || 'Unknown'}`;
    let asn = cf.asn || 'Unknown';
    let asnOwner = cf.asOrganization || 'Unknown';
    let isp = 'Unknown';
    let type = 'IPv4';
    let latitude = cf.latitude || null;
    let longitude = cf.longitude || null;

    // Fetch richer data from ipwho.is and ipapi.is via Worker backend
    let security = {
      is_datacenter: false,
      is_vpn: false,
      is_tor: false,
      is_proxy: false,
      is_abuser: false,
      datacenter_name: '',
      asn_type: ''
    };

    try {
      if (ip !== 'Unknown') {
        // Run fetches concurrently but parse JSON separately to prevent a single API failure from breaking the other
        const reqInit: RequestInit = {
          headers: {
            'User-Agent': 'EdgeTunnel-Diag/1.0',
            'Accept': 'application/json'
          }
        };

        const [whoRes, secRes] = await Promise.all([
          fetch(`https://ipwho.is/${ip}`, reqInit).catch(() => null),
          fetch(`https://api.ipapi.is/?q=${ip}`, reqInit).catch(() => null)
        ]);

        if (whoRes && whoRes.ok) {
          try {
            const who = await whoRes.json() as any;
            if (who.success) {
              const flag = who.flag ? who.flag.emoji : '';
              const locInfo = [who.city, who.region, who.country].filter(Boolean).join(', ');
              location = (flag ? flag + ' ' : '') + locInfo;

              if (who.connection) {
                asn = who.connection.asn || asn;
                asnOwner = who.connection.org || asnOwner;
                isp = who.connection.isp || isp;
              }
              type = who.type || type;
              const lat = who.latitude;
              const lon = who.longitude;
              if (typeof lat === 'number' && typeof lon === 'number' && !(lat === 0 && lon === 0)) {
                latitude = lat;
                longitude = lon;
              }
            }
          } catch (_) { /* Ignore ipwho.is JSON parse error */ }
        }

        if (secRes && secRes.ok) {
          try {
            const sec = await secRes.json() as any;
            security.is_datacenter = !!sec.is_datacenter;
            security.is_vpn = !!sec.is_vpn;
            security.is_tor = !!sec.is_tor;
            security.is_proxy = !!sec.is_proxy;
            security.is_abuser = !!sec.is_abuser;
            security.datacenter_name = sec.datacenter?.datacenter || '';
            security.asn_type = sec.company?.type || '';
          } catch (_) { /* Ignore ipapi.is JSON parse error */ }
        }
      }
    } catch (_) { }

    return Response.json({
      ip,
      type,
      location,
      asn,
      asnOwner,
      colo: cf.colo || 'Unknown',
      isp,
      latitude,
      longitude,
      security
    });
  }

  // GET /services/speedtest — return 1MB chunk for speed testing
  if (method === 'GET' && url.pathname === '/services/speedtest') {
    return new Response(SPEEDTEST_CHUNK, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Length': SPEEDTEST_CHUNK.byteLength.toString(),
        'Access-Control-Allow-Origin': '*',
      }
    });
  }

  // POST /services/telemetry/auth — save CF API credentials
  if (method === 'POST' && url.pathname === '/services/telemetry/auth') {
    try {
      const auth = await request.json() as { accountId?: string, apiToken?: string };
      if (typeof auth.accountId === 'string' && typeof auth.apiToken === 'string') {
        await putTelemetryAuth(env, { accountId: auth.accountId, apiToken: auth.apiToken });
        return new Response('OK', { status: 200 });
      }
    } catch (e) { }
    return new Response('Bad Request', { status: 400 });
  }

  // GET /services/telemetry — query CF GraphQL for usage analytics
  if (method === 'GET' && url.pathname === '/services/telemetry') {
    const auth = await getTelemetryAuth(env);
    if (!auth) return new Response('Unauthorized: Telemetry not configured', { status: 401 });

    const now = new Date();
    // Get stats for today (00:00:00 to now) UTC
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);

    const query = `
      query GetUsage($accountId: String!, $datetimeStart: String!, $datetimeEnd: String!) {
        viewer {
          accounts(filter: {accountTag: $accountId}) {
            workersInvocationsAdaptive(limit: 10000, filter: {
              datetime_geq: $datetimeStart, 
              datetime_leq: $datetimeEnd
            }) {
              sum { requests errors }
              quantiles { cpuTimeP50 cpuTimeP99 }
            }
          }
        }
      }
    `;

    try {
      const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${auth.apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query,
          variables: {
            accountId: auth.accountId,
            datetimeStart: start.toISOString(),
            datetimeEnd: now.toISOString()
          }
        })
      });

      if (!res.ok) {
        return new Response(`GraphQL API Error: ${res.statusText}`, { status: 502 });
      }

      const rawData = await res.json() as any;
      const rows: any[] = rawData?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];

      const metrics = rows.reduce((acc, r) => ({
        requests: acc.requests + (r.sum?.requests || 0),
        errors: acc.errors + (r.sum?.errors || 0),
      }), { requests: 0, errors: 0 });

      const lastQ = rows[rows.length - 1]?.quantiles || {};
      (metrics as any).cpuTimeP50 = lastQ.cpuTimeP50 || 0;
      (metrics as any).cpuTimeP99 = lastQ.cpuTimeP99 || 0;

      return Response.json({ metrics, hasAuth: true });
    } catch (e: any) {
      return new Response(`Telemetry Fetch Failed: ${e.message}`, { status: 500 });
    }
  }

  return new Response('Not Found', { status: 404 });
}
