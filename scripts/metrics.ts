// metrics.ts
// First load .env
// source .env
// Then Run with: npx tsx scripts/metrics.ts
// Or:       node scripts/metrics.ts

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '';
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? '';

const now = new Date();
const start = new Date();
start.setUTCHours(0, 0, 0, 0);

// ── Helper ───────────────────────────────────────────────────────────────────

async function gql(query: string, variables: Record<string, string>) {
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const raw = await res.json() as any;
  if (raw.errors?.length) {
    console.error('  ✗ GraphQL errors:');
    for (const e of raw.errors) console.error('   ', e.message);
  }
  return raw;
}

function section(title: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`▶ ${title}`);
  console.log('─'.repeat(60));
}

// ── Q1: Account-wide daily totals ────────────────────────────────────────────
// Everything you can get from sum{} and quantiles{} in one shot.

async function q1_totals() {
  section('Q1 · Account-wide totals (sum + quantiles)');

  const raw = await gql(`
    query($accountId: string!, $start: string!, $end: string!) {
      viewer {
        accounts(filter: {accountTag: $accountId}) {
          workersInvocationsAdaptive(limit: 10000, filter: {
            datetime_geq: $start,
            datetime_leq: $end
          }) {
            sum { requests errors subrequests }
            quantiles { cpuTimeP25 cpuTimeP50 cpuTimeP75 cpuTimeP90 cpuTimeP99 cpuTimeP999 }
          }
        }
      }
    }
  `, { accountId: ACCOUNT_ID, start: start.toISOString(), end: now.toISOString() });

  const rows: any[] = raw?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  console.log(`Rows returned: ${rows.length}`);

  const totals = rows.reduce((acc, r) => ({
    requests: acc.requests + (r.sum?.requests ?? 0),
    errors: acc.errors + (r.sum?.errors ?? 0),
    subrequests: acc.subrequests + (r.sum?.subrequests ?? 0),
  }), { requests: 0, errors: 0, subrequests: 0 });

  // quantiles: median across rows (rough — just show the last row's for reference)
  const lastQ = rows[rows.length - 1]?.quantiles ?? {};

  console.log('Totals:', totals);
  console.log('Error rate:', totals.requests
    ? `${((totals.errors / totals.requests) * 100).toFixed(2)}%`
    : 'n/a');
  console.log('CPU quantiles (last sample row, µs):', lastQ);
}

// ── Q2: Per-script breakdown ─────────────────────────────────────────────────
// Which Worker is getting how many requests / errors.

async function q2_per_script() {
  section('Q2 · Per-script breakdown (dimensions.scriptName)');

  const raw = await gql(`
    query($accountId: string!, $start: string!, $end: string!) {
      viewer {
        accounts(filter: {accountTag: $accountId}) {
          workersInvocationsAdaptive(limit: 10000, filter: {
            datetime_geq: $start,
            datetime_leq: $end
          }) {
            dimensions { scriptName }
            sum { requests errors subrequests }
            quantiles { cpuTimeP50 cpuTimeP99 }
          }
        }
      }
    }
  `, { accountId: ACCOUNT_ID, start: start.toISOString(), end: now.toISOString() });

  const rows: any[] = raw?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

  // Aggregate per script
  const scripts: Record<string, { requests: number; errors: number; subrequests: number }> = {};
  for (const r of rows) {
    const name = r.dimensions?.scriptName ?? '(unknown)';
    if (!scripts[name]) scripts[name] = { requests: 0, errors: 0, subrequests: 0 };
    scripts[name].requests += r.sum?.requests ?? 0;
    scripts[name].errors += r.sum?.errors ?? 0;
    scripts[name].subrequests += r.sum?.subrequests ?? 0;
  }

  const sorted = Object.entries(scripts).sort((a, b) => b[1].requests - a[1].requests);
  console.log(`Distinct scripts: ${sorted.length}`);
  for (const [name, s] of sorted) {
    const errRate = s.requests ? ((s.errors / s.requests) * 100).toFixed(1) : '0.0';
    console.log(`  ${name.padEnd(40)} req=${s.requests}  err=${s.errors} (${errRate}%)  subReq=${s.subrequests}`);
  }
}

// ── Q3: Status breakdown ─────────────────────────────────────────────────────
// Invocation outcomes: success / scriptThrewException / exceededCpu / etc.

