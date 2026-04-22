// ── Admin Portal — presentation and mutation layer ───────────────────────────
// hostname is injected server-side so the subscription URI is always accurate
// without hardcoding any domain into the source code.
//
// The entire UI is compiled as a TypeScript template literal and served
// directly from the Worker's V8 isolate memory — zero external file fetches,
// zero cold-storage round-trips, sub-millisecond TTFB on the edge.
//
// Security model: every request under /admin must carry ?token=<ADMIN_TOKEN>.
// The token is stored as a Cloudflare Worker environment variable (not in KV).

import type { Env } from '../types';
import { getUuid, putUuid, getPreferredIps } from '../lib/kv';
import { generateUuid } from '../lib/utils';
import { aggregatePreferredIps } from '../lib/crawler';

/**
 * Encapsulates all /admin/* routing and API business logic.
 * Enforces the ADMIN_TOKEN authentication boundary.
 */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { method } = request;
  const token = url.searchParams.get('token');

  if (token !== env.ADMIN_TOKEN) {
    console.warn('[ADMIN] 403: token mismatch');
    return new Response('403 Forbidden', { status: 403 });
  }

  // GET /admin/api — return current UUID and preferred IPs
  if (method === 'GET' && url.pathname === '/admin/api') {
    console.log('[ADMIN] GET /admin/api — reading UUID and IPs from KV');
    let uuid = await getUuid(env);
    if (!uuid) {
      uuid = generateUuid();
      await putUuid(env, uuid);
    }
    const ips = await getPreferredIps(env);
    return Response.json({ uuid, ips });
  }

  // POST /admin/api — persist a new UUID sent by the UI
  if (method === 'POST' && url.pathname === '/admin/api') {
    console.log('[ADMIN] POST /admin/api — persisting UUID');
    try {
      const { uuid } = await request.json() as { uuid?: string };
      // Basic RFC-4122 format guard before writing
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

  // POST /admin/api/sync — autonomous crawler trigger
  if (method === 'POST' && url.pathname === '/admin/api/sync') {
    console.log('[ADMIN] POST /admin/api/sync — starting IP crawler');
    const count = await aggregatePreferredIps(env);
    console.log(`[CRAWLER] Completed: ${count} IPs written to KV`);
    if (count > 0) {
      return new Response(JSON.stringify({ status: 'ok', count }), { status: 200 });
    }
    return new Response('Sync Failed — Upstreams Offline', { status: 502 });
  }

  // GET /admin — serve the portal HTML
  console.log('[ADMIN] GET /admin — rendering portal HTML');
  return new Response(renderAdminUI(token || '', url.hostname), {
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
    background: #09090b radial-gradient(circle at top right, rgba(59,130,246,.10), transparent 40%),
                radial-gradient(circle at bottom left, rgba(139,92,246,.10), transparent 40%);
    color: #f4f4f5;
  }
  .glass-panel {
    background: rgba(24, 24, 27, 0.72);
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
      <button class="bg-blue-900 bg-opacity-20 text-blue-400 border border-blue-900 hover:bg-opacity-40 transition-colors rounded-lg px-6 flex-shrink-0 flex items-center justify-center text-2xl" id="regenBtn" title="Regenerate & Save Token" onclick="regenerate()">⟳</button>
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
      <button class="bg-purple-900 bg-opacity-20 text-purple-400 border border-purple-900 hover:bg-opacity-40 transition-colors rounded-lg px-6 flex-shrink-0 flex items-center justify-center text-2xl" id="syncBtn" title="Force Sync Upstream Nodes" onclick="syncIps()">⟳</button>
    </div>
  </div>

  <hr class="border-gray-700 border-opacity-40">

  <!-- ── Base64 Subscription Endpoint ──────────────────────── -->
  <div class="flex flex-col gap-2">
    <label class="text-xs uppercase tracking-wider font-semibold text-gray-400">V2Ray/Clash Base64 Subscription</label>
    <div class="flex gap-2 items-stretch">
      <div class="mono-box flex-1 px-4 py-3 rounded-lg text-gray-300 font-mono text-sm cursor-pointer truncate" id="subLink" title="Click to copy" onclick="copyText(this)"></div>
      <button class="bg-green-900 bg-opacity-20 text-green-400 border border-green-900 hover:bg-opacity-40 transition-colors font-semibold py-2 px-4 rounded-lg text-sm" onclick="copyText(document.getElementById('subLink'))">Copy</button>
    </div>
    <div class="flex justify-center py-4">
      <div id="qr" class="bg-white p-3 rounded-xl shadow-lg"></div>
    </div>
  </div>

</div>

<!-- Toast Notification -->
<div id="status" class="fixed top-6 right-6 z-50 bg-gray-900 border border-gray-700 shadow-2xl rounded-lg px-6 py-4 text-sm font-medium transform transition-all duration-300 translate-x-32 opacity-0 pointer-events-none"></div>

<script>
  const HOST  = '\${hostname}';
  const TOKEN = '\${token}';

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

  function renderIps(ips) {
    const container = document.getElementById('ipDisplay');
    if (!ips || ips.length === 0) {
      container.innerHTML = '<span class="italic text-gray-500">No IPs cached. Please renew.</span>';
      return;
    }
    container.innerHTML = ips.map(ip => \`<div class="truncate text-gray-300 border-b border-gray-700 border-opacity-40 last:border-0 py-1">\${ip}</div>\`).join('');
  }

  (async () => {
    try {
      const r = await fetch('/admin/api?token=' + TOKEN);
      if (r.ok) {
        const { uuid, ips } = await r.json();
        if (uuid) applyUuid(uuid);
        if (ips) renderIps(ips);
      }
    } catch (_) {
      flash('Failed to load cryptographic token.', 'text-red-400');
    }
  })();

  async function regenerate() {
    const newUuid = crypto.randomUUID();
    applyUuid(newUuid);
    
    const btn = document.getElementById('regenBtn');
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed', 'animate-spin');
    
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
      btn.classList.remove('opacity-50', 'cursor-not-allowed', 'animate-spin');
    }
  }

  async function syncIps() {
    const btn = document.getElementById('syncBtn');
    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed', 'animate-spin');
    
    try {
      const r = await fetch('/admin/api/sync?token=' + TOKEN, { method: 'POST' });
      if (r.ok) {
        const payload = await r.json();
        flash(\`Hydrated subscription with \${payload.count} prime nodes.\`, 'text-green-400');
        // Fetch and render updated ips
        const fetchR = await fetch('/admin/api?token=' + TOKEN);
        if (fetchR.ok) {
          const { ips } = await fetchR.json();
          renderIps(ips);
        }
      } else {
        flash('Upstream matrices unresponsive — retaining cached nodes.', 'text-red-400');
      }
    } catch (_) {
      flash('Crawler exception — verify edge connectivity.', 'text-red-400');
    } finally {
      btn.disabled = false;
      btn.classList.remove('opacity-50', 'cursor-not-allowed', 'animate-spin');
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
      flash('URI copied to clipboard buffer.', 'text-green-400');
    } catch (err) {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      textArea.style.position = "absolute";
      textArea.style.left = "-999999px";
      document.body.prepend(textArea);
      textArea.select();
      
      try {
        document.execCommand('copy');
        flash('URI copied via fallback mechanism.', 'text-green-400');
      } catch (error) {
        console.error(error);
        flash('Clipboard exception — select manually.', 'text-red-400');
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
