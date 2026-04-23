import type { Env } from '../types';
import { getAdminToken, putAdminToken } from './kv';
import { generateToken } from './utils';

/**
 * Validates the administrative token and handles first-boot generation.
 * If no token is found in KV, it generates one and triggers a redirect.
 * If a token is supplied but invalid, it returns a 401/403 response.
 */
export async function verifyAdminAuth(request: Request, env: Env): Promise<{ authorized: boolean; response?: Response }> {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token');

  let storedToken = await getAdminToken(env);
  
  // ── First-boot Bootstrapping ──────────────────────────────────────────────
  if (!storedToken) {
    storedToken = generateToken();
    await putAdminToken(env, storedToken);
    console.log('[AUTH] First-boot: generated and persisted admin token.');
    
    // Redirect to the same path with the token attached
    const bootstrapUrl = new URL(request.url);
    bootstrapUrl.searchParams.set('token', storedToken);
    return { authorized: false, response: Response.redirect(bootstrapUrl.toString(), 302) };
  }

  // ── Validation ────────────────────────────────────────────────────────────
  if (!queryToken) {
    console.warn('[AUTH] 401: missing token');
    return { 
      authorized: false, 
      response: new Response('401 Unauthorized\n\nNo admin token supplied.', { status: 401 }) 
    };
  }

  if (queryToken !== storedToken) {
    console.warn('[AUTH] 403: token mismatch');
    return { authorized: false, response: new Response('403 Forbidden', { status: 403 }) };
  }

  return { authorized: true };
}
