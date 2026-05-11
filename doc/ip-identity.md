# IP Identity & Network Diagnostics Explained

This document explains a subtle but architecturally significant behaviour you will
observe in the **Diagnostics → Network Identity** panel of the Admin Portal when a proxy
client (Clash, Sing-box, etc.) is active. Understanding it requires tracing the exact
path a request takes through the tunnel stack, and distinguishing between two separate
Worker invocations **plus** a third, browser-originated path.

---

## 1. Background: What `/services/ingress-ip` and `/services/egress-ip` Report

Both endpoints are implemented in `src/handlers/services.ts` and share the same enrichment
helper, but they differ fundamentally in **what IP they observe**.

### `/services/ingress-ip` — The Bridge Node's Identity

```typescript
// GET /services/ingress-ip — return Ingress IP location info (bridge node)
const ip = (request.headers.get('cf-connecting-ip') || 'Unknown').split(',')[0].trim();
return Response.json(await fetchIdentityInfo(ip, cf));
```

`cf-connecting-ip` is a header automatically injected by the **Cloudflare Edge** on
every inbound HTTP request. It contains the **public IP address of the TCP peer that
physically connected to the CF Edge PoP** — i.e., the last network hop before the Edge.

**The critical insight:** When proxied through Clash, this is never the user's home IP.
Because traffic flows through the Bridge Node before reaching CF Edge, `cf-connecting-ip`
reflects the **Bridge Node's IP** (the reverse proxy server, e.g. HostPapa, Azure).

### `/services/egress-ip` — The Bridge-Reached CF PoP's Outbound Identity

```typescript
// GET /services/egress-ip — return egress IP location info (CF edge node)
// We pass an empty {} for cf because request.cf belongs to the inbound reverse proxy connection.
return Response.json(await fetchIdentityInfo(null, {}));
```

When `targetIp` is `null`, the helper calls `fetch('https://ipapi.is/')` with no explicit
target. The external API observes the IP of the caller — which is the **Cloudflare Worker
itself** — and returns the CF PoP's outbound IP (AS13335 Cloudflare, Inc.).

**The critical architectural nuance:** Because `/services/egress-ip` is accessed through
the same proxy pipeline as `/services/ingress-ip` (i.e., Clash → CF → Bridge → CF Edge),
the Worker that executes the outbound `fetch()` is running in the **CF PoP that the Bridge
Node reached (PoP B)**, *not* the CF PoP that Clash originally connected to (PoP A).

This means the egress IP is the outbound IP of **the CF PoP the Bridge selected**, not the
Anycast entry point your Clash client is directly tunneling into. Both are Cloudflare IPs
(AS13335), but they may reside in different physical datacenters.

The Worker enriches the observed IP with geographic and ASN data via two external APIs:

- `https://ipwho.is/{ip}` — location, ISP, ASN, IP type
- `https://api.ipapi.is/?q={ip}` — security flags (VPN, datacenter, Tor, proxy, abuser)

**The critical insight:** `cf-connecting-ip` does not always equal the user's real home
IP. It equals the IP of whoever physically made the final TCP connection to the CF Edge.

---

## 2. The Two Observable States

### State A — Clash / Sing-box OFF (Direct Access)

```
Browser (Local)
  └─► TCP directly to Cloudflare Edge
            │
      cf-connecting-ip = Local public IP
            │
            ▼
      Worker → handleServices → returns Local IP
```

The browser connects directly to the CF Edge. `cf-connecting-ip` is the user's real
home IP. The Diagnostics panel correctly shows the Local ISP and location.

### State B — Clash / Sing-box ON (Proxied Access)