async function q3_status() {
  section('Q3 · Invocation status breakdown (dimensions.status)');

  const raw = await gql(`
    query($accountId: string!, $start: string!, $end: string!) {
      viewer {
        accounts(filter: {accountTag: $accountId}) {
          workersInvocationsAdaptive(limit: 10000, filter: {
            datetime_geq: $start,
            datetime_leq: $end
          }) {
            dimensions { status }
            sum { requests }
          }
        }
      }
    }
  `, { accountId: ACCOUNT_ID, start: start.toISOString(), end: now.toISOString() });

  const rows: any[] = raw?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

  const byStatus: Record<string, number> = {};
  for (const r of rows) {
    const s = r.dimensions?.status ?? '(unknown)';
    byStatus[s] = (byStatus[s] ?? 0) + (r.sum?.requests ?? 0);
  }

  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const sorted = Object.entries(byStatus).sort((a, b) => b[1] - a[1]);
  console.log(`Total requests: ${total}`);
  for (const [status, count] of sorted) {
    const pct = total ? ((count / total) * 100).toFixed(2) : '0.00';
    console.log(`  ${status.padEnd(30)} ${count.toString().padStart(8)}  (${pct}%)`);
  }
  // Possible statuses you might see:
  // success | scriptThrewException | exceededCpu | exceededMemory | internalError | canceled
}

// ── Q4: Script × status heatmap ──────────────────────────────────────────────
// Which script is producing which error type.

async function q4_script_x_status() {
  section('Q4 · Script × status (errors per script by type)');

  const raw = await gql(`
    query($accountId: string!, $start: string!, $end: string!) {
      viewer {
        accounts(filter: {accountTag: $accountId}) {
          workersInvocationsAdaptive(limit: 10000, filter: {
            datetime_geq: $start,
            datetime_leq: $end,
            status_neq: "success"
          }) {
            dimensions { scriptName status }
            sum { requests }
          }
        }
      }
    }
  `, { accountId: ACCOUNT_ID, start: start.toISOString(), end: now.toISOString() });

  const rows: any[] = raw?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];
  if (rows.length === 0) {
    console.log('  No non-success invocations found today 🎉');
    return;
  }

  for (const r of rows) {
    const script = r.dimensions?.scriptName ?? '(unknown)';
    const status = r.dimensions?.status ?? '(unknown)';
    const count = r.sum?.requests ?? 0;
    console.log(`  ${script.padEnd(40)} ${status.padEnd(25)} ×${count}`);
  }
}

// ── Q5: Hourly time series ───────────────────────────────────────────────────
// Request volume and error rate per hour today.

async function q5_hourly() {
  section('Q5 · Hourly request volume today (dimensions.datetimeHour)');

  // Note: for time-series you normally want a *Groups dataset, but
  // workersInvocationsAdaptive can still be bucketed via datetimeHour dimension.
  const raw = await gql(`
    query($accountId: string!, $start: string!, $end: string!) {
      viewer {
        accounts(filter: {accountTag: $accountId}) {
          workersInvocationsAdaptive(limit: 10000, filter: {
            datetime_geq: $start,
            datetime_leq: $end
          }) {
            dimensions { datetimeHour }
            sum { requests errors }
          }
        }
      }
    }
  `, { accountId: ACCOUNT_ID, start: start.toISOString(), end: now.toISOString() });

  const rows: any[] = raw?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? [];

  const byHour: Record<string, { requests: number; errors: number }> = {};
  for (const r of rows) {
    const h = r.dimensions?.datetimeHour ?? '(unknown)';
    if (!byHour[h]) byHour[h] = { requests: 0, errors: 0 };
    byHour[h].requests += r.sum?.requests ?? 0;
    byHour[h].errors += r.sum?.errors ?? 0;
  }

  const hours = Object.keys(byHour).sort();
  for (const h of hours) {
    const { requests, errors } = byHour[h];
    const bar = '█'.repeat(Math.ceil(requests / 100)).slice(0, 40);
    console.log(`  ${h}  req=${String(requests).padStart(6)}  err=${String(errors).padStart(4)}  ${bar}`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

(async () => {
  if (ACCOUNT_ID === 'YOUR_ACCOUNT_ID') {
    console.error('Set CF_ACCOUNT_ID and CF_API_TOKEN env vars.');
    process.exit(1);
  }

  console.log(`Period: ${start.toISOString()} → ${now.toISOString()}\n`);

  await q1_totals();
  await q2_per_script();
  await q3_status();
  await q4_script_x_status();
  await q5_hourly();

  console.log('\nDone.');
})();