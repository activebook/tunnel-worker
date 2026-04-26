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
import pkg from '../../package.json';

// Injected by esbuild define in production; falls back to pkg.version in dev
const __APP_VERSION__ = pkg.version;
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : pkg.version;


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
  .custom-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
  .custom-scroll::-webkit-scrollbar-track { background: transparent; }
  .custom-scroll::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.1);
    border-radius: 10px;
  }
  .hidden-scroll::-webkit-scrollbar { display: none; }
  .hidden-scroll { -ms-overflow-style: none; scrollbar-width: none; }
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
  .region-select {
    background: rgba(20, 20, 30, 0.8);
    border: 1px solid rgba(99, 102, 241, 0.2);
    border-radius: 0.625rem;
    color: #d1d5db;
    font-size: 0.75rem;
    padding: 0.4rem 0.65rem;
    outline: none;
    cursor: pointer;
    transition: border-color 0.2s;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236366f1' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.6rem center;
    padding-right: 1.75rem;
  }
  .region-select:hover, .region-select:focus {
    border-color: rgba(99, 102, 241, 0.5);
  }
  .region-select option { background: #1e1e2a; color: #d1d5db; }

  /* ── Bootstrap Overlay ──────────────────────────────────────────────── */
  #bootstrap-overlay {
    position: fixed;
    inset: 0;
    z-index: 9999;
    background: #020617;
    background-image: 
      radial-gradient(circle at 0% 0%, rgba(30, 64, 175, 0.2) 0%, transparent 50%),
      radial-gradient(circle at 100% 100%, rgba(76, 29, 149, 0.2) 0%, transparent 50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2rem;
    transition: opacity 0.6s ease-out, visibility 0.6s ease-out;
  }
  #bootstrap-overlay.hidden {
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
  }
  .bootstrap-spinner {
    width: 64px;
    height: 64px;
    border: 3px solid rgba(99, 102, 241, 0.2);
    border-top-color: #6366f1;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .bootstrap-pulse {
    animation: pulse 2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.6; }
    50% { opacity: 1; }
  }
  .bootstrap-step {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1.5rem;
    background: rgba(99, 102, 241, 0.1);
    border: 1px solid rgba(99, 102, 241, 0.2);
    border-radius: 0.75rem;
    transition: all 0.3s ease;
  }
  .bootstrap-step.pending {
    opacity: 0.4;
  }
  .bootstrap-step.active {
    opacity: 1;
    border-color: rgba(99, 102, 241, 0.5);
    background: rgba(99, 102, 241, 0.15);
  }
  .bootstrap-step.done {
    opacity: 0.7;
    border-color: rgba(16, 185, 129, 0.4);
    background: rgba(16, 185, 129, 0.1);
  }
  .bootstrap-step.error {
    opacity: 1;
    border-color: rgba(239, 68, 68, 0.5);
    background: rgba(239, 68, 68, 0.1);
  }
  .step-icon {
    width: 20px;
    height: 20px;
    flex-shrink: 0;
  }
  .step-icon.pending { color: #6366f1; }
  .step-icon.active { color: #6366f1; animation: spin 1s linear infinite; }
  .step-icon.done { color: #10b981; }
  .step-icon.error { color: #ef4444; }
</style>
</head>
<body class="min-h-screen flex items-center justify-center p-4">

<!-- ── Bootstrap Overlay: shown only on first visit ───────────────────── -->
<div id="bootstrap-overlay" class="${needsBootstrap ? '' : 'hidden'}">
  <div class="text-center mb-4">
    <h1 class="text-3xl font-semibold tracking-tight mb-2">Edge Tunnel</h1>
    <p class="text-gray-400 text-sm bootstrap-pulse">Initializing tunnel matrix...</p>
  </div>

  <div class="bootstrap-spinner"></div>

  <div class="flex flex-col gap-3 w-full max-w-xs">
    <div class="bootstrap-step active" id="step-anycast">
      <svg class="step-icon active" id="icon-anycast" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z"/>
      </svg>
      <span id="text-anycast" class="text-sm text-gray-200">Probing Anycast Matrix</span>
    </div>

    <div class="bootstrap-step pending" id="step-bridge">
      <svg class="step-icon pending" id="icon-bridge" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/>
      </svg>
      <span id="text-bridge" class="text-sm text-gray-400">Syncing Bridge Matrix</span>
    </div>
  </div>

  <p id="bootstrap-status" class="text-xs text-gray-500 mt-4">Preparing network probes...</p>
</div>

<div class="glass-panel rounded-2xl p-6 w-full max-w-sm flex flex-col gap-4">

  <header class="flex flex-col gap-5">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Edge Tunnel</h1>
        <p class="text-gray-400 text-xs">Optimized edge for seamless connectivity</p>
      </div>
      <div class="text-[10px] px-2 py-1 rounded bg-indigo-500 bg-opacity-10 text-indigo-300 border border-indigo-500 border-opacity-20 font-mono">v${APP_VERSION}</div>
    </div>

    <nav class="flex justify-between border-b border-gray-700 border-opacity-40 overflow-x-auto hidden-scroll pb-1 gap-2">
      <button class="tab-btn active whitespace-nowrap" onclick="switchTab('identity', this)">Link</button>
      <button class="tab-btn whitespace-nowrap" onclick="switchTab('anycast', this)">Anycast</button>
      <button class="tab-btn whitespace-nowrap" onclick="switchTab('bridge', this)">Bridge</button>
      <button class="tab-btn whitespace-nowrap" onclick="switchTab('diagnostics', this)">Network</button>
      <button class="tab-btn whitespace-nowrap" onclick="switchTab('settings', this)">Settings</button>
      <button class="tab-btn whitespace-nowrap" onclick="switchTab('usage', this)">Usage</button>
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
    <select id="bridgeRegionSelect" class="region-select w-full">
      <option value="all">🌐 All Regions</option>
      <option value="auto">⭐ Global Best</option>
      <option value="hk">🇭🇰 Hong Kong</option>
      <option value="sg">🇸🇬 Singapore</option>
      <option value="jp">🇯🇵 Japan</option>
      <option value="kr">🇰🇷 South Korea</option>
      <option value="us">🇺🇸 United States</option>
      <option value="ca">🇨🇦 Canada</option>
      <option value="gb">🇬🇧 United Kingdom</option>
      <option value="de">🇩🇪 Germany</option>
      <option value="fr">🇫🇷 France</option>
      <option value="nl">🇳🇱 Netherlands</option>
      <option value="se">🇸🇪 Sweden</option>
      <option value="fi">🇫🇮 Finland</option>
      <option value="pl">🇵🇱 Poland</option>
      <option value="ch">🇨🇭 Switzerland</option>
      <option value="lv">🇱🇻 Latvia</option>
      <option value="ru">🇷🇺 Russia</option>
      <option value="in">🇮🇳 India</option>
    </select>
    <p class="text-[10px] text-gray-500 leading-tight -mt-1 italic">Bridge nodes are used to bypass Cloudflare's internal loopback restrictions.</p>
    <div class="mono-box rounded-2xl p-3 custom-scroll max-h-[320px] overflow-y-auto shadow-inner">
      <div class="space-y-1.5" id="reverseIpDisplay"></div>
    </div>
  </div>

  <!-- ── Tab 4: Settings ──────────────────────────────────────────────── -->
  <div id="tab-settings" class="tab-content space-y-5">
    <div class="space-y-3">
      <label class="text-[10px] uppercase tracking-widest font-semibold text-gray-500">Routing Policy</label>
      <div class="mono-box rounded-2xl shadow-inner p-1.5 grid grid-cols-1 sm:grid-cols-3 gap-1.5">
        <button id="policy-AUTO" onclick="setPolicy('AUTO')" class="policy-btn py-3 px-2 rounded-xl text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-white hover:bg-opacity-5 transition-all flex flex-col items-center justify-center gap-1.5 border border-transparent">
          <span class="flex items-center gap-1.5 text-gray-300">
            <span class="text-base leading-none">🤖</span>
            <span class="leading-none">Auto Selection</span>
          </span>
          <span class="text-[8px] text-gray-500 font-normal tracking-widest uppercase leading-none">Direct → Bridge</span>
        </button>
        <button id="policy-BRIDGE" onclick="setPolicy('BRIDGE')" class="policy-btn py-3 px-2 rounded-xl text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-white hover:bg-opacity-5 transition-all flex flex-col items-center justify-center gap-1.5 border border-transparent">
          <span class="flex items-center gap-1.5 text-gray-300">
            <span class="text-base leading-none">🔗</span>
            <span class="leading-none">Bridge Anyway</span>
          </span>
          <span class="text-[8px] text-gray-500 font-normal tracking-widest uppercase leading-none">Bridge All of them</span>
        </button>
        <button id="policy-DIRECT" onclick="setPolicy('DIRECT')" class="policy-btn py-3 px-2 rounded-xl text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-white hover:bg-opacity-5 transition-all flex flex-col items-center justify-center gap-1.5 border border-transparent">
          <span class="flex items-center gap-1.5 text-gray-300">
            <span class="text-base leading-none">⚡</span>
            <span class="leading-none">Direct Only</span>
          </span>
          <span class="text-[8px] text-gray-500 font-normal tracking-widest uppercase leading-none">No Fallback</span>
        </button>
      </div>
    </div>

    <div class="p-4 rounded-2xl bg-indigo-500 bg-opacity-5 border border-indigo-500 border-opacity-10" id="policyDescription">
      <div class="text-[10px] text-indigo-300 font-medium leading-relaxed italic">
        Loading policy description...
      </div>
    </div>
  </div>

  <!-- ── Tab 5: Diagnostics ────────────────────────────────────────────── -->
  <div id="tab-diagnostics" class="tab-content space-y-5">
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <label class="text-[10px] uppercase tracking-widest font-semibold text-gray-500">IP Identity</label>
        <button class="bg-indigo-500 bg-opacity-10 hover:bg-opacity-20 text-indigo-400 border border-indigo-500 border-opacity-20 rounded-lg w-8 h-8 flex items-center justify-center transition-all shadow-sm flex-shrink-0" id="refreshIpBtn" title="Refresh Identity" onclick="fetchIpInfo()">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
      <div class="mono-box rounded-2xl p-4 shadow-inner grid grid-cols-2 gap-4 text-xs">
        <div><span class="text-gray-500 block mb-1">IP Address</span><span id="diagIp" class="text-gray-200 font-mono">Loading...</span></div>
        <div><span class="text-gray-500 block mb-1">Location</span><span id="diagLoc" class="text-gray-200">Loading...</span></div>
        <div><span class="text-gray-500 block mb-1">ASN</span><span id="diagAsn" class="text-gray-200 font-mono">Loading...</span></div>
        <div class="overflow-hidden"><span class="text-gray-500 block mb-1">ASN Owner</span><span id="diagOrg" class="text-gray-200 truncate block">Loading...</span></div>
        <div><span class="text-gray-500 block mb-1">Colo</span><span id="diagColo" class="text-gray-200 font-mono">Loading...</span></div>
        <div><span class="text-gray-500 block mb-1">ISP</span><span id="diagType" class="text-gray-200 truncate block">Loading...</span></div>
      </div>
    </div>

    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <label class="text-[10px] uppercase tracking-widest font-semibold text-gray-500">Speedtest</label>
        <button id="speedtestBtn" class="bg-emerald-500 bg-opacity-10 hover:bg-opacity-20 text-emerald-400 border border-emerald-500 border-opacity-20 rounded-lg px-3 h-7 flex items-center justify-center transition-all shadow-sm text-[11px] font-semibold" onclick="runSpeedtest()">Start Test</button>
      </div>
      <div class="mono-box rounded-2xl p-4 shadow-inner flex flex-col items-center justify-center min-h-[80px]">
        <div class="text-2xl font-semibold text-gray-200" id="speedResult">-- <span class="text-sm text-gray-500 font-normal">Mbps</span></div>
        <div class="text-[10px] text-gray-400 mt-1 text-center" id="speedStatus">Ready</div>
      </div>
    </div>
  </div>

  <!-- ── Tab 6: Usage ──────────────────────────────────────────────────── -->
  <div id="tab-usage" class="tab-content space-y-4">
    <div id="telemetry-auth-section" class="flex flex-col gap-3">
      <div class="p-4 rounded-2xl bg-orange-500 bg-opacity-5 border border-orange-500 border-opacity-10 mb-2">
        <h3 class="text-sm font-semibold text-orange-400 mb-1">Usage Dashboard</h3>
        <p class="text-[10px] text-orange-200 opacity-80 leading-relaxed">
          Cloudflare automatically tracks your proxy usage. To view these metrics, provide your Account ID <span class="bg-white bg-opacity-10 text-white px-1.5 py-0.5 rounded font-medium ml-1">On Worker's page: Account Details</span> and a Read-Only API Token <span class="bg-white bg-opacity-10 text-white px-1.5 py-0.5 rounded font-medium ml-1">Perms: Account.Workers Scripts (Read)</span>.
        </p>
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-[10px] uppercase tracking-widest font-semibold text-gray-500 pl-1">Account ID</label>
        <input type="text" id="telemetryAccountId" class="mono-box px-3 py-2.5 rounded-xl text-gray-200 text-xs w-full focus:outline-none focus:ring-1 focus:ring-indigo-500" placeholder="Paste your Account ID here">
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-[10px] uppercase tracking-widest font-semibold text-gray-500 pl-1">API Token</label>
        <input type="password" id="telemetryApiToken" class="mono-box px-3 py-2.5 rounded-xl text-gray-200 text-xs w-full focus:outline-none focus:ring-1 focus:ring-indigo-500" placeholder="Paste your API Token here">
      </div>
      <button class="bg-indigo-500 hover:bg-indigo-600 text-white rounded-xl py-2.5 text-xs font-semibold transition-colors mt-2 shadow-lg shadow-indigo-500/20" id="telemetryAuthBtn" onclick="saveTelemetryAuth()">Connect Cloudflare API</button>
    </div>

    <div id="telemetry-dash-section" class="hidden flex-col gap-4">
      <div class="flex items-center justify-between">
        <label class="text-[11px] uppercase tracking-widest font-semibold text-gray-300">Live Usage</label>
        <button class="bg-indigo-500 bg-opacity-10 hover:bg-opacity-20 text-indigo-400 border border-indigo-500 border-opacity-20 rounded-lg w-7 h-7 flex items-center justify-center transition-all shadow-sm flex-shrink-0" title="Refresh" onclick="loadTelemetry()">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
      <div class="mono-box rounded-2xl p-5 shadow-inner space-y-5">
        <div>
          <div class="flex justify-between items-baseline mb-2">
            <span class="text-xs font-medium text-gray-300">Requests today</span>
            <span class="text-xs font-mono text-gray-400"><span id="metric-requests" class="text-indigo-300 font-semibold">0</span> <span class="text-[10px]">/ 100,000</span></span>
          </div>
          <div class="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
            <div id="metric-requests-bar" class="bg-orange-500 h-2 rounded-full transition-all duration-1000" style="width: 0%"></div>
          </div>
        </div>
        <div class="pt-4 border-t border-gray-700 border-opacity-50 flex justify-between items-baseline">
          <span class="text-xs font-medium text-gray-300">CPU time</span>
          <span class="text-sm font-mono text-gray-200" id="metric-cpu">0 <span class="text-[10px] text-gray-500 font-normal">ms</span></span>
        </div>
      </div>
    </div>
  </div>

</div>

<div id="status" class="fixed bottom-8 left-1/2 transform -translate-x-1/2 z-50 bg-gray-900 border border-gray-700 shadow-2xl rounded-full px-6 py-2.5 text-[11px] font-medium transition-all duration-300 opacity-0 pointer-events-none scale-95"></div>

<script>
  const HOST  = '${hostname}';
  const TOKEN = '${token}';
  const NEEDS_BOOTSTRAP = ${needsBootstrap};

  let pendingUuid = '';
  let qrInstance  = null;

  let ipInfoLoaded = false;

  // ── Bootstrap: First-time initialization ────────────────────────────────
  // Runs exactly once on first admin visit to populate empty KV matrices.
  async function bootstrap() {
    const overlay = document.getElementById('bootstrap-overlay');
    const status  = document.getElementById('bootstrap-status');

    function setStep(id, state, text) {
      const el    = document.getElementById('step-' + id);
      const icon  = document.getElementById('icon-' + id);
      const txtEl = document.getElementById('text-' + id);
      el.className = 'bootstrap-step ' + state;
      icon.className = 'step-icon ' + state;
      if (txtEl) txtEl.textContent = text;
    }

    function setStatus(msg) {
      if (status) status.textContent = msg;
    }

    const probeTimeout = 4000; // 4s per IP probe

    // ── Step 1: Anycast Matrix ─────────────────────────────────────────
    setStatus('Discovering edge nodes...');
    try {
      const cRes = await fetch('/services/preferred?token=' + TOKEN);
      if (!cRes.ok) throw new Error('Failed to fetch candidates');
      const { candidates } = await cRes.json();
      if (!candidates?.length) throw new Error('No candidates returned');

      setStatus('Probing ' + candidates.length + ' edge nodes...');

      const results = await Promise.allSettled(
        candidates.map(async (ip) => {
          const t0 = performance.now();
          try {
            await fetch('https://' + ip + '/', {
              mode: 'no-cors',
              cache: 'no-store',
              signal: AbortSignal.timeout(probeTimeout),
            });
            return { ip, latency: Math.round(performance.now() - t0) };
          } catch (e) {
            const latency = Math.round(performance.now() - t0);
            if (e.name === 'AbortError' || latency >= probeTimeout - 50) {
              return { ip, latency: -1 };
            }
            return { ip, latency: Math.max(1, latency - 10) };
          }
        })
      );

      const ranked = results
        .map(r => r.status === 'fulfilled' ? r.value : null)
        .filter(Boolean)
        .sort((a, b) => {
          if (a.latency < 0 && b.latency >= 0) return 1;
          if (b.latency < 0 && a.latency >= 0) return -1;
          return a.latency - b.latency;
        });

      const saveRes = await fetch('/services/preferred/ranked?token=' + TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ranked),
      });

      if (!saveRes.ok) throw new Error('Failed to persist anycast rankings');
      setStep('anycast', 'done', 'Anycast: ' + ranked.filter(r => r.latency >= 0).length + ' nodes ready');
    } catch (err) {
      setStep('anycast', 'error', 'Anycast sync failed');
      setStatus('Error: ' + err.message);
      // Don't block bridge step
    }

    // ── Step 2: Bridge Matrix ──────────────────────────────────────────
    setStep('bridge', 'active', 'Syncing Bridge Matrix');
    setStatus('Fetching regional bridge nodes...');
    try {
      const r = await fetch('/services/reverse?token=' + TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: 'all' }),
      });
      if (!r.ok) throw new Error('Bridge sync failed');
      setStep('bridge', 'done', 'Bridge: matrix synchronized');
    } catch (err) {
      setStep('bridge', 'error', 'Bridge sync failed');
      setStatus('Error: ' + err.message);
    }

    // ── Done: reveal portal ─────────────────────────────────────────────
    setStatus('Tunnel matrix ready. Loading portal...');
    // Small delay for visual feedback before fade
    await new Promise(r => setTimeout(r, 800));
    overlay.classList.add('hidden');

    // Now load the actual portal data
    await loadSettings();
  }

  // ── Load settings (UUID, IPs, etc.) ─────────────────────────────────────
  async function loadSettings() {
    try {
      const r = await fetch('/services/settings?token=' + TOKEN);
      if (r.ok) {
        const { uuid, ips, reverseIps, routingPolicy } = await r.json();
        if (uuid) applyUuid(uuid);
        if (ips) renderIps(ips, 'ipDisplay');
        if (reverseIps) renderIps(reverseIps, 'reverseIpDisplay');
        updatePolicyUI(routingPolicy || 'AUTO');
      }
    } catch (_) {}
  }

  // ── Init ────────────────────────────────────────────────────────────────
  if (NEEDS_BOOTSTRAP) {
    bootstrap();
  } else {
    loadSettings();
  }

  let telemetryLoaded = false;
  function switchTab(tabId, btn) {
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById('tab-' + tabId).classList.add('active');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    if (tabId === 'diagnostics' && !ipInfoLoaded) {
      ipInfoLoaded = true;
      fetchIpInfo();
    }
    if (tabId === 'usage' && !telemetryLoaded) {
      telemetryLoaded = true;
      loadTelemetry();
    }
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
        if (latency < 0) {
          latencyClass = 'latency-unknown';
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

  function updatePolicyUI(policy) {
    document.querySelectorAll('.policy-btn').forEach(btn => {
      btn.classList.remove('bg-indigo-500', 'bg-opacity-20', 'border-indigo-500', 'border-opacity-30', 'text-white');
      btn.classList.add('border-transparent');
    });
    const activeBtn = document.getElementById('policy-' + policy);
    if (activeBtn) {
      activeBtn.classList.remove('border-transparent');
      activeBtn.classList.add('bg-indigo-500', 'bg-opacity-20', 'border-indigo-500', 'border-opacity-30', 'text-white');
    }

    const descEl = document.getElementById('policyDescription').firstElementChild;
    if (policy === 'AUTO') {
      descEl.innerHTML = '<div class="text-indigo-400 font-bold mb-1.5 not-italic uppercase tracking-wider">Recommended</div><div>Attempts a direct high-speed connection first. If Cloudflare blocks the TLS handshake (e.g., due to loopback restrictions), it natively catches the error and falls back to a SNI Reverse Bridge node seamlessly.</div>';
    } else if (policy === 'BRIDGE') {
      descEl.innerHTML = '<div class="text-indigo-400 font-bold mb-1.5 not-italic uppercase tracking-wider">Robust but Slower</div><div>Bypasses the direct attempt entirely and forces all traffic through the Reverse Bridge Matrix. Use this if direct connections are completely unreachable or highly unstable in your network.</div>';
    } else if (policy === 'DIRECT') {
      descEl.innerHTML = '<div class="text-indigo-400 font-bold mb-1.5 not-italic uppercase tracking-wider">Fast but Unstable</div><div>Attempts direct connections only. Disables the bridge fallback mechanism. If your environment restricts standard Cloudflare edge IPs, your connection will fail immediately. (e.g. chatgpt.com, claude.ai, github.com ...)</div>';
    }
  }

  async function setPolicy(policy) {
    updatePolicyUI(policy);
    try {
      const r = await fetch('/services/policy?token=' + TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ policy }),
      });
      r.ok ? flash(\`Routing Policy updated: \${policy}\`, 'text-indigo-300') : flash('Update failed', 'text-red-400');
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
      // Step 1: Fetch raw candidate IPs from the worker (no latency measured server-side)
      const cRes = await fetch('/services/preferred?token=' + TOKEN);
      if (!cRes.ok) { flash('Sync failed: could not fetch candidates', 'text-red-400'); return; }
      const { candidates } = await cRes.json();
      if (!candidates || candidates.length === 0) { flash('Sync failed: no candidates returned', 'text-red-400'); return; }

      flash(\`Probing \${candidates.length} edge nodes from your location...\`, 'text-indigo-300');

      // Step 2: Measure Client-to-Edge RTT for each candidate IP in the browser in parallel.
      // mode:'no-cors' prevents CORS errors; the request still completes and timing is accurate.
      const probeTimeout = 3000;
      const results = await Promise.allSettled(
        candidates.map(async (ip) => {
          const t0 = performance.now();
          try {
            // We use https:// to satisfy the browser's "Secure Context" (Mixed Content) policy.
            // We EXPECT this to fail with a "TypeError" due to the Certificate Mismatch.
            // However, the time it takes to reach that failure is the real network RTT.
            await fetch(\`https://\${ip}/\`, {
              mode: 'no-cors',
              cache: 'no-store',
              signal: AbortSignal.timeout(probeTimeout),
            });
            return { ip, latency: Math.round(performance.now() - t0) };
          } catch (e) {
            const latency = Math.round(performance.now() - t0);
            // If it's a real timeout, the node is dead.
            if (e.name === 'AbortError' || e.name === 'TimeoutError' || latency >= probeTimeout - 50) {
              return { ip, latency: -1 };
            }
            // If it's a TypeError (Cert Mismatch), the node responded!
            // We subtract a small TLS overhead for a more accurate RTT.
            return { ip, latency: Math.max(1, latency - 10) };
          }
        })
      );

      // Collect all results (even failures get latency: -1 for visibility in the UI)
      const ranked = results
        .map(r => r.status === 'fulfilled' ? r.value : null)
        .filter(Boolean)
        .sort((a, b) => {
          // Push unreachable nodes (-1) to the end
          if (a.latency < 0 && b.latency >= 0) return 1;
          if (b.latency < 0 && a.latency >= 0) return -1;
          return a.latency - b.latency;
        });

      // Step 3: Submit client-measured rankings back to the worker to persist in KV
      const saveRes = await fetch('/services/preferred/ranked?token=' + TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ranked),
      });

      if (saveRes.ok) {
        flash(\`Anycast matrix synchronized (\${ranked.filter(r => r.latency >= 0).length} reachable nodes)\`, 'text-green-400');
        const settingsRes = await fetch('/services/settings?token=' + TOKEN);
        if (settingsRes.ok) {
          const { ips } = await settingsRes.json();
          renderIps(ips, 'ipDisplay');
        }
      } else {
        flash('Sync failed: could not persist rankings', 'text-red-400');
      }
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

    const region = document.getElementById('bridgeRegionSelect').value;

    try {
      const r = await fetch('/services/reverse?token=' + TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region }),
      });
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

  async function fetchIpInfo() {
    const btn = document.getElementById('refreshIpBtn');
    btn.disabled = true;
    const icon = btn.querySelector('svg');
    if (icon) icon.classList.add('animate-spin');

    document.getElementById('diagIp').textContent = 'Loading...';
    document.getElementById('diagLoc').textContent = 'Loading...';
    document.getElementById('diagAsn').textContent = 'Loading...';
    document.getElementById('diagOrg').textContent = 'Loading...';
    document.getElementById('diagColo').textContent = 'Loading...';
    document.getElementById('diagType').textContent = 'Loading...';
    document.getElementById('diagType').className = 'text-gray-200';

    try {
      const res = await fetch('/services/myip?token=' + TOKEN);
      if (res.ok) {
        const data = await res.json();
        
        document.getElementById('diagIp').innerHTML = data.ip + ' <span class="text-[9px] text-gray-500 ml-1 border border-gray-600 rounded px-1">' + data.type + '</span>';
        document.getElementById('diagLoc').textContent = data.location;
        document.getElementById('diagAsn').textContent = data.asn !== 'Unknown' ? 'AS' + data.asn : 'Unknown';
        document.getElementById('diagOrg').textContent = data.asnOwner;
        document.getElementById('diagOrg').title = data.asnOwner;
        document.getElementById('diagColo').textContent = data.colo;
        
        document.getElementById('diagType').textContent = data.isp;
        document.getElementById('diagType').title = data.isp;
        document.getElementById('diagType').className = data.isp !== 'Unknown' ? 'text-indigo-400 font-medium truncate block' : 'text-gray-400 font-medium truncate block';
      }
    } catch (e) {
      flash('Failed to load IP info', 'text-red-400');
    } finally {
      btn.disabled = false;
      if (icon) icon.classList.remove('animate-spin');
    }
  }

  async function runSpeedtest() {
    const btn = document.getElementById('speedtestBtn');
    const status = document.getElementById('speedStatus');
    const result = document.getElementById('speedResult');

    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
    status.textContent = 'Testing download speed...';
    result.innerHTML = '<span class="animate-pulse">...</span>';

    try {
      const PARALLEL = 10;
      const BYTES_PER = 1 * 1024 * 1024;
      const totalBytes = BYTES_PER * PARALLEL;

      status.textContent = 'Running ' + PARALLEL + ' parallel connections...';

      const start = performance.now();
      await Promise.all(
        Array.from({ length: PARALLEL }, (_, i) =>
          fetch('/services/speedtest?token=' + TOKEN + '&nocache=' + i + '_' + Date.now(), { cache: 'no-store' })
            .then(r => {
              if (!r.ok) throw new Error('HTTP ' + r.status);
              return r.arrayBuffer();
            })
        )
      );
      const end = performance.now();

      const durationSec = (end - start) / 1000;
      const mbps = ((totalBytes * 8) / durationSec / 1_000_000).toFixed(2);

      result.innerHTML = mbps + ' <span class="text-sm text-gray-500 font-normal">Mbps</span>';
      status.innerHTML = 'Test complete <br> (' + (totalBytes / 1024 / 1024).toFixed(0) + ' MB across ' + PARALLEL + ' connections)';

    } catch (err) {
      result.innerHTML = '-- <span class="text-sm text-gray-500 font-normal">Mbps</span>';
      status.textContent = 'Speedtest failed';
      flash('Speedtest error', 'text-red-400');
    } finally {
      btn.disabled = false;
      btn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
  }
  async function loadTelemetry() {
    try {
      const r = await fetch('/services/telemetry?token=' + TOKEN);
      if (r.status === 401) {
        document.getElementById('telemetry-auth-section').classList.remove('hidden');
        document.getElementById('telemetry-auth-section').classList.add('flex');
        document.getElementById('telemetry-dash-section').classList.add('hidden');
        document.getElementById('telemetry-dash-section').classList.remove('flex');
        return;
      }
      
      if (!r.ok) throw new Error('Failed to load telemetry');

      const { metrics, hasAuth } = await r.json();
      
      if (hasAuth) {
        document.getElementById('telemetry-auth-section').classList.add('hidden');
        document.getElementById('telemetry-auth-section').classList.remove('flex');
        document.getElementById('telemetry-dash-section').classList.remove('hidden');
        document.getElementById('telemetry-dash-section').classList.add('flex');
        
        const reqs = metrics?.requests || 0;
        const cpuMicroseconds = metrics?.cpuTime || 0;
        const cpuMs = Math.round(cpuMicroseconds / 1000);
        
        document.getElementById('metric-requests').textContent = reqs.toLocaleString();
        
        const pct = Math.min(100, (reqs / 100000) * 100);
        document.getElementById('metric-requests-bar').style.width = pct + '%';
        
        document.getElementById('metric-cpu').innerHTML = cpuMs.toLocaleString() + ' <span class="text-[10px] text-gray-500 font-normal">ms</span>';
      }
    } catch (_) {
      flash('Telemetry fetch failed', 'text-red-400');
    }
  }

  async function saveTelemetryAuth() {
    const accountId = document.getElementById('telemetryAccountId').value.trim();
    const apiToken = document.getElementById('telemetryApiToken').value.trim();
    
    if (!accountId || !apiToken) {
      flash('Account ID and API Token required', 'text-orange-400');
      return;
    }
    
    const btn = document.getElementById('telemetryAuthBtn');
    btn.textContent = 'Connecting...';
    btn.disabled = true;
    
    try {
      const r = await fetch('/services/telemetry/auth?token=' + TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId, apiToken })
      });
      
      if (r.ok) {
        flash('Connecting ...', 'text-indigo-300');
        await loadTelemetry();
      } else {
        flash('Connection failed', 'text-red-400');
      }
    } catch (_) {
      flash('Network error', 'text-red-400');
    } finally {
      btn.textContent = 'Connect Cloudflare API';
      btn.disabled = false;
    }
  }
</script>
  </body>
  </html>`;
}