```
Browser (Local)
  └─► Clash intercepts ALL outbound traffic (TUN / system proxy)
            │
            │  Clash uses CF Worker as its proxy server
            ▼
   ┌─ Invocation A ──────────────────────────────────────────────┐
   │  WebSocket upgrade (VLESS) → handleProxy                    │
   │  parseVlessHeader: dest = workers.dev:443                   │
   │  connectTo(workers.dev, 443)                                │
   │    ├─ direct attempt → CF→CF BLOCKED                       │
   │    └─ AUTO fallback → bridgeConnect()                       │
   │              │                                              │
   │              └─► Bridge IP (HostPapa / Azure / etc.)        │
   │                    SNI relay → CF Edge (PoP B)              │
   └─────────────────────────────────────────────────────────────┘
                            │
                   ┌─ Invocation B ─────────────────────────────────────────┐
                   │  New HTTP GET (handleServices) at CF PoP B             │
                   │  cf-connecting-ip = Bridge Node IP                     │
                   │                                                        │
                   │  ├─ /services/ingress-ip                               │
                   │  │    Returns: Bridge ASN (Microsoft, HostPapa, etc.)  │
                   │  │                                                     │
                   │  └─ /services/egress-ip                               │
                   │       fetch(ipapi.is) from PoP B                      │
                   │       Returns: CF PoP B's outbound IP (AS13335)        │
                   │       ⚠ This is PoP B (Bridge→CF), NOT the Clash      │
                   │         entry PoP A (Clash→CF) the user tunnels into   │
                   └────────────────────────────────────────────────────────┘
```

---

## 3. The Three-Path Observation Model (Key Concept)

This is the most important concept to understand. There are **two separate Worker
`fetch()` invocations plus one browser-originated fetch**, each revealing a different
identity in the proxy stack.

### Invocation A — The VLESS WebSocket (from Clash)

Clash establishes a WebSocket to the CF Worker. In `worker.ts`, the router checks:

```typescript
// Upgrade: websocket → TRUE → takes WebSocket branch
handleProxy(webSocket, ctx, expectedUuid, reverseIps, settings.routingPolicy, earlyData);
```

`handleProxy` runs. The VLESS header declares destination = `your-worker.workers.dev:443`.
`connectTo()` is called here. The routing policy governs this call.

### Invocation B — The Inner HTTP GET (`/services/ingress-ip`)

The browser's actual HTTPS request travels through the TCP tunnel established in
Invocation A. When it arrives at the CF Edge via the bridge node, it triggers a brand
new `Worker.fetch()`:

```typescript
// No Upgrade header, pathname = '/services/ingress-ip'
// url.pathname.startsWith('/services') → TRUE
return handleServices(request, env); // connectTo() is NEVER called here
```

`handleServices` reads `cf-connecting-ip`, which is the IP of whoever made the TCP
connection in Invocation A — the bridge node. `connectTo()` is never called within
this invocation.

### Why the Bridge is Structurally Inevitable

Because Clash always routes through the CF Worker as proxy, **every** browser request
(including the admin panel) must pass through the VLESS tunnel. Inside the tunnel, the
CF Worker always tries to `connect()` to `your-worker.workers.dev:443` — which is
itself. Cloudflare's CF→CF loopback restriction blocks this. The bridge is not
optional: it is the only exit from a structurally forced dead-end.

---

## 4. Step-by-Step Trace

### Step 1 — Clash Intercepts the Browser Request

Clash (TUN or system proxy) captures the browser's `GET /services/ingress-ip` before it
reaches the network interface. It routes it through the configured proxy outbound —
the CF Worker VLESS endpoint.

### Step 2 — VLESS Session Established (Invocation A)

Clash opens a WebSocket to the CF Edge (via a CF Anycast IP). `worker.ts` routes this
as a WebSocket upgrade → `handleProxy`. The VLESS header is parsed:

- **address:** `your-worker.workers.dev`
- **port:** `443`
- **initialPayload:** the browser's raw TLS `ClientHello`

### Step 3 — CF→CF Loopback Fails

`connectTo()` attempts a direct TCP connection:

```typescript
// proxy.ts
const socket = connect({ hostname: 'your-worker.workers.dev', port: 443 });
await socket.opened; // ← THROWS — CF blocks Worker→Worker loopback
```

