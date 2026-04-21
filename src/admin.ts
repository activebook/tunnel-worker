// ── Admin Portal — presentation and mutation layer ───────────────────────────
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
 * @param token - The validated admin token, embedded into the client-side
 *                fetch call so the browser can POST mutations back.
 */
export function renderAdminUI(token: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Edge Topology Controller</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:      #09090b;
    --surface: rgba(24, 24, 27, 0.72);
    --primary: #3b82f6;
    --text:    #f4f4f5;
    --muted:   #a1a1aa;
    --border:  rgba(63, 63, 70, 0.4);
  }

  *, *::before, *::after { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--bg)
      radial-gradient(circle at top right,    rgba(59,130,246,.10), transparent 40%)
      radial-gradient(circle at bottom left,  rgba(139,92,246,.10), transparent 40%);
    color: var(--text);
    font-family: 'Inter', sans-serif;
    display: flex;
    justify-content: center;
    align-items: center;
    min-height: 100vh;
  }

  /* Glassmorphic card */
  .panel {
    background: var(--surface);
    backdrop-filter: blur(18px);
    -webkit-backdrop-filter: blur(18px);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 2.5rem;
    width: min(440px, calc(100vw - 2rem));
    box-shadow: 0 25px 50px -12px rgba(0,0,0,.55);
  }

  h1 { font-size: 1.4rem; font-weight: 600; margin: 0 0 .25rem; letter-spacing: -.02em; }
  .subtitle { color: var(--muted); font-size: .875rem; margin: 0 0 2rem; }

  /* Read-only UUID display */
  .field { margin-bottom: 1.5rem; }
  label  { display: block; font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; font-weight: 600; color: var(--muted); margin-bottom: .55rem; }

  .uuid-row {
    display: flex;
    gap: .5rem;
    align-items: stretch;
  }

  /* The UUID is read-only — value only changes via "Regenerate" */
  .uuid-display {
    flex: 1;
    background: rgba(0,0,0,.3);
    border: 1px solid var(--border);
    color: var(--muted);
    padding: .75rem 1rem;
    border-radius: 8px;
    font-family: monospace;
    font-size: .875rem;
    cursor: default;
    user-select: all;           /* allow copy but not accidental edit */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Buttons */
  .btn {
    border: none; cursor: pointer; border-radius: 8px;
    font-weight: 600; font-size: .875rem; letter-spacing: .02em;
    transition: background .2s, transform .1s;
    padding: .75rem 1rem;
  }
  .btn:active { transform: scale(.97); }

  .btn-icon {
    background: rgba(59,130,246,.15);
    color: var(--primary);
    border: 1px solid rgba(59,130,246,.3);
    flex-shrink: 0;
    font-size: 1rem;
    line-height: 1;
  }
  .btn-icon:hover { background: rgba(59,130,246,.25); }

  .btn-primary {
    width: 100%;
    background: var(--primary);
    color: #fff;
  }
  .btn-primary:hover  { background: #2563eb; }
  .btn-primary:disabled { opacity: .55; cursor: not-allowed; }

  /* Save button sits below the UUID row with a small gap */
  .save-row { margin-top: .75rem; }

  /* Status pill */
  .status {
    margin-top: .9rem; font-size: .85rem; text-align: center;
    min-height: 1.2em; opacity: 0; transition: opacity .3s;
  }
  .status.show { opacity: 1; }
  .ok  { color: #34d399; }
  .err { color: #f87171; }
</style>
</head>
<body>
<div class="panel">
  <h1>Edge Topology Controller</h1>
  <p class="subtitle">Dynamic infrastructure configuration</p>

  <div class="field">
    <label>Connection Token (read-only — regenerate to rotate)</label>
    <div class="uuid-row">
      <!-- Value injected server-side from KV; not editable -->
      <div class="uuid-display" id="uuid" title="Click to copy"></div>
      <button class="btn btn-icon" id="regenBtn" title="Generate a new token" onclick="regenerate()">⟳</button>
    </div>
    <div class="save-row">
      <button class="btn btn-primary" id="saveBtn" onclick="save()">Save &amp; Propagate</button>
    </div>
  </div>

  <div id="status" class="status"></div>
</div>

<script>
  // Populated server-side so the page never has a window of showing nothing
  let pendingUuid = '';

  // ── Initialise display on load ──────────────────────────────────────────
  (async () => {
    try {
      const r = await fetch('/admin/api?token=${token}');
      if (r.ok) {
        const { uuid } = await r.json();
        setDisplay(uuid);
      }
    } catch (_) {
      setDisplay('(failed to load)');
    }
  })();

  function setDisplay(value) {
    pendingUuid = value;
    document.getElementById('uuid').textContent = value;
  }

  // Generate a RFC-4122 v4 UUID entirely in the browser — no server trip
  function regenerate() {
    const newId = crypto.randomUUID();
    setDisplay(newId);
    flash('Token regenerated — click Save to commit.', 'ok');
  }

  // Copy to clipboard on click
  document.getElementById('uuid').addEventListener('click', async () => {
    if (!pendingUuid) return;
    await navigator.clipboard.writeText(pendingUuid);
    flash('Copied to clipboard.', 'ok');
  });

  // ── Persist to KV via POST ──────────────────────────────────────────────
  async function save() {
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      const r = await fetch('/admin/api?token=${token}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uuid: pendingUuid }),
      });
      r.ok
        ? flash('Saved. New token is active globally.', 'ok')
        : flash('Server rejected the update.', 'err');
    } catch (_) {
      flash('Network error — check connectivity.', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save & Propagate';
    }
  }

  function flash(msg, cls) {
    const el = document.getElementById('status');
    el.textContent = msg;
    el.className = 'status show ' + cls;
    setTimeout(() => { el.className = 'status'; }, 5000);
  }
</script>
</body>
</html>`;
}
