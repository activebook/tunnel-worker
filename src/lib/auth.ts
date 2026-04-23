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

    // Serve a one-time bootstrap page instead of a silent redirect.
    // This ensures the deployer explicitly sees and bookmarks the secure admin URL
    // before navigating to the portal — the URL is the credential.
    // P.S. request.url is always the remote url, not localhost even on dev
    const bootstrapUrl = new URL(request.url);
    bootstrapUrl.pathname = '/admin';
    bootstrapUrl.searchParams.set('token', storedToken);
    const adminUrl = bootstrapUrl.toString();

    const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Edge Tunnel — First-Time Setup</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Inter', sans-serif;
    background-color: #020617;
    background-image:
      radial-gradient(circle at 15% 20%, rgba(99, 102, 241, 0.12) 0%, transparent 50%),
      radial-gradient(circle at 85% 80%, rgba(139, 92, 246, 0.12) 0%, transparent 50%);
    color: #f4f4f5;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
  }
  .card {
    background: rgba(30, 30, 40, 0.85);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border: 1px solid rgba(99, 102, 241, 0.25);
    border-radius: 1.25rem;
    padding: 2rem;
    width: 100%;
    max-width: 480px;
    box-shadow: 0 25px 60px -12px rgba(0,0,0,.7);
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .icon-wrap {
    width: 3rem; height: 3rem; border-radius: 0.875rem;
    background: rgba(99, 102, 241, 0.15);
    border: 1px solid rgba(99, 102, 241, 0.3);
    display: flex; align-items: center; justify-content: center;
  }
  h1 { font-size: 1.25rem; font-weight: 600; line-height: 1.3; }
  .subtitle { color: #9ca3af; font-size: 0.8125rem; line-height: 1.6; }
  .callout {
    background: rgba(234, 179, 8, 0.08);
    border: 1px solid rgba(234, 179, 8, 0.25);
    border-radius: 0.75rem;
    padding: 0.875rem 1rem;
    font-size: 0.8125rem;
    color: #fde68a;
    line-height: 1.6;
  }
  .callout strong { display: block; margin-bottom: 0.25rem; color: #fbbf24; }
  .url-box {
    background: rgba(0,0,0,.35);
    border: 1px solid rgba(99, 102, 241, 0.2);
    border-radius: 0.625rem;
    padding: 0.75rem 1rem;
    font-family: 'Courier New', monospace;
    font-size: 0.75rem;
    color: #a5b4fc;
    word-break: break-all;
    cursor: pointer;
    user-select: all;
    transition: border-color 0.2s;
  }
  .url-box:hover { border-color: rgba(99, 102, 241, 0.5); }
  .copy-hint { font-size: 0.7rem; color: #6b7280; margin-top: 0.375rem; }
  .btn {
    display: block;
    width: 100%;
    padding: 0.75rem;
    background: linear-gradient(135deg, #6366f1, #8b5cf6);
    color: #fff;
    border: none;
    border-radius: 0.75rem;
    font-size: 0.9375rem;
    font-weight: 600;
    cursor: pointer;
    text-align: center;
    text-decoration: none;
    transition: opacity 0.2s, transform 0.15s;
  }
  .btn:hover { opacity: 0.9; transform: translateY(-1px); }
  .btn:active { transform: translateY(0); }
  .steps { display: flex; flex-direction: column; gap: 0.625rem; }
  .step { display: flex; align-items: flex-start; gap: 0.75rem; font-size: 0.8125rem; color: #9ca3af; }
  .step-num {
    flex-shrink: 0;
    width: 1.375rem; height: 1.375rem; border-radius: 50%;
    background: rgba(99, 102, 241, 0.15);
    border: 1px solid rgba(99, 102, 241, 0.3);
    display: flex; align-items: center; justify-content: center;
    font-size: 0.7rem; font-weight: 600; color: #a5b4fc;
  }
  #copyFeedback { color: #34d399; font-size: 0.7rem; margin-top: 0.375rem; display: none; }
</style>
</head>
<body>
<div class="card">
  <div style="display:flex;align-items:center;gap:0.875rem;">
    <div class="icon-wrap">
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a5b4fc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    </div>
    <div>
      <h1>Admin Portal Setup</h1>
      <p style="color:#9ca3af;font-size:0.75rem;margin-top:0.125rem;">Edge Tunnel — First Access</p>
    </div>
  </div>

  <div class="callout">
    <strong>⚠ Save this URL — it is your admin credential</strong>
    Your unique admin token has been generated.
    This is the <em>only</em> time it will be shown to you. The URL below grants full administrative access.
  </div>

  <div>
    <p style="font-size:0.75rem;color:#9ca3af;margin-bottom:0.5rem;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;">Your Admin URL</p>
    <div class="url-box" id="urlBox" onclick="copyUrl()">${adminUrl}</div>
    <p class="copy-hint">Click to copy &nbsp;·&nbsp; <span id="copyFeedback">Copied ✓</span></p>
  </div>

  <div class="steps">
    <div class="step"><span class="step-num">1</span>Copy and save the URL above in a password manager or secure note.</div>
    <div class="step"><span class="step-num">2</span>Click "Open Admin Portal" below to proceed.</div>
    <div class="step"><span class="step-num">3</span>Bookmark the page that opens — the full URL including the token.</div>
  </div>

  <a id="openBtn" class="btn" href="${adminUrl}">Open Admin Portal →</a>
</div>
<script>
  function copyUrl() {
    navigator.clipboard.writeText(document.getElementById('urlBox').textContent.trim())
      .then(() => { document.getElementById('copyFeedback').style.display = 'inline'; })
      .catch(() => {});
  }
</script>
</body>
</html>`;

    return {
      authorized: false,
      response: new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
    };

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
