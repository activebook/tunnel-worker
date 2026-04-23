import type { Env } from '../types';
import { getUuid, putUuid, getPreferredIps, getReverseProxyIps, getForceReverseProxyBridge, setForceReverseProxyBridge } from '../lib/kv';
import { generateUuid } from '../lib/utils';
import { aggregatePreferredIps, aggregateReverseProxyIps } from '../lib/crawler';
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
    } catch (e) {}
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
    } catch (e) {}
    return new Response('Bad Request', { status: 400 });
  }

  // POST /services/preferred — sync anycast
  if (method === 'POST' && url.pathname === '/services/preferred') {
    const count = await aggregatePreferredIps(MAX_PREFERRED_IPS, env);
    return count > 0 
      ? Response.json({ status: 'ok', count }) 
      : new Response('Sync Failed', { status: 502 });
  }

  // POST /services/reverse — sync bridge
  if (method === 'POST' && url.pathname === '/services/reverse') {
    const count = await aggregateReverseProxyIps(MAX_REVERSE_PROXY_IPS, env);
    return count > 0 
      ? Response.json({ status: 'ok', count }) 
      : new Response('Sync Failed', { status: 502 });
  }

  return new Response('Not Found', { status: 404 });
}
