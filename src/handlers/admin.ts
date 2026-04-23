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
import { getUuid, putUuid, getPreferredIps, getReverseProxyIps, getAdminToken, putAdminToken, getForceReverseProxyBridge, setForceReverseProxyBridge } from '../lib/kv';
import { generateUuid, generateToken } from '../lib/utils';

import { aggregatePreferredIps, aggregateReverseProxyIps } from '../lib/crawler';

const MAX_PREFERRED_IPS = 10;
const MAX_REVERSE_PROXY_IPS = 10;

/**
 * Encapsulates all /admin/* routing and API business logic.
 * On first visit (no token in KV), generates and persists a secure token,
 * then redirects the caller so they receive — and can bookmark — the full URL.
 */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { method } = request;
  const queryToken = url.searchParams.get('token');

  // ── Token bootstrap ────────────────────────────────────────────────────────
  // On the very first visit, ADMIN_TOKEN is absent from KV. We generate a
  // cryptographically secure UUID, persist it, and immediately redirect the
  // caller to the portal with the token embedded in the URL.
  // The first accessor is definitionally the deployer — acceptable trust model.
  let storedToken = await getAdminToken(env);
  if (!storedToken) {
    storedToken = generateToken();

    await putAdminToken(env, storedToken);
    console.log('[ADMIN] First-boot: admin token generated and persisted to KV.');
    // Redirect to the same path with the new token so the user can bookmark it.
    const bootstrapUrl = new URL(request.url);
    bootstrapUrl.searchParams.set('token', storedToken);
    return Response.redirect(bootstrapUrl.toString(), 302);
  }

  // ── Token validation ───────────────────────────────────────────────────────
  if (!queryToken) {
    // No token in URL — don't hint at what the token is; just tell them where it is.
    console.warn('[ADMIN] 401: request arrived without token');
    return new Response(
      '401 Unauthorized\n\nNo admin token supplied.\nUse the bookmarked URL you received on first setup.',
      { status: 401, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  if (queryToken !== storedToken) {
    console.warn('[ADMIN] 403: token mismatch');
    return new Response('403 Forbidden', { status: 403 });
  }

  // ── Authenticated routes ───────────────────────────────────────────────────

  // GET /admin/api — return current UUID, IPs and settings
  if (method === 'GET' && url.pathname === '/admin/api') {
    console.log('[ADMIN] GET /admin/api — reading UUID and IPs from KV');
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

  // POST /admin/api — persist a new UUID sent by the UI
  if (method === 'POST' && url.pathname === '/admin/api') {
    console.log('[ADMIN] POST /admin/api — persisting UUID');
    try {
      const { uuid } = await request.json() as { uuid?: string };
      if (typeof uuid === 'string' && /^[0-9a-f-]{32,36}$/i.test(uuid)) {
        await putUuid(env, uuid);
        console.log('[ADMIN] UUID persisted OK');
        return new Response('OK', { status: 200 });
      }
      console.warn('[ADMIN] UUID failed format validation');
    } catch (e) {
      console.error('[ADMIN] Failed to parse request body:', e);
    }
    return new Response('Bad Request', { status: 400 });
  }

  // POST /admin/api/force-bridge — toggle the Force Bridge flag
  if (method === 'POST' && url.pathname === '/admin/api/force-bridge') {
    try {
      const { enabled } = await request.json() as { enabled?: boolean };
      if (typeof enabled === 'boolean') {
        await setForceReverseProxyBridge(env, enabled);
        console.log(`[ADMIN] Force Bridge set to: ${enabled}`);
        return new Response('OK', { status: 200 });
      }
    } catch (e) {
      console.error('[ADMIN] Failed to parse force-bridge request:', e);
    }
    return new Response('Bad Request', { status: 400 });
  }

  // POST /admin/api/sync/preferred — crawl preferred IPs only
  if (method === 'POST' && url.pathname === '/admin/api/sync/preferred') {
    console.log('[ADMIN] POST /admin/api/sync/preferred — starting Preferred IP crawler');
    const count = await aggregatePreferredIps(MAX_PREFERRED_IPS, env);
    console.log(`[CRAWLER] Completed: ${count} Preferred IPs written to KV`);
    if (count > 0) {
      return new Response(JSON.stringify({ status: 'ok', count }), { status: 200 });
    }
    return new Response('Sync Failed — Upstreams Offline', { status: 502 });
  }

  // POST /admin/api/sync/reverse — crawl reverse proxy IPs only
  if (method === 'POST' && url.pathname === '/admin/api/sync/reverse') {
    console.log('[ADMIN] POST /admin/api/sync/reverse — starting Reverse Proxy IP crawler');
    const count = await aggregateReverseProxyIps(MAX_REVERSE_PROXY_IPS, env);
    console.log(`[CRAWLER] Completed: ${count} Reverse Proxy IPs written to KV`);
    if (count > 0) {
      return new Response(JSON.stringify({ status: 'ok', count }), { status: 200 });
    }
    return new Response('Sync Failed — Upstreams Offline', { status: 502 });
  }

  // GET /admin — serve the portal HTML
  console.log('[ADMIN] GET /admin — rendering portal HTML');
  return new Response(renderAdminUI(queryToken, url.hostname), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}


/**
 * Renders the administration portal.
 *
 * @param token    - The validated admin token, embedded into the client-side
 *                   fetch calls so the browser can GET/POST mutations back.
 * @param hostname - The Worker's public hostname (e.g. transfer.ccwu.cc)
 */
export function renderAdminUI(token: string, hostname: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Edge Tunnel</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
<!-- Tailwind CSS Minified -->
<link href="https://cdnjs.cloudflare.com/ajax/libs/tailwindcss/2.2.19/tailwind.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
<style>
  body {
    font-family: 'Inter', sans-serif;
    background-color: #020617;
    background-image: 
      radial-gradient(circle at 0% 0%, rgba(30, 64, 175, 0.15) 0%, transparent 50%),
      radial-gradient(circle at 100% 100%, rgba(76, 29, 149, 0.15) 0%, transparent 50%);
    color: #f4f4f5;
  }
  .glass-panel {
    background: rgba(61, 61, 69, 0.72);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border: 1px solid rgba(63, 63, 70, 0.4);
    box-shadow: 0 25px 50px -12px rgba(0,0,0,.55);
  }
  .mono-box {
    background: rgba(0,0,0,.3);
    border: 1px solid rgba(63, 63, 70, 0.4);
  }
</style>
</head>
<body class="min-h-screen flex items-center justify-center p-4">

<div class="glass-panel rounded-2xl p-8 w-full max-w-lg flex flex-col gap-6">

  <header>
    <h1 class="text-2xl font-semibold tracking-tight mb-1">Edge Tunnel</h1>
    <p class="text-gray-400 text-sm">Autonomous proxy matrix & route optimization</p>
  </header>

  <hr class="border-gray-700 border-opacity-40">

  <!-- ── VLESS Authentication Matrix ────────────────────────────────────── -->
  <div class="flex flex-col gap-2">
    <label class="text-xs uppercase tracking-wider font-semibold text-gray-400">UUID</label>
    <div class="flex gap-2 items-stretch">
      <div class="mono-box flex-1 px-4 py-3 rounded-lg text-gray-300 font-mono text-sm cursor-pointer truncate" id="uuidDisplay" title="Click to copy" onclick="copyText(this)"></div>
      <button class="bg-indigo-500 bg-opacity-10 hover:bg-opacity-20 text-indigo-300 border border-indigo-500 border-opacity-20 transition-all rounded-lg w-14 flex-shrink-0 flex items-center justify-center shadow-lg backdrop-filter blur-sm" id="regenBtn" title="Regenerate & Save Token" onclick="regenerate()">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>
  </div>

  <hr class="border-gray-700 border-opacity-40">

  <!-- ── Upstream Node Synchronization ───────────────────────────────────── -->
  <div class="flex flex-col gap-2">
    <label class="text-xs uppercase tracking-wider font-semibold text-gray-400">Preferred IPs</label>
    <div class="flex gap-2 items-stretch">
      <div class="mono-box flex-1 px-4 py-3 rounded-lg text-gray-300 font-mono text-sm overflow-y-auto max-h-32" id="ipDisplay">
        <span class="italic text-gray-500">Loading...</span>
      </div>
      <button class="bg-indigo-500 bg-opacity-10 hover:bg-opacity-20 text-indigo-300 border border-indigo-500 border-opacity-20 transition-all rounded-lg w-14 flex-shrink-0 flex items-center justify-center shadow-lg backdrop-filter blur-sm" id="syncPreferredBtn" title="Sync Preferred IPs" onclick="syncPreferredIps()">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>
  </div>

  <hr class="border-gray-700 border-opacity-40">

  <!-- ── Reverse Proxy Synchronization ───────────────────────────────────── -->
  <div class="flex flex-col gap-2">
    <label class="text-xs uppercase tracking-wider font-semibold text-gray-400">Reverse Proxy IPs</label>
    <div class="flex gap-2 items-stretch">
      <div class="mono-box flex-1 px-4 py-3 rounded-lg text-gray-300 font-mono text-sm overflow-y-auto max-h-32" id="reverseIpDisplay">
        <span class="italic text-gray-500">Loading...</span>
      </div>
      <button class="bg-indigo-500 bg-opacity-10 hover:bg-opacity-20 text-indigo-300 border border-indigo-500 border-opacity-20 transition-all rounded-lg w-14 flex-shrink-0 flex items-center justify-center shadow-lg backdrop-filter blur-sm" id="syncReverseBtn" title="Sync Reverse Proxy IPs" onclick="syncReverseIps()">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>
  </div>

  <hr class="border-gray-700 border-opacity-40">

  <!-- ── Force Bridge Toggle ───────────────────────────────────── -->
  <div class="flex items-center justify-between">
    <div>
      <p class="text-sm font-medium text-gray-200">Use Reverse Proxy Anyway</p>
      <p class="text-xs text-gray-500 mt-0.5">Force all HTTPS connections through the Reverse Proxy, bypassing direct connects. May increase latency.</p>
    </div>
    <label class="relative inline-flex items-center cursor-pointer ml-4 flex-shrink-0">
      <input type="checkbox" id="forceBridgeToggle" class="sr-only peer" onchange="saveForceBridge(this.checked)">
      <div class="w-11 h-6 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-500"></div>
    </label>
  </div>

  <hr class="border-gray-700 border-opacity-40">

  <!-- ── Base64 Subscription Endpoint ──────────────────────── -->
  <div class="flex flex-col gap-2">
    <label class="text-xs uppercase tracking-wider font-semibold text-gray-400">V2Ray/Clash Base64 Subscription</label>
    <div class="flex gap-2 items-stretch">
      <div class="mono-box flex-1 px-4 py-3 rounded-lg text-gray-300 font-mono text-sm cursor-pointer truncate" id="subLink" title="Click to copy" onclick="copyText(this)"></div>
      <button class="bg-indigo-500 bg-opacity-10 hover:bg-opacity-20 text-indigo-300 border border-indigo-500 border-opacity-20 transition-all rounded-lg w-14 flex-shrink-0 flex items-center justify-center shadow-lg backdrop-filter blur-sm" title="Copy subscription URL" onclick="copyText(document.getElementById('subLink'))">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      </button>
    </div>
    <div class="flex justify-center py-4">
      <div id="qr" class="bg-white p-3 rounded-xl shadow-lg"></div>
    </div>
  </div>

</div>

<!-- Toast Notification -->
<div id="status" class="fixed top-6 right-6 z-50 bg-gray-900 border border-gray-700 shadow-2xl rounded-lg px-6 py-4 text-sm font-medium transform transition-all duration-300 translate-x-32 opacity-0 pointer-events-none"></div>

<script>
  const HOST  = '${hostname}';
  const TOKEN = '${token}';

  let pendingUuid = '';
  let qrInstance  = null;

  function applyUuid(uuid) {
    pendingUuid = uuid;
    document.getElementById('uuidDisplay').textContent = uuid;

    // Synthesis of the global subscription URL, utilizing the proxy UUID as the carrier token.
    const SUB_URI = \`https://\${HOST}/sub?token=\${uuid}\`;

    // The subscription endpoint abstracts all VLESS parameters natively;
    // clients only need this one URL to fetch the base64 matrix.
    document.getElementById('subLink').textContent = SUB_URI;

    const qrEl = document.getElementById('qr');
    qrEl.innerHTML = '';
    qrInstance = new QRCode(qrEl, {
      text:           SUB_URI,
      width:          180,
      height:         180,
      colorDark:      '#000000',
      colorLight:     '#ffffff',
      correctLevel:   QRCode.CorrectLevel.M,
    });
  }

  function renderIps(nodes, containerId) {
    const container = document.getElementById(containerId);
    if (!nodes || nodes.length === 0) {
      container.innerHTML = '<span class="italic text-gray-500">No IPs cached. Please renew.</span>';
      return;
    }
    container.innerHTML = nodes.map(node => {
      // Handle legacy string arrays or new objects with latency
      const ipStr = typeof node === 'string' ? node : node.ip;
      const latencyStr = node.latency ? \`<span class="text-xs ml-2 opacity-50">[\${node.latency}ms]</span>\` : '';
      return \`<div class="truncate text-gray-300 border-b border-gray-700 border-opacity-40 last:border-0 py-1">\${ipStr}\${latencyStr}</div>\`;
    }).join('');
  }

  (async () => {
    try {
      const r = await fetch('/admin/api?token=' + TOKEN);
      if (r.ok) {
        const { uuid, ips, reverseIps, forceBridge } = await r.json();
        if (uuid) applyUuid(uuid);
        if (ips) renderIps(ips, 'ipDisplay');
        if (reverseIps) renderIps(reverseIps, 'reverseIpDisplay');
        document.getElementById('forceBridgeToggle').checked = !!forceBridge;
      }
    } catch (_) {
      flash('Failed to load cryptographic token.', 'text-red-400');
    }
  })();

  async function saveForceBridge(enabled) {
    try {
      const r = await fetch('/admin/api/force-bridge?token=' + TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      r.ok
        ? flash(\`Reverse Proxy bridge \${enabled ? 'enabled' : 'disabled'}.\`, 'text-green-400')
        : flash('Failed to save bridge setting.', 'text-red-400');
    } catch (_) {
      flash('Network failure saving bridge setting.', 'text-red-400');
    }
  }

  async function regenerate() {
    const newUuid = crypto.randomUUID();
    applyUuid(newUuid);
    
    const btn = document.getElementById('regenBtn');
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
    const icon = btn.querySelector('svg');
    if (icon) icon.classList.add('animate-spin');
    
    try {
      const r = await fetch('/admin/api?token=' + TOKEN, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ uuid: newUuid }),
      });
      r.ok
        ? flash('UUID successfully regenerated and saved to Edge.', 'text-green-400')
        : flash('Network anomaly — edge rejected update.', 'text-red-400');
    } catch (_) {
      flash('Network failure.', 'text-red-400');
    } finally {
      btn.disabled = false;
      btn.classList.remove('opacity-50', 'cursor-not-allowed');
      const icon = btn.querySelector('svg');
      if (icon) icon.classList.remove('animate-spin');
    }
  }

  async function syncPreferredIps() {
    const btn = document.getElementById('syncPreferredBtn');
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
    const icon = btn.querySelector('svg');
    if (icon) icon.classList.add('animate-spin');

    try {
      const r = await fetch('/admin/api/sync/preferred?token=' + TOKEN, { method: 'POST' });
      if (r.ok) {
        const payload = await r.json();
        flash(\`Hydrated \${payload.count} preferred nodes.\`, 'text-green-400');
        const fetchR = await fetch('/admin/api?token=' + TOKEN);
        if (fetchR.ok) {
          const { ips } = await fetchR.json();
          renderIps(ips, 'ipDisplay');
        }
      } else {
        flash('Preferred IP upstream unresponsive — retaining cached nodes.', 'text-red-400');
      }
    } catch (_) {
      flash('Crawler exception — verify edge connectivity.', 'text-red-400');
    } finally {
      btn.disabled = false;
      btn.classList.remove('opacity-50', 'cursor-not-allowed');
      const icon = btn.querySelector('svg');
      if (icon) icon.classList.remove('animate-spin');
    }
  }

  async function syncReverseIps() {
    const btn = document.getElementById('syncReverseBtn');
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
    const icon = btn.querySelector('svg');
    if (icon) icon.classList.add('animate-spin');

    try {
      const r = await fetch('/admin/api/sync/reverse?token=' + TOKEN, { method: 'POST' });
      if (r.ok) {
        const payload = await r.json();
        flash(\`Hydrated \${payload.count} reverse proxy nodes.\`, 'text-green-400');
        const fetchR = await fetch('/admin/api?token=' + TOKEN);
        if (fetchR.ok) {
          const { reverseIps } = await fetchR.json();
          renderIps(reverseIps, 'reverseIpDisplay');
        }
      } else {
        flash('Reverse proxy upstream unresponsive — retaining cached nodes.', 'text-red-400');
      }
    } catch (_) {
      flash('Crawler exception — verify edge connectivity.', 'text-red-400');
    } finally {
      btn.disabled = false;
      btn.classList.remove('opacity-50', 'cursor-not-allowed');
      const icon = btn.querySelector('svg');
      if (icon) icon.classList.remove('animate-spin');
    }
  }

  async function copyText(el) {
    const text = el.textContent.trim();
    if (!text) return;
    
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error('Clipboard API unavailable');
      }
      flash('URI copied.', 'text-green-400');
    } catch (err) {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "absolute";
      textArea.style.left = "-999999px";
      document.body.prepend(textArea);
      textArea.select();
      
      try {
        document.execCommand('copy');
        flash('URI copied.', 'text-green-400');
      } catch (error) {
        console.error(error);
        flash('Clipboard exception — please copy manually.', 'text-red-400');
      } finally {
        textArea.remove();
      }
    }
  }

  let flashTimeout;
  function flash(msg, cls) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'fixed top-6 right-6 z-50 bg-gray-900 border border-gray-700 shadow-2xl rounded-lg px-6 py-4 text-sm font-medium transform transition-all duration-300 ' + cls;
    
    requestAnimationFrame(() => {
      el.classList.remove('translate-x-32', 'opacity-0');
      el.classList.add('translate-x-0', 'opacity-100');
    });

    if (flashTimeout) clearTimeout(flashTimeout);
    flashTimeout = setTimeout(() => { 
      el.classList.remove('translate-x-0', 'opacity-100'); 
      el.classList.add('translate-x-32', 'opacity-0'); 
    }, 4000);
  }
</script>
</body>
</html>`;
}
