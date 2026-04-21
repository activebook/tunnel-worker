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
<title>Edge Topology Controller</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
<!-- Lightweight QR code renderer (no build step, edge-compatible CDN) -->
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"></script>
<style>
  :root {
    --bg:      #09090b;
    --surface: rgba(24, 24, 27, 0.72);
    --primary: #3b82f6;
    --text:    #f4f4f5;
    --muted:   #a1a1aa;
    --border:  rgba(63, 63, 70, 0.4);
    --green:   #34d399;
    --red:     #f87171;
    --accent:  #8b5cf6;
  }

  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--bg)
      radial-gradient(circle at top right,   rgba(59,130,246,.10), transparent 40%)
      radial-gradient(circle at bottom left, rgba(139,92,246,.10), transparent 40%);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    min-height: 100vh;
    padding: 2rem 1rem;
  }

  /* Glassmorphic card */
  .panel {
    background: var(--surface);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 2.5rem;
    width: min(480px, 100%);
    box-shadow: 0 25px 50px -12px rgba(0,0,0,.55);
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
  }

  header { margin: 0; }
  h1 { font-size: 1.4rem; font-weight: 600; margin: 0 0 .2rem; letter-spacing: -.02em; }
  .subtitle { color: var(--muted); font-size: .875rem; margin: 0; }

  /* Section divider */
  hr { border: none; border-top: 1px solid var(--border); margin: 0; }

  /* Field group */
  .field { display: flex; flex-direction: column; gap: .55rem; }
  label  { font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; font-weight: 600; color: var(--muted); }

  .row { display: flex; gap: .5rem; align-items: stretch; }

  /* Monospace display box — read-only */
  .mono-box {
    flex: 1;
    background: rgba(0,0,0,.3);
    border: 1px solid var(--border);
    color: var(--muted);
    padding: .75rem 1rem;
    border-radius: 8px;
    font-family: monospace;
    font-size: .82rem;
    cursor: default;
    user-select: all;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }

  /* Buttons */
  .btn {
    border: none; cursor: pointer; border-radius: 8px;
    font-weight: 600; font-size: .875rem; letter-spacing: .02em;
    transition: background .2s, transform .1s;
    padding: .75rem 1rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .btn:active { transform: scale(.97); }

  .btn-icon {
    background: rgba(59,130,246,.15);
    color: var(--primary);
    border: 1px solid rgba(59,130,246,.3);
    font-size: 1rem; line-height: 1;
  }
  .btn-icon:hover { background: rgba(59,130,246,.25); }

  .btn-primary { background: var(--primary); color: #fff; width: 100%; }
  .btn-primary:hover    { background: #2563eb; }
  .btn-primary:disabled { opacity: .55; cursor: not-allowed; }

  .btn-accent { background: rgba(139,92,246,.15); color: var(--accent); border: 1px solid rgba(139,92,246,.3); width: 100%; }
  .btn-accent:hover { background: rgba(139,92,246,.25); }
  .btn-accent:disabled { opacity: .55; cursor: not-allowed; }

  .btn-copy {
    background: rgba(52,211,153,.12);
    color: var(--green);
    border: 1px solid rgba(52,211,153,.3);
    font-size: .8rem;
    padding: .6rem .9rem;
  }
  .btn-copy:hover { background: rgba(52,211,153,.22); }

  /* QR code container */
  .qr-wrap {
    display: flex;
    justify-content: center;
    padding: .5rem 0;
  }
  #qr canvas, #qr img {
    border-radius: 10px;
    background: #fff;
    padding: 10px;
  }

  /* Status pill */
  .status {
    font-size: .85rem; text-align: center;
    min-height: 1.1em; opacity: 0; transition: opacity .3s;
  }
  .status.show  { opacity: 1; }
  .ok  { color: var(--green); }
  .err { color: var(--red); }
</style>
</head>
<body>
<div class="panel">

  <header>
    <h1>Edge Topology Controller</h1>
    <p class="subtitle">Autonomous proxy matrix & route optimization</p>
  </header>

  <hr>

  <!-- ── VLESS Authentication Matrix ────────────────────────────────────── -->
  <div class="field">
    <label>Connection Token (read-only)</label>
    <div class="row">
      <div class="mono-box" id="uuidDisplay" title="Click to copy" onclick="copyText(this)"></div>
      <button class="btn btn-icon" title="Generate new token" onclick="regenerate()">⟳</button>
    </div>
    <button class="btn btn-primary" id="saveBtn" onclick="save()">Save &amp; Propagate Token</button>
  </div>

  <hr>

  <!-- ── Upstream Node Synchronization ───────────────────────────────────── -->
  <div class="field">
    <label>Cloudflare Preferred IP Crawler</label>
    <button class="btn btn-accent" id="syncBtn" onclick="syncIps()">Force Sync Upstream Nodes</button>
  </div>

  <hr>

  <!-- ── Base64 Subscription Endpoint (Multiplexed) ──────────────────────── -->
  <div class="field">
    <label>V2Ray/Clash Base64 Subscription</label>
    <div class="row">
      <div class="mono-box" id="subLink" title="Click to copy" onclick="copyText(this)"></div>
      <button class="btn btn-copy" onclick="copyText(document.getElementById('subLink'))">Copy</button>
    </div>
    <div class="qr-wrap">
      <div id="qr"></div>
    </div>
  </div>

  <div id="status" class="status"></div>

</div>

<script>
  const HOST  = '${hostname}';
  const TOKEN = '${token}';

  let pendingUuid = '';
  let qrInstance  = null;

  // Synthesis of the global subscription URL
  const SUB_URI = \`https://\${HOST}/sub?token=\${TOKEN}\`;

  function applyUuid(uuid) {
    pendingUuid = uuid;
    document.getElementById('uuidDisplay').textContent = uuid;

    // The subscription endpoint abstracts all VLESS parameters natively;
    // clients only need this one URL to fetch the base64 matrix.
    document.getElementById('subLink').textContent = SUB_URI;

    const qrEl = document.getElementById('qr');
    qrEl.innerHTML = '';
    qrInstance = new QRCode(qrEl, {
      text:           SUB_URI,
      width:          200,
      height:         200,
      colorDark:      '#000000',
      colorLight:     '#ffffff',
      correctLevel:   QRCode.CorrectLevel.M,
    });
  }

  (async () => {
    try {
      const r = await fetch('/admin/api?token=' + TOKEN);
      if (r.ok) {
        const { uuid } = await r.json();
        if (uuid) applyUuid(uuid);
      }
    } catch (_) {
      flash('Failed to load cryptographic token.', 'err');
    }
  })();

  function regenerate() {
    applyUuid(crypto.randomUUID());
    flash('New token formulated locally — hit Save to commit to edge.', 'ok');
  }

  async function save() {
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const r = await fetch('/admin/api?token=' + TOKEN, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ uuid: pendingUuid }),
      });
      r.ok
        ? flash('Token mutation activated across Anycast edge.', 'ok')
        : flash('Network anomaly — edge rejected update.', 'err');
    } catch (_) {
      flash('Network failure.', 'err');
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Save & Propagate Token';
    }
  }

  // ── Trigger autonomous worker crawl and sync ─────────────────────────────
  async function syncIps() {
    const btn = document.getElementById('syncBtn');
    btn.disabled = true;
    btn.textContent = 'Crawling Upstream Repositories...';
    try {
      const r = await fetch('/admin/api/sync?token=' + TOKEN, { method: 'POST' });
      if (r.ok) {
        const payload = await r.json();
        flash(\`Sync Absolute: Hydrated subscription with \${payload.count} prime nodes.\`, 'ok');
      } else {
        flash('Upstream matrices unresponsive — retaining cached nodes.', 'err');
      }
    } catch (_) {
      flash('Crawler exception — verify edge connectivity.', 'err');
    } finally {
      btn.disabled    = false;
      btn.textContent = 'Force Sync Upstream Nodes';
    }
  }

  async function copyText(el) {
    const text = el.textContent.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flash('URI copied to clipboard buffer.', 'ok');
    } catch (_) {
      flash('Clipboard exception — select manually.', 'err');
    }
  }

  function flash(msg, cls) {
    const el = document.getElementById('status');
    el.textContent  = msg;
    el.className    = 'status show ' + cls;
    setTimeout(() => { el.className = 'status'; }, 5000);
  }
</script>
</body>
</html>`;
}