The `socket.opened` promise rejects. `directError` is thrown.

### Step 4 — AUTO Policy Falls Back to Bridge

```typescript
// proxy.ts
if (routingPolicy === 'AUTO' && canBridge) {
  return await bridgeConnect(); // ← only viable exit
}
```

A Reverse Proxy IP (non-CF: HostPapa, Azure, Vultr, etc.) is selected from KV. This
SNI-aware TCP relay:

1. Accepts the TCP connection from the CF Worker.
2. Reads the TLS `ClientHello` SNI (`your-worker.workers.dev`).
3. Opens a new TCP connection to the actual CF Edge for that domain.
4. Forwards all bytes bidirectionally without decryption.

### Step 5 — Inner HTTP Request Arrives (Invocation B)

The CF Edge receives a TLS connection from the bridge node's IP. It terminates TLS and
sees a plain `GET /services/ingress-ip`. A new `Worker.fetch()` is invoked:

- `cf-connecting-ip` = **Bridge node's public IP**
- `url.pathname.startsWith('/services')` → `handleServices`
- `connectTo()` is **never called** in this invocation

### Step 6 — Diagnostics Panel Shows Bridge IP

`handleServices` enriches the bridge IP via `ipwho.is` / `ipapi.is`:

- **`asn`** → bridge provider's ASN (e.g., `AS8075` Microsoft Azure, `AS36352` HostPapa)
- **`asnOwner`** → `"Microsoft Corporation"` or `"HostPapa Inc."` etc.
- **`security.is_datacenter`** → `true`
- **`location`** → US or EU datacenter city

---

## 5. The "TLS-in-TLS" Limitation & Health Check Shortcut

A common question is: *Why can't `handleProxy` just intercept the request for `/services/ingress-ip` directly, without connecting to anything?*

The answer lies in the distinction between Layer 4 (Transport) and Layer 7 (Application) networking.

### The TLS-in-TLS Blocker
When Clash routes an **HTTPS** request (Port 443) through the proxy, the `handleProxy` function only sees the **Layer 4** VLESS/Trojan header:
- `address`: `your-worker.workers.dev`
- `port`: `443`

The rest of the payload is an encrypted **Inner TLS** `ClientHello`. The Worker cannot decrypt this inner TLS payload to read the `/services/ingress-ip` path or any HTTP parameters. Because it is completely blind to the Layer 7 contents, it cannot natively fulfill the request. Its only option is to act as a **blind pipe** and forward the encrypted bytes to a destination that *can* terminate the TLS (the CF Edge, via the reverse bridge).

### The Health Check Shortcut (Port 80)
The Worker *does* actually intercept some requests directly, but only for plain HTTP (Port 80).

In `proxy.ts`, there is logic to intercept Android/Chrome captive portal health checks (e.g., `www.gstatic.com` on Port 80). Because Clash packages HTTP and HTTPS the exact same way at the routing level, it puts the domain and port into the unencrypted VLESS header.

The Worker simply checks if `port === 80` and `address === 'www.gstatic.com'`. It doesn't even bother reading the HTTP payload to see the specific path (like `/generate_204`). It just blindly returns a synthetic `HTTP/1.1 204 No Content` response and closes the connection. This works exclusively because the destination address and port in the unencrypted header are enough to confidently identify a health check, entirely bypassing the need to read the path.

---

## 6. The Routing Policy Dimension

The `routingPolicy` setting governs what happens in Step 3–4 of **Invocation A** only.
It has zero effect on Invocation B's `handleServices` logic.

| Policy | Invocation A behaviour | Practical result |
|:---|:---|:---|
| **`AUTO`** (default) | Tries direct → loopback fails → bridge fallback | ✅ Works. Bridge IP shown in diagnostics |
| **`BRIDGE`** | Skips direct, always uses bridge immediately | ✅ Works. Bridge IP shown in diagnostics |
| **`DIRECT`** | Tries direct → loopback fails → **no fallback, throws** | ❌ **Entire site fails to load** |

