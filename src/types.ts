// ── Shared type definitions ──────────────────────────────────────────────────
//
// Centralising all interfaces here prevents the Env duplication that previously
// existed across worker.ts and proxy.ts, and gives TypeScript a single source
// of truth for every binding declared in wrangler.toml.

/** Cloudflare Worker bindings declared in wrangler.toml */
export interface Env {
  /** KV namespace holding runtime-configurable values (UUID, admin token, preferred IPs) */
  TUNNEL: KVNamespace;
}

/** Parsed destination extracted from the binary protocol header */
export interface Destination {
  address: string;
  port: number;
}

/** Represents a tested Preferred IP node with its latency */
export interface PreferredIP {
  ip: string;
  latency: number;
}

/** Represents a tested Reverse Proxy IP node with its latency */
export interface ReverseProxyIP {
  ip: string;
  latency: number;
}
