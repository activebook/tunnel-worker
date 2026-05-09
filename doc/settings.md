# Edge Tunnel Configuration & Settings Analysis

This document provides a comprehensive analysis of the customizable settings within the Tunnel Worker architecture. The system divides configuration into two distinct domains: **Server-Side Routing Policies** (which govern how the worker establishes outbound connections) and **Client-Side Protocol Tweaks** (which mutate the generated client subscription profiles to alter transport behavior).

## 1. Server-Side Routing Policies (`routingPolicy`)

The `routingPolicy` dictates the egress strategy the Cloudflare Worker utilizes when establishing the raw TCP connection to the final destination. This logic resides in `src/handlers/proxy.ts`.

| Policy | Behavior | Use Case & Implications |
| :--- | :--- | :--- |
| **`AUTO`** (Default) | Attempts a direct TCP connection via `cloudflare:sockets`. If this fails (often due to Cloudflare blocking loopback connections to other CF-proxied sites), it automatically falls back to bridging via a pool of optimized Reverse Proxy IPs. | The optimal balance of latency and reliability. It ensures maximum performance for non-CF domains while guaranteeing connectivity for CF domains. |
| **`BRIDGE`** | Bypasses the direct connection attempt entirely and immediately routes traffic through a Reverse Proxy IP. | Useful if direct egress is consistently blocked or if strict IP masking is required. The reverse proxy acts as an SNI-aware TCP relay, preserving the Inner TLS. |
| **`DIRECT`** | Forces a direct TCP connection. If Cloudflare's egress firewall blocks it (e.g., loopback prevention), the connection is aggressively dropped. | Offers the absolute lowest latency but will fail when accessing target resources that reside on Cloudflare's network. |

## 2. Client-Side Protocol Tweaks

These settings modify the generated configurations (VLESS/Trojan URIs, Clash YAML, Sing-Box JSON) delivered via the `/sub` endpoint (`src/handlers/sub.ts`). They govern how the client establishes the *Outer Tunnel* to the Edge Worker.

### 2.1 Web Traffic Masquerading (`useFormalPaths`)
*   **Mechanism:** When enabled, the WebSocket path is randomized from a predefined list of "formal" paths (e.g., `/api/v1/stream`, `/assets/bundle.min.js`, `/cdn-cgi/rum`) instead of the root `/`.
*   **Benefit:** Enhances obfuscation. DPI (Deep Packet Inspection) systems analyzing the Outer TLS handshake or HTTP upgrade request will see URIs that perfectly mimic standard REST API or CDN static asset delivery, lowering the probability of heuristic blocking.

### 2.2 Latency Optimization (`enableEarlyData`)
*   **Mechanism:** Appends an Early Data query parameter (`?ed=2560`) to the WebSocket path. 
*   **Benefit:** Instructs the proxy client to embed the initial payload (the Inner TLS `ClientHello`) directly within the HTTP WebSocket `Upgrade` request header (via standard 0-RTT/Early Data mechanisms). This eliminates one entire network round-trip, significantly accelerating the Time-To-First-Byte (TTFB) and handshake velocity.

### 2.3 Cryptographic Hardening (`enableEch`)
*   **Mechanism:** Enables Encrypted Client Hello (ECH) on the client side. 
    *   Sets `ech=cloudflare-ech.com` in URIs.
    *   Toggles `skip-cert-verify: false` in Clash.
    *   Injects `tls.ech: { query_server_name: 'cloudflare-ech.com' }` into Sing-Box.
*   **Benefit:** ECH encrypts the Server Name Indication (SNI) in the Outer TLS `ClientHello`. This blinds ISPs and DPI firewalls from seeing the domain the client is connecting to, closing the last plaintext metadata loophole in the TLS 1.3 handshake. 

### 2.4 Interface & Routing (`autoTunMode`)
*   **Mechanism:** Controls whether the client applications (Sing-Box, Clash) instantiate a virtual network interface (TUN) to capture all system traffic globally.
*   **Benefit:** When disabled (along with Gaming Mode), the `tun:` sections are entirely stripped from the generated profiles. This is crucial for environments where users lack elevated/administrative privileges (which TUN requires) or prefer proxying only specific applications via system proxies.

### 2.5 Transport Layer Tweaks (`gamingMode`)
*   **Mechanism:** Optimizes the protocol for UDP-heavy, latency-sensitive traffic.
    *   In Clash: explicitly sets `udp: true`.
    *   In Sing-Box (VLESS): configures `packet_encoding: "xudp"`.
*   **Benefit:** Essential for real-time applications (gaming, VoIP/WebRTC) that rely on UDP. `xudp` provides a more efficient framing mechanism over the WebSocket tunnel, minimizing jitter and packet processing overhead.
