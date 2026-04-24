import type { Env } from '../types';
import { getUuid, putUuid, getPreferredIps, getReverseProxyIps, getForceReverseProxyBridge, setForceReverseProxyBridge } from '../lib/kv';
import { generateUuid } from '../lib/utils';
import { aggregateReverseProxyIps, fetchPreferredIps, setRankedPreferredIps } from '../lib/crawler';

import { verifyAdminAuth } from '../lib/auth';

const MAX_PREFERRED_IPS = 20;
const MAX_REVERSE_PROXY_IPS = 20;

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
    const [ips, reverseIps, forceBridge] = await Promise.all([
      getPreferredIps(env),
      getReverseProxyIps(env),
      getForceReverseProxyBridge(env),
    ]);
    return Response.json({ uuid, ips, reverseIps, forceBridge });
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

  // POST /services/policy — update Force Bridge flag
  if (method === 'POST' && url.pathname === '/services/policy') {
    try {
      const { enabled } = await request.json() as { enabled?: boolean };
      if (typeof enabled === 'boolean') {
        await setForceReverseProxyBridge(env, enabled);
        return new Response('OK', { status: 200 });
      }
    } catch (e) { }
    return new Response('Bad Request', { status: 400 });
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
        // Sort ascending server-side as a defence-in-depth measure
        .sort((a, b) => a.latency - b.latency);

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
    
    // Fetch richer data from ipwho.is via Worker backend to bypass client-side adblockers
    try {
      if (ip !== 'Unknown') {
        const whoRes = await fetch(`https://ipwho.is/${ip}`);
        if (whoRes.ok) {
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
          }
        }
      }
    } catch (_) {}
    
    return Response.json({
      ip,
      type,
      location,
      asn,
      asnOwner,
      colo: cf.colo || 'Unknown',
      isp
    });
  }

  // GET /services/speedtest — return 25MB of random-like data for speed testing
  if (method === 'GET' && url.pathname === '/services/speedtest') {
    const size = 25 * 1024 * 1024; // 25 MB
    const chunkSize = 1024 * 1024; // 1 MB chunk
    const chunk = new Uint8Array(chunkSize);
    for (let i = 0; i < chunkSize; i++) chunk[i] = Math.floor(Math.random() * 256);

    const stream = new ReadableStream({
      start(controller) {
        let sent = 0;
        function push() {
          if (sent < size) {
            controller.enqueue(chunk);
            sent += chunkSize;
            push();
          } else {
            controller.close();
          }
        }
        push();
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Content-Length': size.toString()
      }
    });
  }

  return new Response('Not Found', { status: 404 });
}
