
---

## Clash fake-ip + TUN — Complete Picture

### 1. fake-ip mode

When any app asks for a domain's IP:
- Clash immediately returns a fake IP from `198.18.x.x` pool
- **No real DNS query fired yet**
- Clash stores the mapping: `198.18.0.1 → google.com`
- App connects to fake IP → Clash intercepts → looks up real domain from mapping → applies routing rules

`198.18.x.x` is used because RFC 2544 reserved it for benchmarking — no real server on the internet uses it, so there's zero collision risk.

---

### 2. Routing decision after fake-ip

```
domain hits routing rules
    ├── PROXY → wrapped in VLESS, sent to proxy IP
    │           proxy resolves domain remotely
    │           your DNS servers never see it
    │
    └── DIRECT → Clash now does real DNS lookup
                 gets real IP, connects directly
```

---

### 3. DNS servers and their roles

| DNS | Purpose |
|---|---|
| `default-nameserver` | Bootstrap only — resolves hostnames of DoH servers (doh.pub, alidns.com etc.) at startup, using plain UDP |
| `nameserver` | Real DNS for DIRECT domestic domains (baidu, bilibili…) |
| `fallback` | Pollution-resistant DNS for DIRECT foreign domains — queried concurrently with nameserver, wins when nameserver returns a polluted/CN result |
| Nobody | Everything going through VLESS proxy — invisible to all local DNS |

---

### 4. Proxy server itself

If your proxy is configured as a **raw IP**, no DNS needed at all — Clash connects directly. The `default-nameserver` bootstrap-for-proxy-domain scenario doesn't apply to you.

---

### 5. TUN + dns-hijack: any:53

- `auto-route: true` → TUN captures **all system traffic**
- `dns-hijack: any:53` → any app that hardcodes its own DNS server (e.g. `8.8.8.8:53`) gets intercepted and redirected into Clash DNS
- After hijack, the query follows the exact same fake-ip flow as normal
- **Does not affect DoH** — those run on port 443, not 53
- **Does not affect LAN IPs** — `auto-route` skips private subnets, so `192.168.x.x:53` can't be hijacked

---

### 6. What actually reaches each DNS server in your setup

| Domain example | What happens |
|---|---|
| `google.com`, `youtube.com` | PROXY → inside VLESS → no local DNS |
| `baidu.com`, `bilibili.com` | DIRECT → `nameserver` (doh.pub, alidns) |
| Foreign site going DIRECT | DIRECT → `nameserver` + `fallback` concurrent, fallback wins if polluted |
| `doh.pub`, `dns.alidns.com` | `default-nameserver` resolves them at startup |
| Your proxy server | Raw IP in config → no DNS needed |

---

### 7. The chain in one picture

```
App
 │
 ▼
Clash DNS (fake-ip) → 198.18.x.x returned immediately
 │
 ▼
App connects to fake IP → TUN intercepts
 │
 ▼
Clash looks up domain from mapping → checks rules
 │
 ├─► PROXY → VLESS tunnel → proxy resolves it overseas
 │
 └─► DIRECT → real DNS (nameserver/fallback) → connect directly
```

---

### 8. DNS test

in clash:
default-nameserver:
    - 223.5.5.5:53
    - 119.29.29.29:53
    - 114.114.114.114

not in tun mode:

dig @1.1.1.1 transfer.ccwu.cc

; <<>> DiG 9.10.6 <<>> @1.1.1.1 transfer.ccwu.cc
; (1 server found)
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 19042
;; flags: qr rd ra; QUERY: 1, ANSWER: 2, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; udp: 1232
;; QUESTION SECTION:
;transfer.ccwu.cc.		IN	A

;; ANSWER SECTION:
transfer.ccwu.cc.	300	IN	A	172.67.214.9
transfer.ccwu.cc.	300	IN	A	104.21.86.15

;; Query time: 348 msec
;; SERVER: 1.1.1.1#53(1.1.1.1)
;; WHEN: Sat May 09 13:47:43 CST 2026
;; MSG SIZE  rcvd: 77

in tun mode:

dig @1.1.1.1 transfer.ccwu.cc

; <<>> DiG 9.10.6 <<>> @1.1.1.1 transfer.ccwu.cc
; (1 server found)
;; global options: +cmd
;; Got answer:
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 26697
;; flags: qr aa rd ra ad; QUERY: 1, ANSWER: 1, AUTHORITY: 0, ADDITIONAL: 1

;; OPT PSEUDOSECTION:
; EDNS: version: 0, flags:; MBZ: 0x0001, udp: 4096
;; QUESTION SECTION:
;transfer.ccwu.cc.		IN	A

;; ANSWER SECTION:
transfer.ccwu.cc.	1	IN	A	198.18.0.158

;; Query time: 2 msec
;; SERVER: 1.1.1.1#53(1.1.1.1)
;; WHEN: Sat May 09 13:45:29 CST 2026
;; MSG SIZE  rcvd: 61

in not tun mode:

dig @233.5.5.5 transfer.ccwu.cc

; <<>> DiG 9.10.6 <<>> @233.5.5.5 transfer.ccwu.cc
; (1 server found)
;; global options: +cmd
;; connection timed out; no servers could be reached

---

## Observation 1: TUN mode hijacks `dig @1.1.1.1`

You explicitly told `dig` to use `1.1.1.1:53` — but TUN mode intercepted it anyway and returned `198.18.0.158`. This is **dns-hijack: any:53** working exactly as described:

```
dig @1.1.1.1 transfer.ccwu.cc
    │
    └─► TUN intercepts port 53 traffic
        redirected to Clash DNS
        fake-ip returned: 198.18.0.158
        query time: 2ms (local, never left your machine)
```

Also notice `SERVER: 1.1.1.1` in the output — `dig` *thinks* it talked to `1.1.1.1`, but it actually talked to Clash. The hijack is completely transparent to the app.

---

## Observation 2: `233.5.5.5` times out but domain still opens

Two separate things happening here:

**The typo first** — you wrote `233.5.5.5` but your config has `223.5.5.5` (Alibaba DNS). `233.5.5.5` doesn't exist, hence timeout.

**But why does the domain still open?** Yes, you're right — Clash queries `nameserver` list **concurrently**, not sequentially. From the official docs:

```
nameserver:
  - https://sm2.doh.pub/dns-query   ─┐
  - https://dns.alidns.com/dns-query  ├─ all queried at same time
  - https://doh.pub/dns-query        ─┘
```

Clash takes the **first response that comes back**. So even if one server is slow or unreachable, others answer and the domain resolves fine. One dead server doesn't block anything.

---

## Summary of what your tests prove

| Test | Proves |
|---|---|
| TUN: `dig @1.1.1.1` → `198.18.x.x` | dns-hijack intercepts any:53 regardless of target IP |
| Query time 2ms in TUN vs 348ms without | fake-ip is answered locally, never hits real DNS |
| `233.5.5.5` timeout but domain works | nameserver list queried concurrently, first reply wins |