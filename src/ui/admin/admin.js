const { host: HOST, token: TOKEN, bootstrap: needsBootstrapFlag } = document.body.dataset;
const NEEDS_BOOTSTRAP = needsBootstrapFlag === 'true';

let pendingUuid = '';
let currentProtocol = 'vless';
let currentSingBoxVer = '1.14';

let ipInfoLoaded = false;

// ── Bootstrap: First-time initialization ────────────────────────────────
// Runs exactly once on first admin visit to populate empty KV matrices.
async function bootstrap() {
  const overlay = document.getElementById('bootstrap-overlay');
  const status = document.getElementById('bootstrap-status');

  function setStep(id, state, text, sub) {
    const icon = document.getElementById('step-icon-' + id);
    const txtEl = document.getElementById('text-' + id);
    const subEl = document.getElementById('sub-' + id);

    if (state === 'pending') {
      icon.className = 'w-6 h-6 rounded-full border-2 border-gray-600 flex items-center justify-center flex-shrink-0 opacity-40';
      icon.innerHTML = '';
      txtEl.className = 'text-sm font-medium text-gray-500';
    } else if (state === 'active') {
      icon.className = 'w-6 h-6 rounded-full border-2 border-indigo-500 border-t-transparent flex items-center justify-center flex-shrink-0 animate-spin bg-transparent';
      icon.innerHTML = '';
      txtEl.className = 'text-sm font-medium text-gray-200';
    } else if (state === 'done') {
      icon.className = 'w-6 h-6 rounded-full border-2 border-emerald-500 flex items-center justify-center flex-shrink-0 bg-emerald-500/10';
      icon.innerHTML = '<svg class="w-3 h-3 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
      txtEl.className = 'text-sm font-medium text-emerald-400';
    } else if (state === 'error') {
      icon.className = 'w-6 h-6 rounded-full border-2 border-red-500 flex items-center justify-center flex-shrink-0 bg-red-500/10';
      icon.innerHTML = '<svg class="w-3 h-3 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="3"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>';
      txtEl.className = 'text-sm font-medium text-red-400';
    }

    if (txtEl && text) txtEl.textContent = text;
    if (subEl && sub) subEl.textContent = sub;
  }

  function setStatus(msg) {
    if (status) status.textContent = msg;
  }

  const probeTimeout = 4000; // 4s per IP probe

  // ── Step 1: Anycast Matrix ─────────────────────────────────────────
  setStatus('Discovering edge nodes...');
  setStep('anycast', 'active', 'Probing Anycast Matrix', 'Discovering edge nodes...');
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
    setStep('anycast', 'done', 'Anycast: ' + ranked.filter(r => r.latency >= 0).length + ' nodes ready', 'Completed successfully');
  } catch (err) {
    setStep('anycast', 'error', 'Anycast sync failed', 'Error during probe');
    setStatus('Error: ' + err.message);
    // Don't block bridge step
  }

  // ── Step 2: Bridge Matrix ──────────────────────────────────────────
  setStep('bridge', 'active', 'Syncing Bridge Matrix', 'Fetching regional nodes...');
  setStatus('Fetching regional bridge nodes...');
  try {
    const r = await fetch('/services/reverse?token=' + TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ region: 'all' }),
    });
    if (!r.ok) throw new Error('Bridge sync failed');
    setStep('bridge', 'done', 'Bridge: matrix synchronized', 'Synchronized');
  } catch (err) {
    setStep('bridge', 'error', 'Bridge sync failed', 'Error syncing');
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
updateProtocolDesc(currentProtocol);

let telemetryLoaded = false;
function switchTab(tabId, btn) {
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById('tab-' + tabId).classList.add('active');

  document.querySelectorAll('.tab-btn').forEach(b => {
    b.className = 'tab-btn pb-2 text-slate-400 hover:text-slate-100 font-semibold text-xs tracking-widest uppercase border-b-2 border-transparent transition-all whitespace-nowrap';
  });
  btn.className = 'tab-btn pb-2 text-indigo-500 font-semibold text-xs tracking-widest uppercase border-b-2 border-indigo-500 transition-all whitespace-nowrap';

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

  updateProtocolDesc(proto);

  if (pendingUuid) applyUuid(pendingUuid);
}

function updateProtocolDesc(proto) {
  const descEl = document.getElementById('protocol-desc');
  if (!descEl) return;
  if (proto === 'vless') {
    descEl.innerHTML = 'Modern lightweight protocol — requires <span class="text-gray-400">V2Ray</span>, <span class="text-gray-400">Mihomo (Clash Meta)</span>, or <span class="text-gray-400">Singbox (1.14+)</span>, etc.';
  } else {
    descEl.innerHTML = 'Modern protocol with broader compatibility across most proxy clients (Clash Premium, V2RayN, Singbox, Hiddify, etc.).';
  }
}

function applyUuid(uuid) {
  pendingUuid = uuid;
  document.getElementById('uuidDisplay').textContent = uuid;

  const protoQuery = currentProtocol === 'trojan' ? '&protocol=trojan' : '';

  const PLAIN_URI = `https://${HOST}/sub?token=${uuid}${protoQuery}`;
  const B64_URI = `https://${HOST}/sub?token=${uuid}&format=base64${protoQuery}`;
  const CLASH_URI = `https://${HOST}/sub?token=${uuid}&format=clash${protoQuery}`;
  const SING_BOX_URI = `https://${HOST}/sub?token=${uuid}&format=sing-box${protoQuery}&sb_ver=${currentSingBoxVer}`;
  // singbox deep link
  const SING_BOX_DEEP_URI = `sing-box://import-remote-profile?url=${encodeURIComponent(SING_BOX_URI)}`;

  document.getElementById('subLink').textContent = PLAIN_URI;
  document.getElementById('subLinkBase64').textContent = B64_URI;
  document.getElementById('subLinkClash').textContent = CLASH_URI;
  document.getElementById('subLinkSingBox').textContent = SING_BOX_URI;
  // Store deep link in hidden input for QR button access
  document.getElementById('singBoxDeepUri').value = SING_BOX_DEEP_URI;

  const panel = document.getElementById('qr-panel');
  if (!panel.classList.contains('hidden')) {
    const title = document.getElementById('qr-title').textContent;
    let newUri = PLAIN_URI;
    if (title.includes('Base64')) newUri = B64_URI;
    if (title.includes('Clash')) newUri = CLASH_URI;
    if (title.includes('Sing-Box')) newUri = SING_BOX_DEEP_URI;
    showQRCode(title, newUri);
  }
}

function toggleSingBoxVersion() {
  const isLegacy = currentSingBoxVer === '1.14'; // Toggle
  currentSingBoxVer = isLegacy ? '1.13' : '1.14';

  const toggle = document.getElementById('toggle-singBoxLegacy');
  const dot = toggle.querySelector('div');
  const badge = document.getElementById('singBoxBadge');

  if (isLegacy) {
    // Switch to Legacy (1.13)
    toggle.classList.replace('bg-gray-700', 'bg-amber-500/80');
    toggle.classList.replace('border-gray-600', 'border-amber-500');
    dot.classList.replace('left-[1px]', 'left-[13px]');
    dot.classList.replace('bg-gray-400', 'bg-white');

    badge.textContent = 'JSON (1.13)';
    badge.className = 'bg-amber-500/20 text-amber-400 text-[9px] px-1.5 py-0.5 rounded border border-amber-500/20 transition-colors';
  } else {
    // Switch to Standard (1.14)
    toggle.classList.replace('bg-amber-500/80', 'bg-gray-700');
    toggle.classList.replace('border-amber-500', 'border-gray-600');
    dot.classList.replace('left-[13px]', 'left-[1px]');
    dot.classList.replace('bg-white', 'bg-gray-400');

    badge.textContent = 'JSON (1.14)';
    badge.className = 'bg-blue-500/20 text-blue-400 text-[9px] px-1.5 py-0.5 rounded border border-blue-500/20 transition-colors';
  }

  if (pendingUuid) applyUuid(pendingUuid);
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
        latencyClass = 'text-slate-500';
      } else {
        if (latency <= 100) latencyClass = 'text-emerald-500';
        else if (latency <= 500) latencyClass = 'text-amber-500';
        else if (latency <= 1000) latencyClass = 'text-orange-500';
        else latencyClass = 'text-red-500';
      }
    }

    const latencyStr = latency !== null ? `<span class="text-xs ml-2 font-mono ${latencyClass} opacity-90">[${typeof displayLatency === 'number' ? Math.round(displayLatency) + 'ms' : displayLatency}]</span>` : '';
    return `<div class="ip-row flex items-center justify-between py-2 border-b border-gray-800/50 last:border-0 transition-colors px-2 cursor-default">
              <span class="text-xs font-mono text-gray-300 truncate mr-2">${ipStr}</span>
              ${latencyStr}
            </div>`;
  }).join('');
}