### Empirical Proof: DIRECT Policy Breaks Everything

With `DIRECT` policy active while Clash is running, the failure is total and immediate:

```
connectTo(workers.dev:443)
  ├─ direct attempt → CF loopback BLOCKED
  └─ DIRECT policy: no bridge fallback
        │
        ▼
   throw directError
        │
        ▼
   webSocket.close(1011, 'TCP connect failed')
        │
        ▼
   Clash: connection error
        │
        ▼
   Browser: ERR_CONNECTION_FAILED — site entirely unreachable
```

This was empirically verified: switching to `DIRECT` policy with an active Clash client
causes the entire worker domain to become unreachable. Switching back to `AUTO` or
`BRIDGE` immediately restores connectivity. **`DIRECT` is therefore incompatible with
using the CF Worker as a Clash/Sing-box proxy target.**

---

## 7. Why This is Correct Proxy Behaviour

The bridge IP appearing in diagnostics is not a bug — it is the intended behaviour of a
working proxy. The proxy's job is to make the destination see the exit node's IP, not
the client's real IP.

| Observer | IP they see | Reason |
|:---|:---|:---|
| CF Edge (VLESS WebSocket ingress) | Client's real Local IP | Clash connects directly from Local to CF Edge (PoP A) for the WebSocket |
| Target website (google.com, etc.) | Bridge node IP | All proxied traffic exits through the Bridge |
| `/services/ingress-ip` when Clash ON | Bridge node IP | Reads `cf-connecting-ip` from the proxied request; last hop was the Bridge |
| `/services/ingress-ip` when Clash OFF | Client's real Local IP | Direct connection to CF; `cf-connecting-ip` is the user's home IP |
| `/services/egress-ip` when Clash ON | CF PoP B's outbound IP (AS13335) | Worker in PoP B (Bridge→CF) calls `fetch(ipapi.is)` — this is **not** Clash's PoP A |
| 🚀 Client browser `fetch()` | CF Proxy Egress Pool (AS13335) | `admin.js` calls `fetch(ipwho.is)` via Clash → Worker. The outbound traffic exits via a shared egress pool (e.g., WARP/Gateway), **not** the ingress Anycast IP. |

The user's real IP is only exposed to the CF Edge that terminates the outermost VLESS
WebSocket — and that information is never forwarded to any destination.

---

## 8. The Triple IP Diagnostic System

The Admin Portal's **Network Identity** panel exposes three distinct tabs, each revealing
a different layer of the proxy's network identity:

### 🚀 Client Egress (WARP/Gateway)

**Mechanism:** A `fetch('https://ipwho.is/')` call issued **directly from `admin.js`**
in the user's browser. Because the browser runs under Clash's TUN mode, this request is
routed through the VLESS tunnel to the Anycast entry node (e.g. `162.159.192.1`). The Worker
there then extracts the destination and calls `connectTo(ipwho.is)`.

> **⚠ Anycast Ingress vs Datacenter Egress:** The IP shown here (e.g. `104.28.152.116`) will **not** be the Anycast IP you put in your Clash `sub.ts` yaml.
>
> When the Worker initiates an outbound connection on behalf of the proxy, that traffic exits Cloudflare's network via a shared **Datacenter Egress IP pool** (like the `104.28.x.x` WARP/Gateway pool). The Anycast IPs (`162.159.x.x`) are used strictly for **ingress** traffic globally, and can never act as the source IP for outbound requests.

### 🌐 Worker Ingress (Bridge Node)

**Mechanism:** Reads `cf-connecting-ip` from the inbound request headers at CF PoP B.
Because all admin panel traffic is proxied through Clash → Bridge → CF, the last hop
before CF Edge is always the Bridge Node. Shows the Bridge's ASN (e.g., Microsoft Azure,
HostPapa).

