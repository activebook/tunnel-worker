# IP Identity & Network Diagnostics Explained

This document explains a subtle but architecturally significant behaviour you will
observe in the **Diagnostics → My IP** panel of the Admin Portal when a proxy client
(Clash, Sing-box, etc.) is active. Understanding it requires tracing the exact path a
request takes through the tunnel stack, and distinguishing between two entirely separate
Worker invocations.

---

## 1. Background: What `/services/ingress-ip` Reports

The endpoint is implemented in `src/handlers/services.ts`:

```typescript
// GET /services/ingress-ip — return Ingress IP location info (bridge node)
const ip = (request.headers.get('cf-connecting-ip') || 'Unknown').split(',')[0].trim();
```

`cf-connecting-ip` is a header automatically injected by the **Cloudflare Edge** on
every inbound HTTP request. It contains the **public IP address of the TCP peer that
physically connected to the CF Edge PoP** — i.e., the last network hop before the Edge.

The Worker enriches this IP with geographic and ASN data via two external APIs:

- `https://ipwho.is/{ip}` — location, ISP, ASN, IP type
- `https://api.ipapi.is/?q={ip}` — security flags (VPN, datacenter, Tor, proxy, abuser)

**The critical insight:** `cf-connecting-ip` does not always equal the user's real home
IP. It equals the IP of whoever physically made the final TCP connection to the CF Edge.

---

## 2. The Two Observable States

### State A — Clash / Sing-box OFF (Direct Access)

```
Browser (China)
  └─► TCP directly to Cloudflare Edge
            │
      cf-connecting-ip = China public IP
            │
            ▼
      Worker → handleServices → returns China IP
```

The browser connects directly to the CF Edge. `cf-connecting-ip` is the user's real
home IP. The Diagnostics panel correctly shows the China ISP and location.

### State B — Clash / Sing-box ON (Proxied Access)

```
Browser (China)
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
   │                    SNI relay → CF Edge                      │
   └─────────────────────────────────────────────────────────────┘
                            │
                   ┌─ Invocation B ─────────────────────────────┐
                   │  New HTTP GET /services/ingress-ip          │
                   │  url.pathname → handleServices              │
                   │  cf-connecting-ip = Bridge IP              │
                   │  Returns: Bridge ASN (Microsoft, HostPapa) │
                   └────────────────────────────────────────────┘
```

---

## 3. The Two-Invocation Model (Key Concept)

This is the most important concept to understand. There are **two entirely separate
Worker `fetch()` invocations**, not one.

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
| CF Edge (VLESS WebSocket ingress) | Client's real China IP | Clash connects directly from China to CF Edge for the WebSocket |
| Target website (google.com, etc.) | Bridge node IP | All proxied traffic exits through the bridge |
| `/services/ingress-ip` when Clash ON | Bridge node IP | Reads `cf-connecting-ip` from the incoming proxied request |
| `/services/ingress-ip` when Clash OFF | Client's real China IP | Direct connection, no proxy interception |
| `/services/egress-ip` when Clash ON | Cloudflare Egress IP | CF Worker executes a brand new outbound `fetch()` bypassing the bridge |

The user's real IP is only exposed to the CF Edge that terminates the outermost VLESS
WebSocket — and that information is never forwarded to any destination.

---

## 8. The Dual IP Diagnostic Solution

To provide full transparency into this split-routing behavior, the Admin Portal's Network Diagnostics panel features a **Dual IP** toggle:

1. **Inbound (Bridge):** Retrieves the `cf-connecting-ip` from the incoming request. When proxied, this shows the Reverse Proxy node (e.g., HostPapa, Azure) that successfully bypassed the Cloudflare loopback blocker.
2. **Outbound (CF Edge):** The Worker initiates a brand new, outbound `fetch()` to an external IP API (`ipapi.is`). By initiating the request from *within* the Cloudflare data center, the API sees and returns the true Cloudflare Egress IP (AS13335 Cloudflare, Inc.) that is actually used for your outbound internet traffic.

When you use the proxy, you appear as the Inbound (Bridge) IP to the Cloudflare Edge, but you appear as the Outbound (CF Edge) IP to the rest of the internet.

---

## 9. Visual Summary

```text
╔══════════════════════════════════════════════════════════════════════╗
║                    CLASH / SING-BOX ACTIVE                          ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  [Browser] ──► [Clash TUN / System Proxy]                            ║
║                          │                                           ║
║          VLESS WebSocket │ (Clash → CF Anycast IP)                   ║
║                          ▼                                           ║
║              ┌── INVOCATION A ──────────────────────┐               ║
║              │  CF Worker: handleProxy               │               ║
║              │  cf-connecting-ip = China IP          │               ║
║              │  parseVlessHeader: dest=workers.dev   │               ║
║              │  connectTo(workers.dev, 443)          │               ║
║              │    ├─ direct → CF loopback BLOCKED    │               ║
║              │    └─ AUTO fallback → bridgeConnect() │               ║
║              └─────────────────┬────────────────────┘               ║
║                                │ TCP via Bridge IP                   ║
║                                ▼                                     ║
║                    [Bridge Node: HostPapa / Azure]                   ║
║                    SNI-aware relay → CF Edge                         ║
║                                │                                     ║
║              ┌── INVOCATION B ─┴────────────────────┐               ║
║              │  CF Worker: handleServices            │               ║
║              │                                      │               ║
║              │  ├─ /services/ingress-ip             │               ║
║              │  │   cf-connecting-ip = Bridge IP    │               ║
║              │  │   Returns: Bridge ASN (Azure)     │               ║
║              │  │                                   │               ║
║              │  └─ /services/egress-ip              │               ║
║              │      fetch(ipapi.is)                 │               ║
║              │      Returns: Egress ASN (Cloudflare)│               ║
║              └──────────────────────────────────────┘               ║
╚══════════════════════════════════════════════════════════════════════╝
```
