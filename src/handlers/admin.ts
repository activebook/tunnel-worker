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

/**
 * Encapsulates the /admin presentation layer.
 */
export async function handleAdmin(request: Request, env: Env): Promise<Response> {
  const { authorized, response } = await verifyAdminAuth(request, env);
  if (!authorized) return response!;

  const url = new URL(request.url);
  const queryToken = url.searchParams.get('token')!;

  // ── Authenticated Route: Serve Portal HTML ─────────────────────────────────
  console.log('[ADMIN] GET /admin — rendering portal HTML');
  return new Response(renderAdminUI(queryToken, url.hostname), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export function renderAdminUI(token: string, hostname: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Edge Tunnel</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
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
  .switch {
    position: relative;
    display: inline-block;
    width: 44px;
    height: 24px;
  }
  .switch input { opacity: 0; width: 0; height: 0; }
  .slider {
    position: absolute;
    cursor: pointer;
    top: 0; left: 0; right: 0; bottom: 0;
    background-color: #3f3f46;
    transition: .4s;
    border-radius: 24px;
  }
  .slider:before {
    position: absolute;
    content: "";
    height: 18px;
    width: 18px;
    left: 3px;
    bottom: 3px;
    background-color: white;
    transition: .4s;
    border-radius: 50%;
  }
  input:checked + .slider { background-color: #6366f1; }
  input:checked + .slider:before { transform: translateX(20px); }
  .custom-scroll::-webkit-scrollbar { width: 6px; }
  .custom-scroll::-webkit-scrollbar-track { background: transparent; }
  .custom-scroll::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 10px;
  }
  .custom-scroll::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.2); }
  .latency-low { color: #10b981; }
  .latency-mid { color: #f59e0b; }
  .latency-high { color: #f97316; }
  .latency-very-high { color: #ef4444; }
  .latency-unknown { color: #71717a; }

  /* Tab System */
  .tab-btn {
    position: relative;
    padding-bottom: 0.5rem;
    color: #94a3b8;
    transition: all 0.3s;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
  }
  .tab-btn:hover { color: #f1f5f9; }
  .tab-btn.active { color: #6366f1; }
  .tab-btn.active::after {
    content: "";
    position: absolute;
    bottom: 0;
    left: 0;
    width: 100%;
    height: 2px;
    background: #6366f1;
    border-radius: 2px;
  }
  .tab-content { display: none; }
  .tab-content.active { display: block; animation: fadeIn 0.3s ease-out; }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
</style>
</head>
<body class="min-h-screen flex items-center justify-center p-4">

<div class="glass-panel rounded-2xl p-6 w-full max-w-sm flex flex-col gap-4">

  <header class="flex flex-col gap-5">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Edge Tunnel</h1>
        <p class="text-gray-400 text-xs">Optimized edge for seamless connectivity</p>
      </div>
      <div class="text-[10px] px-2 py-1 rounded bg-indigo-500 bg-opacity-10 text-indigo-300 border border-indigo-500 border-opacity-20 font-mono">v1.3.0</div>
    </div>

    <nav class="flex justify-between border-b border-gray-700 border-opacity-40">
      <button class="tab-btn active" onclick="switchTab('identity', this)">Link</button>
      <button class="tab-btn" onclick="switchTab('anycast', this)">Anycast</button>
      <button class="tab-btn" onclick="switchTab('bridge', this)">Bridge</button>
      <button class="tab-btn" onclick="switchTab('settings', this)">Settings</button>
    </nav>
  </header>

  <div id="tab-identity" class="tab-content active space-y-4">
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <div>
          <label class="text-xs uppercase tracking-wider font-semibold text-gray-400">UUID</label>
          <p class="text-[10px] text-gray-500 mt-0.5">Authentication token for client-side.</p>
        </div>
        <button class="bg-indigo-500 bg-opacity-10 hover:bg-opacity-20 text-indigo-300 border border-indigo-500 border-opacity-20 transition-all rounded-lg w-8 h-8 flex items-center justify-center" id="regenIdBtn" title="Regenerate" onclick="regenerate()">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
      <div class="mono-box px-3 py-2 rounded-xl text-gray-300 font-mono text-xs cursor-pointer truncate" id="uuidDisplay" onclick="copyText(this)"></div>
    </div>

    <div class="flex flex-col gap-2">
      <div>
        <label class="text-xs uppercase tracking-wider font-semibold text-gray-400">Subscription Link</label>
      </div>
      <div class="flex gap-2 items-stretch">
        <div class="mono-box flex-1 px-3 py-2 rounded-xl text-gray-300 font-mono text-xs cursor-pointer truncate" id="subLink" onclick="copyText(this)"></div>
        <button class="bg-indigo-500 bg-opacity-10 hover:bg-opacity-20 text-indigo-300 border border-indigo-500 border-opacity-20 transition-all rounded-lg w-10 flex-shrink-0 flex items-center justify-center" onclick="copyText(document.getElementById('subLink'))">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
      </div>
      <div class="flex justify-center py-2">
        <div id="qr" class="bg-white p-2 rounded-lg shadow-lg"></div>
      </div>
    </div>
  </div>

  <!-- ── Tab 2: Anycast Matrix ────────────────────────────────────────── -->
  <div id="tab-anycast" class="tab-content space-y-4">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2 min-w-0">
        <label class="text-[11px] uppercase tracking-widest font-semibold text-gray-300 whitespace-nowrap">Anycast Matrix</label>
        <span class="text-[10px] text-indigo-400 font-mono" id="preferredCount">0</span>
      </div>
      <button class="bg-indigo-500 bg-opacity-10 hover:bg-opacity-20 text-indigo-400 border border-indigo-500 border-opacity-20 rounded-lg w-8 h-8 flex items-center justify-center transition-all shadow-sm flex-shrink-0" id="syncPreferredBtn" title="Sync Matrix" onclick="syncPreferredIps()">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>
    <p class="text-[10px] text-gray-500 leading-tight -mt-1 italic">Optimized CF Anycast nodes for direct edge routing.</p>
    <div class="mono-box rounded-2xl p-3 custom-scroll max-h-[320px] overflow-y-auto shadow-inner">
      <div class="space-y-1.5" id="ipDisplay"></div>
    </div>
  </div>

  <!-- ── Tab 3: Bridge Matrix ─────────────────────────────────────────── -->
  <div id="tab-bridge" class="tab-content space-y-4">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2 min-w-0">
        <label class="text-[11px] uppercase tracking-widest font-semibold text-gray-300 whitespace-nowrap">Bridge Matrix</label>
        <span class="text-[10px] text-indigo-400 font-mono" id="reverseCount">0</span>
      </div>
      <button class="bg-indigo-500 bg-opacity-10 hover:bg-opacity-20 text-indigo-400 border border-indigo-500 border-opacity-20 rounded-lg w-8 h-8 flex items-center justify-center transition-all shadow-sm flex-shrink-0" id="syncReverseBtn" title="Sync Matrix" onclick="syncReverseIps()">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>
    <p class="text-[10px] text-gray-500 leading-tight -mt-1 italic">Bridge nodes are used to bypass Cloudflare's internal loopback restrictions.</p>
    <div class="mono-box rounded-2xl p-3 custom-scroll max-h-[320px] overflow-y-auto shadow-inner">
      <div class="space-y-1.5" id="reverseIpDisplay"></div>
    </div>
  </div>

  <!-- ── Tab 4: Settings ──────────────────────────────────────────────── -->
  <div id="tab-settings" class="tab-content space-y-5">
    <div class="space-y-3">
      <label class="text-[10px] uppercase tracking-widest font-semibold text-gray-500">Tunnel Policy</label>
      <div class="flex items-center justify-between p-4 mono-box rounded-2xl shadow-inner">
        <div>
          <p class="text-sm font-medium text-gray-200">Use Reverse Bridge Anyway</p>
          <p class="text-[10px] text-gray-500 mt-0.5">Bypass direct connect for all traffic.</p>
        </div>
        <label class="switch ml-4 flex-shrink-0">
          <input type="checkbox" id="forceBridgeToggle" onchange="saveForceBridge(this.checked)">
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <div class="p-4 rounded-2xl bg-indigo-500 bg-opacity-5 border border-indigo-500 border-opacity-10">
      <p class="text-[10px] text-indigo-300 font-medium leading-relaxed italic">
        Warning: Forcing the Reverse Bridge bypasses direct anycast routing, funneling all traffic through secure relay nodes. This is intended for high-restriction environments. If you are unsure of the implications, please do not modify this policy.
      </p>
    </div>
  </div>

</div>

<div id="status" class="fixed bottom-8 left-1/2 transform -translate-x-1/2 z-50 bg-gray-900 border border-gray-700 shadow-2xl rounded-full px-6 py-2.5 text-[11px] font-medium transition-all duration-300 opacity-0 pointer-events-none scale-95"></div>

<script>
  const HOST  = '${hostname}';
  const TOKEN = '${token}';

  let pendingUuid = '';
  let qrInstance  = null;

  function switchTab(tabId, btn) {
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-' + tabId).classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }

  function applyUuid(uuid) {
    pendingUuid = uuid;
    document.getElementById('uuidDisplay').textContent = uuid;
    const SUB_URI = \`https://\${HOST}/sub?token=\${uuid}\`;
    document.getElementById('subLink').textContent = SUB_URI;
    const qrEl = document.getElementById('qr');
    qrEl.innerHTML = '';
    qrInstance = new QRCode(qrEl, {
      text: SUB_URI,
      width: 140, height: 140,
      colorDark: '#000000', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
  }

  function renderIps(nodes, containerId) {
    const container = document.getElementById(containerId);
    const countId = containerId === 'ipDisplay' ? 'preferredCount' : 'reverseCount';
    const countEl = document.getElementById(countId);
    
    if (!nodes || nodes.length === 0) {
      container.innerHTML = '<span class="italic text-gray-500 text-[11px] block py-4 text-center">No cached nodes found.</span>';
      if (countEl) countEl.textContent = '0 Nodes Available';
      return;
    }

    if (countEl) countEl.textContent = nodes.length;
    container.innerHTML = nodes.map(node => {
      const ipStr = typeof node === 'string' ? node : node.ip;
      const latency = typeof node === 'string' ? null : node.latency;
      let latencyClass = '';
      let displayLatency = latency;

      if (latency !== null) {
        if (latency === 0) {
          latencyClass = 'latency-unknown';
          displayLatency = 'Unknown';
        } else {
          if (latency <= 100) latencyClass = 'latency-low';
          else if (latency <= 500) latencyClass = 'latency-mid';
          else if (latency <= 1000) latencyClass = 'latency-high';
          else latencyClass = 'latency-very-high';
        }
      }

      const latencyStr = latency !== null ? \`<span class="text-[10px] ml-2 font-mono \${latencyClass} opacity-90">[\${typeof displayLatency === 'number' ? Math.round(displayLatency) + 'ms' : displayLatency}]</span>\` : '';
      return \`<div class="flex items-center justify-between py-2 border-b border-gray-800 border-opacity-50 last:border-0 hover:bg-indigo-500 hover:bg-opacity-[0.05] transition-colors px-1 cursor-default">
                <span class="text-[11px] font-mono text-gray-300 truncate mr-2">\${ipStr}</span>
                \${latencyStr}
              </div>\`;
    }).join('');
  }

  (async () => {
    try {
      const r = await fetch('/services/settings?token=' + TOKEN);
      if (r.ok) {
        const { uuid, ips, reverseIps, forceBridge } = await r.json();
        if (uuid) applyUuid(uuid);
        if (ips) renderIps(ips, 'ipDisplay');
        if (reverseIps) renderIps(reverseIps, 'reverseIpDisplay');
        document.getElementById('forceBridgeToggle').checked = !!forceBridge;
      }
    } catch (_) {}
  })();

  async function saveForceBridge(enabled) {
    try {
      const r = await fetch('/services/policy?token=' + TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      r.ok ? flash(\`Policy updated: Force Bridge \${enabled ? 'ON' : 'OFF'}\`, 'text-indigo-300') : flash('Update failed', 'text-red-400');
    } catch (_) {}
  }

  async function regenerate() {
    const newUuid = crypto.randomUUID();
    applyUuid(newUuid);
    const btn = document.getElementById('regenIdBtn');
    btn.disabled = true;
    btn.classList.add('opacity-50');
    const icon = btn.querySelector('svg');
    if (icon) icon.classList.add('animate-spin');
    
    try {
      const r = await fetch('/services/uuid?token=' + TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: newUuid }),
      });
      r.ok ? flash('UUID updated successfully', 'text-green-400') : flash('Failed to update edge', 'text-red-400');
    } finally {
      btn.disabled = false;
      btn.classList.remove('opacity-50');
      if (icon) icon.classList.remove('animate-spin');
    }
  }

  async function syncPreferredIps() {
    const btn = document.getElementById('syncPreferredBtn');
    btn.disabled = true;
    const icon = btn.querySelector('svg');
    if (icon) icon.classList.add('animate-spin');

    try {
      const r = await fetch('/services/preferred?token=' + TOKEN, { method: 'POST' });
      if (r.ok) {
        flash('Anycast matrix synchronized', 'text-green-400');
        const res = await fetch('/services/settings?token=' + TOKEN);
        if (res.ok) {
          const { ips } = await res.json();
          renderIps(ips, 'ipDisplay');
        }
      } else flash('Sync failed', 'text-red-400');
    } finally {
      btn.disabled = false;
      if (icon) icon.classList.remove('animate-spin');
    }
  }

  async function syncReverseIps() {
    const btn = document.getElementById('syncReverseBtn');
    btn.disabled = true;
    const icon = btn.querySelector('svg');
    if (icon) icon.classList.add('animate-spin');

    try {
      const r = await fetch('/services/reverse?token=' + TOKEN, { method: 'POST' });
      if (r.ok) {
        flash('Bridge matrix synchronized', 'text-green-400');
        const res = await fetch('/services/settings?token=' + TOKEN);
        if (res.ok) {
          const { reverseIps } = await res.json();
          renderIps(reverseIps, 'reverseIpDisplay');
        }
      } else flash('Sync failed', 'text-red-400');
    } finally {
      btn.disabled = false;
      if (icon) icon.classList.remove('animate-spin');
    }
  }

  async function copyText(el) {
    const text = el.textContent.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flash('Copied to clipboard', 'text-indigo-300');
    } catch (err) {
      flash('Copy failed', 'text-red-400');
    }
  }

  let flashTimeout;
  function flash(msg, cls) {
    const el = document.getElementById('status');
    el.textContent = msg;
    
    // Reset classes for entry
    el.className = 'fixed bottom-8 left-1/2 transform -translate-x-1/2 z-50 bg-gray-900 border border-gray-700 shadow-2xl rounded-full px-6 py-2.5 text-[11px] font-medium transition-all duration-300 pointer-events-none ' + cls;
    
    // Trigger entry
    requestAnimationFrame(() => {
      el.classList.add('opacity-100', 'scale-100');
      el.classList.remove('opacity-0', 'scale-95');
    });

    if (flashTimeout) clearTimeout(flashTimeout);
    flashTimeout = setTimeout(() => { 
      el.classList.remove('opacity-100', 'scale-100'); 
      el.classList.add('opacity-0', 'scale-95'); 
    }, 3000);
  }
</script>
</body>
</html>`;
}