### ☁️ Worker Egress (CF Subrequests)

**Mechanism:** The CF Worker in PoP B calls `fetch('https://api.ipapi.is/')` outbound.
The API sees PoP B's outbound IP (AS13335 Cloudflare, Inc.).

> **⚠ Architectural Nuance:** This is **not** Clash's PoP A. Because the request itself
> was routed via the Bridge to PoP B, the Worker running here is PoP B's Worker — not
> the Anycast entry point Clash directly connects to. In practice both are AS13335, but
> may show different datacenter cities.

---

## 9. Visual Summary

```text
╔══════════════════════════════════════════════════════════════════════╗
║                    CLASH / SING-BOX ACTIVE                          ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  [Browser] ──► [Clash TUN / System Proxy]                            ║
║                          │                                           ║
║          ┌───────────────┴───────────────────────┐                   ║
║          │ (A) VLESS WebSocket                   │ (C) browser       ║
║          │  Clash → CF Anycast → PoP A           │  fetch(ipwho.is)  ║
║          ▼                                       │  via Clash TUN    ║
║  ┌── INVOCATION A ──────────┐                    │                   ║
║  │  CF Worker: handleProxy  │                    │                   ║
║  │  cf-connecting-ip=LocalIP│                    │                   ║
║  │  connectTo(workers.dev)  │                    ▼                   ║
║  │  ├─ direct → CF BLOCKED  │       ┌── CF PoP A ──────────────┐    ║
║  │  └─ AUTO → bridgeConnect │       │  connectTo(ipwho.is)     │    ║
║  └──────────┬───────────────┘       │  No CF loopback → DIRECT │    ║
║             │ TCP via Bridge        │  Returns: Proxy Egress IP│    ║
║             ▼                       │  🚀 Client Egress tab    │    ║
║  [Bridge Node: HostPapa / Azure]    └──────────────────────────┘    ║
║  SNI relay → CF Edge (PoP B)                                         ║
║             │                                                        ║
║  ┌── INVOCATION B ───────────────────────────────┐                   ║
║  │  CF Worker: handleServices  (at PoP B)        │                   ║
║  │                                               │                   ║
║  │  ├─ /services/ingress-ip                      │                   ║
║  │  │   cf-connecting-ip = Bridge IP             │                   ║
║  │  │   Returns: Bridge ASN (Azure, HostPapa)    │                   ║
║  │  │   🌐 Worker Ingress tab                    │                   ║
║  │  │                                            │                   ║
║  │  └─ /services/egress-ip                       │                   ║
║  │      fetch(ipapi.is) outbound from PoP B      │                   ║
║  │      Returns: CF PoP B egress IP (AS13335)    │                   ║
║  │      ⚠ Not PoP A — Bridge-selected datacenter │                   ║
║  │      ☁️ Worker Egress tab                     │                   ║
║  └───────────────────────────────────────────────┘                   ║
╚══════════════════════════════════════════════════════════════════════╝

  Tab Summary:
  ┌──────────────────────┬──────────────────────────────────────────────┐
  │ 🚀 Client Egress     │ CF Proxy egress pool (e.g., WARP/Gateway).   │
  │                      │ This is NOT the ingress Anycast IP.          │
  │                      │ Source: browser-side fetch in admin.js       │
  ├──────────────────────┼──────────────────────────────────────────────┤
  │ 🌐 Worker Ingress    │ Bridge node IP — the reverse proxy that      │
  │                      │ bypasses CF→CF loopback blocking.            │
  │                      │ Source: cf-connecting-ip in Invocation B     │
  ├──────────────────────┼──────────────────────────────────────────────┤
  │ ☁️ Worker Egress     │ CF PoP B's egress IP — the Cloudflare        │
  │                      │ datacenter the Worker runs its outbound from.│
  │                      │ Source: Worker-side fetch() in Invocation B  │
  └──────────────────────┴──────────────────────────────────────────────┘
```