let currentSettings = { routingPolicy: 'AUTO', enableEarlyData: false, useFormalPaths: false, enableEch: false, allowInsecure: false, autoTunMode: false, gamingMode: false };

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
  ['enableEarlyData', 'useFormalPaths', 'enableEch', 'allowInsecure', 'autoTunMode', 'gamingMode'].forEach(key => {
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
  } else if (key === 'enableEch' && val === true && currentSettings.allowInsecure) {
    // ECH requires strict TLS verification.
    updates.allowInsecure = false;
  } else if (key === 'allowInsecure' && val === true && currentSettings.enableEch) {
    // Allowing insecure TLS disables ECH.
    updates.enableEch = false;
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
          await fetch(`https://${ip}/`, {
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
      flash(`Anycast matrix synchronized (${ranked.filter(r => r.latency >= 0).length} reachable nodes)`, 'text-green-400');
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

let ingressData = null;
let egressData = null;
let cfEntryData = null;
let activeIpTab = 'cf-entry';

function parseBrowserIpData(who, sec) {
  let ip = who?.ip || sec?.ip || 'Unknown';
  let type = who?.type || 'IPv4';
  let location = 'Unknown';
  let asn = 'Unknown';
  let asnOwner = 'Unknown';
  let isp = 'Unknown';
  let colo = 'Unknown';
  let latitude = null;
  let longitude = null;
  let security = {
    is_datacenter: false, is_vpn: false, is_tor: false,
    is_proxy: false, is_abuser: false, datacenter_name: '', asn_type: ''
  };

  if (who?.success) {
    const flag = who.flag?.emoji || '';
    location = (flag ? flag + ' ' : '') + [who.city, who.region, who.country].filter(Boolean).join(', ');
    asn = who.connection?.asn || asn;
    asnOwner = who.connection?.org || asnOwner;
    isp = who.connection?.isp || isp;
    if (typeof who.latitude === 'number' && typeof who.longitude === 'number') {
      latitude = who.latitude; longitude = who.longitude;
    }
  }

  if (sec) {
    security.is_datacenter = !!sec.is_datacenter;
    security.is_vpn = !!sec.is_vpn;
    security.is_tor = !!sec.is_tor;
    security.is_proxy = !!sec.is_proxy;
    security.is_abuser = !!sec.is_abuser;
    security.datacenter_name = sec.datacenter?.datacenter || '';
    security.asn_type = sec.company?.type || '';

    if (ip === 'Unknown' && sec.ip) ip = sec.ip;
    if (asn === 'Unknown' && sec.asn?.asn) asn = sec.asn.asn;
    if (asnOwner === 'Unknown' && sec.asn?.org) asnOwner = sec.asn.org;
    if (isp === 'Unknown' && sec.company?.name) isp = sec.company.name;
    if (location.includes('Unknown') && sec.location) {
      const loc = [sec.location.city, sec.location.state, sec.location.country].filter(Boolean).join(', ');
      if (loc) location = loc;
    }
    if (latitude === null && sec.location?.latitude) latitude = sec.location.latitude;
    if (longitude === null && sec.location?.longitude) longitude = sec.location.longitude;
    if (colo === 'Unknown' && sec.location?.city) colo = sec.location.city;
  }

  return { ip, type, location, asn, asnOwner, colo, isp, latitude, longitude, security };
}

async function fetchCfEntryIp() {
  const reqInit = { headers: { 'Accept': 'application/json' }, mode: 'cors' };
  const [whoRes, secRes] = await Promise.all([
    fetch('https://ipwho.is/', reqInit).catch(() => null),
    fetch('https://api.ipapi.is/', reqInit).catch(() => null)
  ]);
  let who = null, sec = null;
  try { if (whoRes?.ok) who = await whoRes.json(); } catch (_) { }
  try { if (secRes?.ok) sec = await secRes.json(); } catch (_) { }

  if (!who && !sec) return null; // both failed
  return parseBrowserIpData(who?.success ? who : null, sec);
}

function renderCfEntryUnavailable() {
  document.getElementById('diagIp').textContent = 'Unavailable';
  document.getElementById('diagLoc').textContent = '—';
  document.getElementById('diagAsn').textContent = '—';
  document.getElementById('diagOrg').textContent = '—';
  document.getElementById('diagColo').textContent = '—';
  document.getElementById('diagIsp').textContent = '—';
  document.getElementById('diagMapContainer').style.display = 'none';
  document.getElementById('securityBadges').innerHTML = '<span class="text-[11px] text-gray-500 italic">API unreachable via browser</span>';
  document.getElementById('datacenterInfo').classList.add('hidden');
}

function switchIpTab(tab) {
  activeIpTab = tab;

  const ingressBtn = document.getElementById('ip-tab-ingress');
  const egressBtn = document.getElementById('ip-tab-egress');
  const activeClass = "flex items-center gap-2 text-xs px-3 py-1.5 rounded-md transition-all font-medium bg-indigo-500/20 border border-indigo-500/30 text-indigo-300 tracking-wide text-left";
  const inactiveClass = "flex items-center gap-2 text-xs px-3 py-1.5 rounded-md transition-all font-medium text-gray-400 hover:text-gray-200 border border-transparent tracking-wide text-left";

  const tabs = ['ingress', 'egress', 'cf-entry'];
  tabs.forEach(t => {
    const btn = document.getElementById('ip-tab-' + t);
    btn.className = t === tab ? activeClass : inactiveClass;
  });

  const data = tab === 'ingress' ? ingressData
    : tab === 'egress' ? egressData
      : cfEntryData;

  const descEl = document.getElementById('ipTabDesc');
  if (tab === 'cf-entry') {
    descEl.innerHTML = '<strong class="text-indigo-300">Client Egress:</strong> The Cloudflare proxy IP that external websites see when you browse through the tunnel. <em>(Note: This is a shared egress IP, not the Anycast IP your client connects to).</em>';
  } else if (tab === 'ingress') {
    descEl.innerHTML = '<strong class="text-indigo-300">Worker Ingress:</strong> The public IP of the Reverse Proxy (Bridge Node) that forwarded your connection into the Cloudflare Worker.';
  } else if (tab === 'egress') {
    descEl.innerHTML = '<strong class="text-indigo-300">Worker Egress:</strong> The Cloudflare datacenter IP used by the Worker itself when it makes background API subrequests.';
  }

  if (tab === 'cf-entry' && !data) {
    renderCfEntryUnavailable();
    return;
  }
  renderIpData(data, currentIpCheckId);
}

function renderIpData(data, scanId) {
  if (!data) return;
  if (scanId !== currentIpCheckId) return;

  document.getElementById('diagIp').innerHTML = data.ip + '<span class="text-[10px] text-gray-500 border border-gray-600 rounded px-1 mt-1.5 w-max block leading-none py-0.5">' + data.type + '</span>';
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

  const badgeClass = "px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border inline-flex items-center gap-1";
  const trueClass = badgeClass + " bg-red-500/10 text-red-400 border-red-500/20";
  const falseClass = badgeClass + " bg-emerald-500/10 text-emerald-400 border-emerald-500/20";
  const warnClass = badgeClass + " bg-amber-500/10 text-amber-400 border-amber-500/20";

  if (sec.is_datacenter) badges.push(`<span class="${warnClass}">Hosting</span>`);
  if (sec.is_vpn) badges.push(`<span class="${trueClass}">VPN</span>`);
  if (sec.is_tor) badges.push(`<span class="${trueClass}">TOR</span>`);
  if (sec.is_proxy) badges.push(`<span class="${trueClass}">Proxy</span>`);
  if (sec.is_abuser) badges.push(`<span class="${trueClass}">⚠️ Abuser</span>`);

  if (badges.length === 0) badges.push(`<span class="${falseClass}">Residential/ISP</span>`);
  document.getElementById('securityBadges').innerHTML = badges.join('');

  if (sec.datacenter_name) {
    const dcEl = document.getElementById('datacenterInfo');
    dcEl.textContent = 'Detected: ' + sec.datacenter_name;
    dcEl.classList.remove('hidden');
  } else {
    document.getElementById('datacenterInfo').classList.add('hidden');
  }

  if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
    const lat = data.latitude;
    const lon = data.longitude;
    const delta = 0.05;
    const bbox = (lon - delta) + ',' + (lat - delta) + ',' + (lon + delta) + ',' + (lat + delta);
    document.getElementById('diagMap').src = 'https://www.openstreetmap.org/export/embed.html?bbox=' + bbox + '&layer=mapnik&marker=' + lat + ',' + lon;
    document.getElementById('diagMapContainer').style.display = 'block';
  } else {
    document.getElementById('diagMapContainer').style.display = 'none';
  }

  // WebRTC Leak Test
  if (!document.getElementById('leakAlert').dataset.scanId || document.getElementById('leakAlert').dataset.scanId !== scanId.toString()) {
    document.getElementById('leakAlert').dataset.scanId = scanId.toString();
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
  delete document.getElementById('leakAlert').dataset.scanId;

  try {
    const [ingressRes, egressRes, cfEntry] = await Promise.all([
      fetch('/services/ingress-ip?token=' + TOKEN).catch(() => null),
      fetch('/services/egress-ip?token=' + TOKEN).catch(() => null),
      fetchCfEntryIp()
    ]);

    if (ingressRes && ingressRes.ok) ingressData = await ingressRes.json();
    if (egressRes && egressRes.ok) egressData = await egressRes.json();
    cfEntryData = cfEntry;

    // Call switchIpTab to handle rendering, description, and unavailable state centrally
    switchIpTab(activeIpTab);
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

  const authEl = document.getElementById('telemetry-auth-section');
  const dashEl = document.getElementById('telemetry-dash-section');
  const loadEl = document.getElementById('telemetry-loading-section');

  if (authEl.style.display === 'none' && dashEl.style.display === 'none') {
    loadEl.style.display = 'flex';
  }

  function showTelemetryAuth() { authEl.style.display = 'flex'; dashEl.style.display = 'none'; loadEl.style.display = 'none'; }
  function showTelemetryDash() { authEl.style.display = 'none'; dashEl.style.display = 'flex'; loadEl.style.display = 'none'; }

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
