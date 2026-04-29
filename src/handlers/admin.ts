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
<script src="https://cdn.tailwindcss.com"></script>
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
    box-shadow: 0 25px 50px -12px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,0.04);
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

  /* ── Visual Polish ─────────────────────────────────────────────────── */
  .ip-row {
    position: relative;
    transition: all 0.2s ease;
  }
  .ip-row:hover { background: rgba(99, 102, 241, 0.06); }
  .ip-row::before {
    content: "";
    position: absolute;
    left: 0; top: 20%; bottom: 20%;
    width: 2px;
    background: #6366f1;
    border-radius: 1px;
    opacity: 0;
    transition: opacity 0.2s ease;
  }
  .ip-row:hover::before { opacity: 0.7; }
  .glass-panel button:active:not(:disabled) {
    transform: scale(0.97);
    transition: transform 0.1s ease;
  }
  @keyframes shimmer {
    0% { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }
  .skeleton {
    background: linear-gradient(90deg, rgba(63,63,70,0.3) 25%, rgba(63,63,70,0.5) 50%, rgba(63,63,70,0.3) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s ease-in-out infinite;
    border-radius: 0.375rem;
  }
  #status {
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
  }

  /* Tab System */
  .tab-btn {
    position: relative;
    padding-bottom: 0.5rem;
    color: #94a3b8;
    transition: all 0.3s;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    cursor: pointer;
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
    font-size: 0.95rem;
    padding: 0.5rem 0.75rem;
    outline: none;
    cursor: pointer;
    transition: border-color 0.2s;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236366f1' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 0.75rem center;
    padding-right: 2rem;
  }
  .region-select:hover, .region-select:focus {
    border-color: rgba(99, 102, 241, 0.5);
  }
  .region-select option { background: #1e1e2a; color: #d1d5db; font-size: 1rem; }

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

  /* Security Badges */
  .sec-badge {
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.025em;
    border-width: 1px;
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .sec-badge-true {
    background: rgba(239, 68, 68, 0.1);
    color: #f87171;
    border-color: rgba(239, 68, 68, 0.2);
  }
  .sec-badge-false {
    background: rgba(16, 185, 129, 0.1);
    color: #34d399;
    border-color: rgba(16, 185, 129, 0.2);
  }
  .sec-badge-warn {
    background: rgba(245, 158, 11, 0.1);
    color: #fbbf24;
    border-color: rgba(245, 158, 11, 0.2);
  }

  /* ── QR Panel Animations ───────────────────────────────────────────── */
  @keyframes slideDown {
    from { opacity: 0; transform: translateY(-10px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .qr-animate { animation: slideDown 0.3s ease-out; }
</style>
</head>
<body class="min-h-screen flex items-center justify-center p-3 sm:p-4 md:p-6">

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



<div class="glass-panel rounded-2xl p-4 sm:p-5 md:p-6 w-full max-w-sm sm:max-w-md md:max-w-lg flex flex-col gap-4">

  <header class="flex flex-col gap-4 sm:gap-5">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-xl sm:text-2xl font-semibold tracking-tight">Edge Tunnel</h1>
        <p class="text-gray-400 text-xs">Optimized edge for seamless connectivity</p>
      </div>
      <div class="text-xs px-2 py-1 rounded bg-indigo-500/10 text-indigo-300 border border-indigo-500/20 font-mono">v${APP_VERSION}</div>
    </div>

    <nav class="flex justify-between border-b border-gray-700/40 overflow-x-auto hidden-scroll pb-1 gap-1 sm:gap-2">
      <button class="tab-btn active whitespace-nowrap" onclick="switchTab('identity', this)">Link</button>
      <button class="tab-btn whitespace-nowrap" onclick="switchTab('anycast', this)">Anycast</button>
      <button class="tab-btn whitespace-nowrap" onclick="switchTab('bridge', this)">Bridge</button>
      <button class="tab-btn whitespace-nowrap" onclick="switchTab('diagnostics', this)">Network</button>
      <button class="tab-btn whitespace-nowrap" onclick="switchTab('settings', this)">Settings</button>
      <button class="tab-btn whitespace-nowrap" onclick="switchTab('usage', this)">Usage</button>
    </nav>
  </header>

  <div id="tab-identity" class="tab-content active space-y-5">
    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <div>
          <label class="text-sm uppercase tracking-widest font-semibold text-gray-300">UUID</label>
          <p class="text-sm text-gray-500 mt-1 leading-relaxed">Authentication token for secure edge identity.</p>
        </div>
        <button class="bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 rounded-lg w-8 h-8 flex items-center justify-center transition-all shadow-sm flex-shrink-0" id="regenIdBtn" title="Regenerate" onclick="regenerate()">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
      <div class="mono-box px-3 py-2.5 rounded-xl text-gray-300 font-mono text-sm cursor-pointer truncate" id="uuidDisplay" onclick="copyText(this)"></div>
    </div>

    <div class="space-y-4 pt-2 border-t border-white/5">
      
      <!-- Protocol Toggle -->
      <div class="flex items-center justify-between mb-2">
        <label class="text-[11px] uppercase tracking-wider font-bold text-gray-400">Subscription Protocol</label>
        <div class="flex bg-gray-800/50 rounded-lg p-0.5 border border-gray-700/50">
          <button id="proto-vless" onclick="setProtocol('vless')" class="text-xs px-3 py-1 rounded-md transition-all font-medium bg-indigo-500/20 border border-indigo-500/30 text-indigo-300">VLESS</button>
          <button id="proto-trojan" onclick="setProtocol('trojan')" class="text-xs px-3 py-1 rounded-md transition-all font-medium text-gray-400 hover:text-gray-200 border border-transparent">Trojan</button>
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="text-[11px] uppercase tracking-wider font-bold text-gray-400 flex items-center gap-2">
          Plain <span class="bg-emerald-500/20 text-emerald-400 text-[9px] px-1.5 py-0.5 rounded border border-emerald-500/20">Subscription</span>
        </label>
        <div class="flex gap-2 items-stretch">
          <div class="mono-box flex-1 px-3 py-2.5 rounded-xl text-gray-300 font-mono text-xs cursor-pointer truncate" id="subLink" onclick="copyText(this)"></div>
          <div class="flex gap-1.5">
            <button class="bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/20 transition-all rounded-xl w-10 flex-shrink-0 flex items-center justify-center" onclick="showQRCode('Plain Subscription', document.getElementById('subLink').textContent)" title="Show QR">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10V3h7v7H3zm11 0V3h7v7h-7zM3 21v-7h7v7H3zm11 0v-3h3v3h-3zm3-3v-3h4v4h-4zm-3 0h3v3h-3z" /></svg>
            </button>
            <button class="bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/20 transition-all rounded-xl w-10 flex-shrink-0 flex items-center justify-center" onclick="copyText(document.getElementById('subLink'))" title="Copy Link">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="text-[11px] uppercase tracking-wider font-bold text-gray-400 flex items-center gap-2">
          Base64 <span class="bg-gray-500/20 text-gray-400 text-[9px] px-1.5 py-0.5 rounded border border-gray-500/20">Compatible</span>
        </label>
        <div class="flex gap-2 items-stretch">
          <div class="mono-box flex-1 px-3 py-2.5 rounded-xl text-gray-400 font-mono text-xs cursor-pointer truncate" id="subLinkBase64" onclick="copyText(this)"></div>
          <div class="flex gap-1.5">
            <button class="bg-gray-500/10 hover:bg-gray-500/20 text-gray-400 border border-gray-500/20 transition-all rounded-xl w-10 flex-shrink-0 flex items-center justify-center" onclick="showQRCode('Base64 Subscription', document.getElementById('subLinkBase64').textContent)" title="Show QR">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10V3h7v7H3zm11 0V3h7v7h-7zM3 21v-7h7v7H3zm11 0v-3h3v3h-3zm3-3v-3h4v4h-4zm-3 0h3v3h-3z" /></svg>
            </button>
            <button class="bg-gray-500/10 hover:bg-gray-500/20 text-gray-400 border border-gray-500/20 transition-all rounded-xl w-10 flex-shrink-0 flex items-center justify-center" onclick="copyText(document.getElementById('subLinkBase64'))" title="Copy Link">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-1.5">
        <label class="text-[11px] uppercase tracking-wider font-bold text-gray-400 flex items-center gap-2">
          Clash <span class="bg-orange-500/20 text-orange-400 text-[9px] px-1.5 py-0.5 rounded border border-orange-500/20">YAML</span>
        </label>
        <div class="flex gap-2 items-stretch">
          <div class="mono-box flex-1 px-3 py-2.5 rounded-xl text-orange-400/80 font-mono text-xs cursor-pointer truncate" id="subLinkClash" onclick="copyText(this)"></div>
          <div class="flex gap-1.5">
            <button class="bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 border border-orange-500/20 transition-all rounded-xl w-10 flex-shrink-0 flex items-center justify-center" onclick="showQRCode('Clash Subscription', document.getElementById('subLinkClash').textContent)" title="Show QR">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 10V3h7v7H3zm11 0V3h7v7h-7zM3 21v-7h7v7H3zm11 0v-3h3v3h-3zm3-3v-3h4v4h-4zm-3 0h3v3h-3z" /></svg>
            </button>
            <button class="bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 border border-orange-500/20 transition-all rounded-xl w-10 flex-shrink-0 flex items-center justify-center" onclick="copyText(document.getElementById('subLinkClash'))" title="Copy Link">
              <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Inline QR Panel -->
    <div id="qr-panel" class="hidden qr-animate pt-4 border-t border-white/5 flex flex-col items-center">
      <div class="flex flex-col items-center gap-3 p-5 rounded-[2rem] bg-white/5 border border-white/5 w-full relative shadow-2xl">
        <button onclick="closeQRCode()" class="absolute top-3 right-3 text-gray-500 hover:text-white transition-colors p-1" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
        <div id="qr-display" class="bg-white p-3 rounded-2xl shadow-lg mt-2"></div>
        <span id="qr-title" class="text-[11px] text-gray-400 font-bold uppercase tracking-widest pb-1">Subscription QR</span>
      </div>
    </div>
  </div>


  <!-- ── Tab 2: Anycast Matrix ────────────────────────────────────────── -->
  <div id="tab-anycast" class="tab-content space-y-4">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2 min-w-0">
        <label class="text-sm uppercase tracking-widest font-semibold text-gray-300 whitespace-nowrap">Anycast Matrix</label>
        <span class="text-xs text-indigo-400 font-mono" id="preferredCount">0</span>
      </div>
      <button class="bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 rounded-lg w-8 h-8 flex items-center justify-center transition-all shadow-sm flex-shrink-0" id="syncPreferredBtn" title="Sync Matrix" onclick="syncPreferredIps()">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>
    <p class="text-sm text-gray-500 leading-tight -mt-1 italic">Optimized CF Anycast nodes for direct edge routing.</p>
    <div class="mono-box rounded-2xl p-3 custom-scroll max-h-[360px] overflow-y-auto shadow-inner">
      <div class="space-y-1.5" id="ipDisplay"></div>
    </div>
  </div>

  <!-- ── Tab 3: Bridge Matrix ─────────────────────────────────────────── -->
  <div id="tab-bridge" class="tab-content space-y-4">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2 min-w-0">
        <label class="text-sm uppercase tracking-widest font-semibold text-gray-300 whitespace-nowrap">Bridge Matrix</label>
        <span class="text-xs text-indigo-400 font-mono" id="reverseCount">0</span>
      </div>
      <button class="bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 rounded-lg w-8 h-8 flex items-center justify-center transition-all shadow-sm flex-shrink-0" id="syncReverseBtn" title="Sync Matrix" onclick="syncReverseIps()">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      </button>
    </div>
    <select id="bridgeRegionSelect" class="region-select w-full text-base">
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
    <p class="text-sm text-gray-500 leading-tight -mt-1 italic">Bridge nodes are used to bypass Cloudflare's internal loopback restrictions.</p>
    <div class="mono-box rounded-2xl p-3 custom-scroll max-h-[360px] overflow-y-auto shadow-inner">
      <div class="space-y-1.5" id="reverseIpDisplay"></div>
    </div>
  </div>

  <!-- ── Tab 4: Settings ──────────────────────────────────────────────── -->
  <div id="tab-settings" class="tab-content space-y-5">
    <div class="space-y-3">
      <label class="text-sm uppercase tracking-widest font-semibold text-gray-300">Routing Policy</label>
      <div class="mono-box rounded-2xl shadow-inner p-1.5 grid grid-cols-1 sm:grid-cols-3 gap-1.5">
        <button id="policy-AUTO" onclick="setPolicy('AUTO')" class="policy-btn py-3 px-3 rounded-xl text-sm font-medium text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-all flex flex-col items-center justify-center gap-1.5 border border-transparent">
          <span class="flex items-center gap-1.5 text-gray-300">
            <span class="text-2xl leading-none">🤖</span>
            <span class="leading-none">Auto Selection</span>
          </span>
          <span class="text-xs text-gray-500 font-normal tracking-widest uppercase leading-none">Smart Direct or Bridge</span>
        </button>
        <button id="policy-BRIDGE" onclick="setPolicy('BRIDGE')" class="policy-btn py-3 px-3 rounded-xl text-sm font-medium text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-all flex flex-col items-center justify-center gap-1.5 border border-transparent">
          <span class="flex items-center gap-1.5 text-gray-300">
            <span class="text-2xl leading-none">🔗</span>
            <span class="leading-none">Bridge Anyway</span>
          </span>
          <span class="text-xs text-gray-500 font-normal tracking-widest uppercase leading-none">Bridge All of them</span>
        </button>
        <button id="policy-DIRECT" onclick="setPolicy('DIRECT')" class="policy-btn py-3 px-3 rounded-xl text-sm font-medium text-gray-400 hover:text-gray-200 hover:bg-white/5 transition-all flex flex-col items-center justify-center gap-1.5 border border-transparent">
          <span class="flex items-center gap-1.5 text-gray-300">
            <span class="text-2xl leading-none">⚡</span>
            <span class="leading-none">Direct Connection</span>
          </span>
          <span class="text-xs text-gray-500 font-normal tracking-widest uppercase leading-none">No Bridge At All</span>
        </button>
      </div>
    </div>

    <div class="p-4 rounded-2xl bg-indigo-500/5 border border-indigo-500/10" id="policyDescription">
      <div class="text-sm text-indigo-200 font-medium leading-relaxed">
        Loading policy description...
      </div>
    </div>

    <div class="space-y-4 pt-2">
      <label class="text-sm uppercase tracking-widest font-semibold text-gray-300 flex items-center gap-2">
        <span>Protocol Tweaks</span>
        <span class="h-px flex-1 bg-white/5"></span>
      </label>
      
      <div class="flex flex-col gap-3">
        <!-- Toggle: Early Data -->
        <div class="flex items-center justify-between p-4 rounded-2xl mono-box shadow-inner hover:bg-white/[0.04] transition-all cursor-pointer group" onclick="toggleSetting('enableEarlyData')">
          <div class="flex flex-col gap-1 pr-4">
            <span class="text-base font-medium text-gray-200">WebSocket Early Data</span>
            <span class="text-sm text-gray-500 leading-relaxed">Embed the first proxy message (e.g. /?ed=2560) in the WebSocket handshake to reduce round-trip latency.</span>
          </div>
          <div id="toggle-enableEarlyData" class="w-10 h-5 rounded-full bg-gray-700 relative transition-all flex-shrink-0">
            <div class="absolute top-1 left-1 w-3 h-3 rounded-full bg-gray-400 transition-all"></div>
          </div>
        </div>

        <!-- Toggle: Formal Paths -->
        <div class="flex items-center justify-between p-4 rounded-2xl mono-box shadow-inner hover:bg-white/[0.04] transition-all cursor-pointer group" onclick="toggleSetting('useFormalPaths')">
          <div class="flex flex-col gap-1 pr-4">
            <span class="text-base font-medium text-gray-200">Formal Obfuscated Paths</span>
            <span class="text-sm text-gray-500 leading-relaxed">Use realistic web formal paths (e.g. /api/v2/stream) to bypass advanced fingerprinting.</span>
          </div>
          <div id="toggle-useFormalPaths" class="w-10 h-5 rounded-full bg-gray-700 relative transition-all flex-shrink-0">
            <div class="absolute top-1 left-1 w-3 h-3 rounded-full bg-gray-400 transition-all"></div>
          </div>
        </div>

        <!-- Toggle: ECH -->
        <div class="flex items-center justify-between p-4 rounded-2xl mono-box shadow-inner hover:bg-white/[0.04] transition-all cursor-pointer group" onclick="toggleSetting('enableEch')">
          <div class="flex flex-col gap-1 pr-4">
            <span class="text-base font-medium text-gray-200">Encrypted Client Hello (ECH)</span>
            <span class="text-sm text-gray-500 leading-relaxed">Encrypt the SNI in the TLS handshake. Requires ECH-compatible client and server (cloudflare-ech.com).</span>
          </div>
          <div id="toggle-enableEch" class="w-10 h-5 rounded-full bg-gray-700 relative transition-all flex-shrink-0">
            <div class="absolute top-1 left-1 w-3 h-3 rounded-full bg-gray-400 transition-all"></div>
          </div>
        </div>

        <!-- Toggle: Auto TUN Mode -->
        <div class="flex items-center justify-between p-4 rounded-2xl mono-box shadow-inner hover:bg-white/[0.04] transition-all cursor-pointer group" onclick="toggleSetting('autoTunMode')">
          <div class="flex flex-col gap-1 pr-4">
            <div class="flex items-center gap-2">
              <span class="text-base font-medium text-gray-200">Auto TUN Mode</span>
              <span class="bg-orange-500/20 text-orange-400 text-[9px] px-1.5 py-0.5 rounded border border-orange-500/20">YAML</span>
            </div>
            <span class="text-sm text-gray-500 leading-relaxed">Enable TUN mode automatically. Client in TUN mode will work more like VPN, which can capture all traffic.</span>
          </div>
          <div id="toggle-autoTunMode" class="w-10 h-5 rounded-full bg-gray-700 relative transition-all flex-shrink-0">
            <div class="absolute top-1 left-1 w-3 h-3 rounded-full bg-gray-400 transition-all"></div>
          </div>
        </div>

        <!-- Toggle: Gaming Mode -->
        <div class="flex items-center justify-between p-4 rounded-2xl mono-box shadow-inner hover:bg-white/[0.04] transition-all cursor-pointer group" onclick="toggleSetting('gamingMode')">
          <div class="flex flex-col gap-1 pr-4">
            <div class="flex items-center gap-2">
              <span class="text-base font-medium text-gray-200">Gaming Mode</span>
              <span class="bg-orange-500/20 text-orange-400 text-[9px] px-1.5 py-0.5 rounded border border-orange-500/20">YAML</span>
            </div>
            <span class="text-sm text-gray-500 leading-relaxed">Enable UDP tunneling in TUN mode for better game compatibility. Disable it to allow direct UDP.</span>
          </div>
          <div id="toggle-gamingMode" class="w-10 h-5 rounded-full bg-gray-700 relative transition-all flex-shrink-0">
            <div class="absolute top-1 left-1 w-3 h-3 rounded-full bg-gray-400 transition-all"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Tab 5: Diagnostics ────────────────────────────────────────────── -->
  <div id="tab-diagnostics" class="tab-content space-y-5">
    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <label class="text-sm uppercase tracking-widest font-semibold text-gray-300">IP Identity</label>
        <button class="bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 rounded-lg w-8 h-8 flex items-center justify-center transition-all shadow-sm flex-shrink-0" id="refreshIpBtn" title="Refresh Identity" onclick="fetchIpInfo()">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
      <div class="mono-box rounded-2xl p-4 shadow-inner grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div><span class="text-gray-500 block mb-1">IP Address</span><span id="diagIp" class="text-gray-200 font-mono">Loading...</span></div>
        <div><span class="text-gray-500 block mb-1">Location</span><span id="diagLoc" class="text-gray-200">Loading...</span></div>
        <div><span class="text-gray-500 block mb-1">ASN</span><span id="diagAsn" class="text-gray-200 font-mono">Loading...</span></div>
        <div class="overflow-hidden"><span class="text-gray-500 block mb-1">ASN Owner</span><span id="diagOrg" class="text-gray-200 truncate block">Loading...</span></div>
        <div><span class="text-gray-500 block mb-1">Colo</span><span id="diagColo" class="text-gray-200 font-mono">Loading...</span></div>
        <div class="overflow-hidden"><span class="text-gray-500 block mb-1">ISP</span><span id="diagIsp" class="text-gray-200 truncate block">Loading...</span></div>
        
        <div class="col-span-2 pt-3 mt-1 border-t border-gray-700/50 grid grid-cols-2 gap-x-4">
          <div>
            <span class="text-gray-500 block mb-2 text-xs">Security Profile</span>
            <div id="securityBadges" class="flex flex-wrap gap-2 min-h-[24px]">
              <div class="skeleton h-6 w-16"></div>
              <div class="skeleton h-6 w-16"></div>
            </div>
            <div id="datacenterInfo" class="text-[11px] text-gray-400 italic mt-1.5 hidden"></div>
          </div>
          <div>
            <span class="text-gray-500 block mb-2 text-xs">WebRTC Leak</span>
            <div id="leakAlert" class="py-1 px-2 rounded-md bg-gray-800 border border-gray-700 text-[11px] text-center text-gray-400 inline-block font-medium">
              <span class="animate-pulse">Scanning...</span>
            </div>
          </div>
        </div>
      </div>

      <div id="diagMapContainer" class="rounded-2xl overflow-hidden shadow-inner h-64 relative border border-white/5 mt-3" style="display:none">
        <iframe id="diagMap" frameborder="0" scrolling="no" marginheight="0" marginwidth="0" src="" style="position: absolute; top: 0; left: 0; width: 100%; height: calc(100% + 45px); filter: invert(100%) hue-rotate(180deg) brightness(95%) contrast(90%); border: none;"></iframe>
      </div>
    </div>

    <div class="space-y-3">
      <div class="flex items-center justify-between">
        <label class="text-sm uppercase tracking-widest font-semibold text-gray-300">Speedtest</label>
        <button id="speedtestBtn" class="bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20 rounded-lg w-8 h-8 flex items-center justify-center transition-all shadow-sm flex-shrink-0" title="Start Speedtest" onclick="runSpeedtest()">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </button>
      </div>
      <div class="mono-box rounded-2xl p-4 shadow-inner flex flex-col items-center justify-center min-h-[80px]">
        <div class="text-3xl font-semibold text-gray-200" id="speedResult">-- <span class="text-sm text-gray-500 font-normal">Mbps</span></div>
        <div class="text-xs text-gray-400 mt-1 text-center" id="speedStatus">Ready</div>
      </div>
    </div>
  </div>

  <!-- ── Tab 6: Usage ──────────────────────────────────────────────────── -->
  <div id="tab-usage" class="tab-content">
    <div id="telemetry-loading-section" class="flex flex-col items-center justify-center py-10 gap-3">
      <svg class="animate-spin h-6 w-6 text-indigo-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
      </svg>
      <span class="text-sm text-gray-400 font-medium">Fetching telemetry...</span>
    </div>

    <div id="telemetry-auth-section" style="display:none" class="flex-col gap-3">
      <div class="p-4 rounded-2xl bg-orange-500/5 border border-orange-500/10 mb-2">
        <h3 class="text-base font-semibold text-orange-400 mb-1">Usage Dashboard</h3>
        <p class="text-xs text-orange-200 opacity-80 leading-relaxed">
          Cloudflare automatically tracks your proxy usage. To view these metrics, provide your Account ID <span class="bg-white/10 text-white px-1.5 py-0.5 rounded font-medium ml-1">On Worker's page: Account Details</span> and a Read-Only API Token <span class="bg-white/10 text-white px-1.5 py-0.5 rounded font-medium ml-1">Perms: Account.Workers Scripts (Read)</span>.
        </p>
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-sm uppercase tracking-widest font-semibold text-gray-300 pl-1">Account ID</label>
        <input type="text" id="telemetryAccountId" class="mono-box px-3 py-2.5 rounded-xl text-gray-200 text-sm w-full focus:outline-none focus:ring-1 focus:ring-indigo-500" placeholder="Paste your Account ID here">
      </div>
      <div class="flex flex-col gap-1">
        <label class="text-sm uppercase tracking-widest font-semibold text-gray-300 pl-1">API Token</label>
        <input type="password" id="telemetryApiToken" class="mono-box px-3 py-2.5 rounded-xl text-gray-200 text-sm w-full focus:outline-none focus:ring-1 focus:ring-indigo-500" placeholder="Paste your API Token here">
      </div>
      <button class="bg-indigo-500 hover:bg-indigo-600 text-white rounded-xl py-2.5 text-sm font-semibold transition-colors mt-2 shadow-lg shadow-indigo-500/20" id="telemetryAuthBtn" onclick="saveTelemetryAuth()">Connect Cloudflare API</button>
    </div>

    <div id="telemetry-dash-section" style="display:none" class="flex-col gap-3">
      <div class="flex items-center justify-between">
        <label class="text-sm uppercase tracking-widest font-semibold text-gray-300">Live Usage</label>
        <button class="bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-400 border border-indigo-500/20 rounded-lg w-8 h-8 flex items-center justify-center transition-all shadow-sm flex-shrink-0" id="refreshTelemetryBtn" title="Refresh" onclick="loadTelemetry()">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </button>
      </div>
      <div class="mono-box rounded-2xl p-5 shadow-inner space-y-5">
        <div>
          <div class="flex justify-between items-baseline mb-2">
            <span class="text-sm font-medium text-gray-300">Requests today</span>
            <span class="text-sm font-mono text-gray-400"><span id="metric-requests" class="text-indigo-300 font-semibold">0</span> <span class="text-xs">/ 100,000</span></span>
          </div>
          <div class="w-full bg-gray-800 rounded-full h-2 overflow-hidden">
            <div id="metric-requests-bar" class="bg-indigo-500 h-2 rounded-full transition-all duration-1000" style="width: 0%"></div>
          </div>
        </div>
        <div class="pt-4 border-t border-gray-700/50 flex justify-between items-baseline">
          <span class="text-sm font-medium text-gray-300">Error Rate</span>
          <span class="text-base font-mono text-gray-200" id="metric-error">0.00%</span>
        </div>
        <div class="pt-4 border-t border-gray-700/50">
          <div class="flex flex-col mb-1">
            <span class="text-sm font-medium text-gray-300">CPU Execution Time</span>
            <span class="text-sm text-gray-500 mt-1 leading-relaxed">Free tier limits are <strong class="text-gray-400 font-medium">10ms per request</strong>. Requests exceeding this limit will fail and increase your error rate.</span>
          </div>
          <div class="space-y-3 mt-4">
            <div class="flex justify-between items-baseline">
              <span class="text-sm text-gray-400">Typical Request (Median)</span>
              <span class="text-base font-mono text-indigo-300" id="metric-cpu-p50">0 <span class="text-xs text-gray-500 font-normal">ms</span></span>
            </div>
            <div class="flex justify-between items-baseline">
              <span class="text-sm text-gray-400">Slowest Requests (Max)</span>
              <span class="text-base font-mono text-orange-300" id="metric-cpu-p99">0 <span class="text-xs text-gray-500 font-normal">ms</span></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>

</div>

<div id="status" class="fixed bottom-8 left-1/2 transform -translate-x-1/2 z-50 bg-gray-900 border border-gray-700 shadow-2xl rounded-full px-6 py-2.5 text-xs font-medium transition-all duration-300 opacity-0 pointer-events-none scale-95"></div>

<script>
  const HOST  = '${hostname}';
  const TOKEN = '${token}';
  const NEEDS_BOOTSTRAP = ${needsBootstrap};

  let pendingUuid = '';
  let currentProtocol = 'vless';

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
        const { uuid, ips, reverseIps, settings } = await r.json();
        if (uuid) applyUuid(uuid);
        if (ips) renderIps(ips, 'ipDisplay');
        if (reverseIps) renderIps(reverseIps, 'reverseIpDisplay');
        if (settings) updateSettingsUI(settings);
      }
    } catch (err) { console.error('[loadSettings] Failed:', err); }
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

  function setProtocol(proto) {
    currentProtocol = proto;
    const vlessBtn = document.getElementById('proto-vless');
    const trojanBtn = document.getElementById('proto-trojan');
    
    if (proto === 'vless') {
      vlessBtn.className = 'text-xs px-3 py-1 rounded-md transition-all font-medium bg-indigo-500/20 border border-indigo-500/30 text-indigo-300';
      trojanBtn.className = 'text-xs px-3 py-1 rounded-md transition-all font-medium text-gray-400 hover:text-gray-200 border border-transparent';
    } else {
      trojanBtn.className = 'text-xs px-3 py-1 rounded-md transition-all font-medium bg-indigo-500/20 border border-indigo-500/30 text-indigo-300';
      vlessBtn.className = 'text-xs px-3 py-1 rounded-md transition-all font-medium text-gray-400 hover:text-gray-200 border border-transparent';
    }
    
    if (pendingUuid) applyUuid(pendingUuid);
  }

  function applyUuid(uuid) {
    pendingUuid = uuid;
    document.getElementById('uuidDisplay').textContent = uuid;
    
    const protoQuery = currentProtocol === 'trojan' ? '&protocol=trojan' : '';
    
    const PLAIN_URI = \`https://\${HOST}/sub?token=\${uuid}\${protoQuery}\`;
    const B64_URI   = \`https://\${HOST}/sub?token=\${uuid}&format=base64\${protoQuery}\`;
    const CLASH_URI = \`https://\${HOST}/sub?token=\${uuid}&format=clash\${protoQuery}\`;
    
    document.getElementById('subLink').textContent = PLAIN_URI;
    document.getElementById('subLinkBase64').textContent = B64_URI;
    document.getElementById('subLinkClash').textContent = CLASH_URI;

    const panel = document.getElementById('qr-panel');
    if (!panel.classList.contains('hidden')) {
      const title = document.getElementById('qr-title').textContent;
      let newUri = PLAIN_URI;
      if (title.includes('Base64')) newUri = B64_URI;
      if (title.includes('Clash')) newUri = CLASH_URI;
      showQRCode(title, newUri);
    }
  }

  function showQRCode(title, uri) {
    const panel = document.getElementById('qr-panel');
    const display = document.getElementById('qr-display');
    const titleEl = document.getElementById('qr-title');
    
    titleEl.textContent = title;
    display.innerHTML = '';
    
    new QRCode(display, {
      text: uri,
      width: 140, height: 140,
      colorDark: '#000000', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M,
    });
    
    panel.classList.remove('hidden');
  }

  function closeQRCode() {
    document.getElementById('qr-panel').classList.add('hidden');
  }

  function renderIps(nodes, containerId) {
    const container = document.getElementById(containerId);
    const countId = containerId === 'ipDisplay' ? 'preferredCount' : 'reverseCount';
    const countEl = document.getElementById(countId);
    
    if (!nodes || nodes.length === 0) {
      container.innerHTML = '<span class="italic text-gray-500 text-xs block py-4 text-center">No cached nodes found.</span>';
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

      const latencyStr = latency !== null ? \`<span class="text-xs ml-2 font-mono \${latencyClass} opacity-90">[\${typeof displayLatency === 'number' ? Math.round(displayLatency) + 'ms' : displayLatency}]</span>\` : '';
      return \`<div class="ip-row flex items-center justify-between py-2 border-b border-gray-800/50 last:border-0 transition-colors px-2 cursor-default">
                <span class="text-xs font-mono text-gray-300 truncate mr-2">\${ipStr}</span>
                \${latencyStr}
              </div>\`;
    }).join('');
  }

  let currentSettings = { routingPolicy: 'AUTO', enableEarlyData: false, useFormalPaths: false, enableEch: false, autoTunMode: false, gamingMode: false };

  function updateSettingsUI(settings) {
    currentSettings = settings;
    const policy = settings.routingPolicy;

    // Policy Buttons
    document.querySelectorAll('.policy-btn').forEach(btn => {
      btn.classList.remove('bg-indigo-500/20', 'border-indigo-500/30', 'text-white');
      btn.classList.add('border-transparent');
    });
    const activeBtn = document.getElementById('policy-' + policy);
    if (activeBtn) {
      activeBtn.classList.remove('border-transparent');
    activeBtn.classList.add('bg-indigo-500/20', 'border-indigo-500/30', 'text-white');
    }

    const descEl = document.getElementById('policyDescription').firstElementChild;
    if (policy === 'AUTO') {
      descEl.innerHTML = '<div class="text-indigo-400 font-bold mb-1.5 not-italic uppercase tracking-wider">Recommended</div><div>Attempts a direct high-speed connection first. If Cloudflare blocks the TLS handshake (e.g., due to loopback restrictions), it natively catches the error and falls back to a SNI Reverse Bridge node seamlessly.</div>';
    } else if (policy === 'BRIDGE') {
      descEl.innerHTML = '<div class="text-indigo-400 font-bold mb-1.5 not-italic uppercase tracking-wider">Robust but Slower</div><div>Bypasses the direct attempt entirely and forces all traffic through the Reverse Bridge Matrix. Use this if direct connections are completely unreachable or highly unstable in your network.</div>';
    } else if (policy === 'DIRECT') {
      descEl.innerHTML = '<div class="text-indigo-400 font-bold mb-1.5 not-italic uppercase tracking-wider">Fast but Unstable</div><div>Attempts direct connections only. Disables the bridge fallback mechanism. If your environment restricts standard Cloudflare edge IPs, your connection will fail immediately. (e.g. chatgpt.com, claude.ai, github.com ...)</div>';
    }

    // Toggles
    ['enableEarlyData', 'useFormalPaths', 'enableEch', 'autoTunMode', 'gamingMode'].forEach(key => {
      const toggle = document.getElementById('toggle-' + key);
      const dot = toggle.querySelector('div');
      if (settings[key]) {
        toggle.classList.replace('bg-gray-700', 'bg-indigo-500');
        dot.classList.replace('left-1', 'left-6');
        dot.classList.replace('bg-gray-400', 'bg-white');
      } else {
        toggle.classList.replace('bg-indigo-500', 'bg-gray-700');
        dot.classList.replace('left-6', 'left-1');
        dot.classList.replace('bg-white', 'bg-gray-400');
      }
    });
  }

  async function setPolicy(policy) {
    await saveSettings({ routingPolicy: policy });
  }

  async function toggleSetting(key) {
    const val = !currentSettings[key];
    const updates = { [key]: val };
    
    if (key === 'gamingMode' && val === true && !currentSettings.autoTunMode) {
      // Gaming Mode requires TUN mode to be enabled.
      updates.autoTunMode = true;
    } else if (key === 'autoTunMode' && val === false && currentSettings.gamingMode) {
      // If TUN mode is disabled, Gaming Mode must be disabled.
      updates.gamingMode = false;
    }

    await saveSettings(updates);
  }

  async function saveSettings(updates) {
    // Optimistic UI update
    const nextSettings = { ...currentSettings, ...updates };
    updateSettingsUI(nextSettings);

    try {
      const r = await fetch('/services/settings?token=' + TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!r.ok) throw new Error('Save failed');
      flash('Settings synchronized to edge', 'text-indigo-300');
    } catch (err) {
      console.error('[saveSettings] Failed:', err);
      flash('Update failed', 'text-red-400');
      // Revert UI on failure
      await loadSettings();
    }
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

      flash('Probing ' + candidates.length + ' edge nodes from your location...', 'text-indigo-300');

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
  let currentIpCheckId = 0;

  function flash(msg, cls) {
    const el = document.getElementById('status');
    el.textContent = msg;
    
    // Reset classes for entry
    el.className = 'fixed bottom-8 left-1/2 transform -translate-x-1/2 z-50 bg-gray-900 border border-gray-700 shadow-2xl rounded-full px-6 py-2.5 text-xs font-medium transition-all duration-300 pointer-events-none ' + cls;
    
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
    const scanId = ++currentIpCheckId;
    const btn = document.getElementById('refreshIpBtn');
    btn.disabled = true;
    const icon = btn.querySelector('svg');
    if (icon) icon.classList.add('animate-spin');

    document.getElementById('diagIp').textContent = 'Loading...';
    document.getElementById('diagLoc').textContent = 'Loading...';
    document.getElementById('diagAsn').textContent = 'Loading...';
    document.getElementById('diagOrg').textContent = 'Loading...';
    document.getElementById('diagColo').textContent = 'Loading...';
    document.getElementById('diagIsp').textContent = 'Loading...';
    document.getElementById('diagMapContainer').style.display = 'none';
    document.getElementById('diagMap').src = '';
    
    document.getElementById('securityBadges').innerHTML = '<div class="skeleton h-6 w-16"></div><div class="skeleton h-6 w-16"></div>';
    document.getElementById('datacenterInfo').classList.add('hidden');
    document.getElementById('leakAlert').className = 'py-1 px-2 rounded-md bg-gray-800 border border-gray-700 text-[11px] text-center text-gray-400 inline-block font-medium';
    document.getElementById('leakAlert').innerHTML = '<span class="animate-pulse">Scanning...</span>';

    try {
      const res = await fetch('/services/myip?token=' + TOKEN);
      if (res.ok) {
        const data = await res.json();
        
        document.getElementById('diagIp').innerHTML = data.ip + ' <span class="text-[10px] text-gray-500 ml-1 border border-gray-600 rounded px-1">' + data.type + '</span>';
        document.getElementById('diagLoc').textContent = data.location;
        document.getElementById('diagAsn').textContent = data.asn !== 'Unknown' ? 'AS' + data.asn : 'Unknown';
        document.getElementById('diagOrg').textContent = data.asnOwner;
        document.getElementById('diagOrg').title = data.asnOwner;
        document.getElementById('diagColo').textContent = data.colo;
        document.getElementById('diagIsp').textContent = data.isp;
        document.getElementById('diagIsp').title = data.isp;
        document.getElementById('diagIsp').className = data.isp !== 'Unknown' ? 'text-indigo-400 font-medium truncate block' : 'text-gray-400 font-medium truncate block';
        
        // Security Badges
        const badges = [];
        const sec = data.security || {};
        if (sec.is_datacenter) badges.push('<span class="sec-badge sec-badge-warn">Hosting</span>');
        if (sec.is_vpn) badges.push('<span class="sec-badge sec-badge-true">VPN</span>');
        if (sec.is_tor) badges.push('<span class="sec-badge sec-badge-true">TOR</span>');
        if (sec.is_proxy) badges.push('<span class="sec-badge sec-badge-true">Proxy</span>');
        if (sec.is_abuser) badges.push('<span class="sec-badge sec-badge-true">⚠️ Abuser</span>');
        
        if (badges.length === 0) badges.push('<span class="sec-badge sec-badge-false">Residential/ISP</span>');
        document.getElementById('securityBadges').innerHTML = badges.join('');
        
        if (sec.datacenter_name) {
          const dcEl = document.getElementById('datacenterInfo');
          dcEl.textContent = 'Detected: ' + sec.datacenter_name;
          dcEl.classList.remove('hidden');
        }

        if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
          const lat = data.latitude;
          const lon = data.longitude;
          const delta = 0.05;
          const bbox = (lon - delta) + ',' + (lat - delta) + ',' + (lon + delta) + ',' + (lat + delta);
          document.getElementById('diagMap').src = 'https://www.openstreetmap.org/export/embed.html?bbox=' + bbox + '&layer=mapnik&marker=' + lat + ',' + lon;
          document.getElementById('diagMapContainer').style.display = 'block';
        }

        // WebRTC Leak Test
        detectWebRTCLeak().then(rtcIPs => {
          if (scanId !== currentIpCheckId) return; // Prevent overlapping renders
          
          const alertEl = document.getElementById('leakAlert');
          
          if (rtcIPs.length === 0) {
            alertEl.textContent = 'Blocked / Disabled';
            alertEl.className = 'py-1 px-2 rounded-md bg-gray-800 border border-gray-700 text-[11px] text-center text-gray-400 inline-block font-medium';
            return;
          }
          
          const isPrivateOrLocal = (ip) => {
            return ip === data.ip || 
                   ip.endsWith('.local') ||
                   /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(ip) ||
                   /^(fe80|fc[0-9a-f]|fd[0-9a-f])/i.test(ip);
          };
          const leakIp = rtcIPs.find(ip => !isPrivateOrLocal(ip));
          
          if (leakIp) {
            alertEl.innerHTML = '⚠️ <span class="font-bold tracking-wide">LEAK DETECTED</span>';
            alertEl.className = 'py-1 px-2 rounded-md bg-red-500/10 border border-red-500/20 text-[11px] text-center text-red-400 inline-block font-medium';
          } else {
            alertEl.innerHTML = '✅ <span class="font-bold tracking-wide">SECURE</span>';
            alertEl.className = 'py-1 px-2 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-[11px] text-center text-emerald-400 inline-block font-medium';
          }
        });
      }
    } catch (e) {
      flash('Failed to load IP info', 'text-red-400');
    } finally {
      btn.disabled = false;
      if (icon) icon.classList.remove('animate-spin');
    }
  }

  async function detectWebRTCLeak() {
    return new Promise(resolve => {
      const ips = [];
      let pc, timer;
      let finished = false;

      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (pc) pc.close();
        resolve([...new Set(ips)]);
      };

      timer = setTimeout(finish, 2500);

      try {
        pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        pc.createDataChannel('');
        pc.onicecandidate = e => {
          if (!e.candidate) return finish();
          // Extract the connection address from the standard RFC 5245 space-delimited ICE candidate string.
          // Format: foundation component transport priority connection-address port typ ...
          // Example: "candidate:842163049 1 udp 1677729535 192.168.1.5 54321 typ srflx ..."
          const parts = e.candidate.candidate.split(' ');
          if (parts.length > 4) {
            const ip = parts[4];
            if (ip && (ip.includes('.') || ip.includes(':') || ip.endsWith('.local'))) {
              ips.push(ip);
            }
          }
        };
        pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(finish);
      } catch (e) { finish(); }
    });
  }

  async function runSpeedtest() {
    const btn = document.getElementById('speedtestBtn');
    const icon = btn.querySelector('svg');
    const status = document.getElementById('speedStatus');
    const result = document.getElementById('speedResult');

    btn.disabled = true;
    btn.classList.add('opacity-50', 'cursor-not-allowed');
    if (icon) icon.classList.add('animate-spin');
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
      if (icon) icon.classList.remove('animate-spin');
    }
  }
  async function loadTelemetry() {
    const icon = document.querySelector('#refreshTelemetryBtn svg');
    if (icon) icon.classList.add('animate-spin');

    const authEl  = document.getElementById('telemetry-auth-section');
    const dashEl  = document.getElementById('telemetry-dash-section');
    const loadEl  = document.getElementById('telemetry-loading-section');

    if (authEl.style.display === 'none' && dashEl.style.display === 'none') {
      loadEl.style.display = 'flex';
    }

    function showTelemetryAuth()  { authEl.style.display = 'flex'; dashEl.style.display = 'none'; loadEl.style.display = 'none'; }
    function showTelemetryDash()  { authEl.style.display = 'none'; dashEl.style.display = 'flex'; loadEl.style.display = 'none'; }

    try {
      const r = await fetch('/services/telemetry?token=' + TOKEN);
      if (r.status === 401) { showTelemetryAuth(); return; }
      if (!r.ok) throw new Error('Failed to load telemetry');

      const { metrics, hasAuth } = await r.json();
      if (hasAuth) {
        showTelemetryDash();
        const reqs = metrics?.requests || 0;
        const errs = metrics?.errors || 0;
        const errRate = reqs ? ((errs / reqs) * 100).toFixed(2) : '0.00';
        const cpuP50 = Math.round((metrics?.cpuTimeP50 || 0) / 1000);
        const cpuP99 = Math.round((metrics?.cpuTimeP99 || 0) / 1000);
        
        document.getElementById('metric-requests').textContent = reqs.toLocaleString();
        document.getElementById('metric-requests-bar').style.width = Math.min(100, (reqs / 100000) * 100) + '%';
        
        const errSpan = document.getElementById('metric-error');
        errSpan.textContent = errRate + '%';
        if (errRate === '0.00') {
          errSpan.style.color = '#34d399'; // emerald-400
        } else if (parseFloat(errRate) < 5) {
          errSpan.style.color = '#fb923c'; // orange-400
        } else {
          errSpan.style.color = '#f87171'; // red-400
        }
        
        document.getElementById('metric-cpu-p50').innerHTML = cpuP50.toLocaleString() + ' <span class="text-xs text-gray-500 font-normal">ms</span>';
        document.getElementById('metric-cpu-p99').innerHTML = cpuP99.toLocaleString() + ' <span class="text-xs text-gray-500 font-normal">ms</span>';
      } else {
        showTelemetryAuth();
      }
    } catch (err) {
      console.error('[loadTelemetry] Failed:', err);
      flash('Telemetry fetch failed', 'text-red-400');
    } finally {
      if (icon) icon.classList.remove('animate-spin');
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
    } catch (err) {
      console.error('[saveTelemetryAuth] Failed:', err);
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
