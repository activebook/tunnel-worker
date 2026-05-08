// ── Admin Portal — presentation and mutation layer ───────────────────────────
// hostname is injected server-side so the subscription URI is always accurate
// without hardcoding any domain into the source code.
//
// The entire UI is compiled as a TypeScript template literal and served
// directly from the Worker's V8 isolate memory — zero external file fetches,
// zero cold-storage round-trips, sub-millisecond TTFB on the edge.
//
// Security model: on first access to /admin (no token in KV), a cryptographically
// secure UUID token is generated, persisted to the TUNNEL KV namespace, and the
// caller is immediately redirected to /admin?token=<generated>. The deployer
// bookmarks that URL — that IS the admin link. No secrets in source or [vars].

import type { Env } from '../types';
import { verifyAdminAuth } from '../lib/auth';
import { getPreferredIps, getReverseProxyIps } from '../lib/kv';

// @ts-ignore
import { ADMIN_TEMPLATE } from '../ui/admin/admin.generated';

/**
 * Encapsulates the /admin presentation layer.
 */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const { authorized, response } = await verifyAdminAuth(request, env);
  if (!authorized) return response!;

  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token')!;

  // Check if KV has been bootstrapped — if both matrices are empty,
  // the user needs the first-time initialization experience.
  const [preferredIps, reverseProxyIps] = await Promise.all([
    getPreferredIps(env),
    getReverseProxyIps(env),
  ]);
  const needsBootstrap = preferredIps.length === 0 || reverseProxyIps.length === 0;

  // ── Authenticated Route: Serve Portal HTML ─────────────────────────────────
  console.log('[ADMIN] GET /admin — rendering portal HTML', { needsBootstrap });
  return new Response(renderAdminUI(queryToken, url.hostname, needsBootstrap), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export function renderAdminUI(token: string, hostname: string, needsBootstrap: boolean): string {
  return ADMIN_TEMPLATE
    .replaceAll('{{HOST}}', hostname)
    .replaceAll('{{TOKEN}}', token)
    .replaceAll('{{NEEDS_BOOTSTRAP}}', String(needsBootstrap))
    .replaceAll('{{BOOTSTRAP_CLASS}}', needsBootstrap ? '' : 'hidden');
}
