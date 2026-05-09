## What's Going Wrong

Your current DNS rules flow for an **unknown domain** (not in any ruleset):

1. Rules 1-4: no match
2. Rule 5: `evaluate` → probes `dns-local`, saves the response
3. Rule 6: `match_response + geoip-cn` → if CN IP → route to `dns-local` ✓
4. **Falls to `final: dns-remote`** → gets a real (unproxied) IP from Cloudflare

That last step is the gap. Since `final` can't be `dns-fakeip`, grey-zone domains (not in `!cn` or `cn` rulesets) escape fakeip entirely.

## The Fix

The official migration docs show exactly this pattern: after `evaluate` + `match_response`, add a plain `{"action": "route", "server": "..."}` as a catch-all rule. You don't need `final: dns-fakeip` — just add an explicit unconditional route to `dns-fakeip` as the last rule before final is ever reached:

```json
{
  "action": "evaluate",
  "server": "dns-local"
},
{
  "match_response": true,
  "rule_set": ["geoip-cn"],
  "action": "route",
  "server": "dns-local"
},
{
  "action": "route",        // <-- THIS is the missing piece
  "server": "dns-fakeip"   //     catches everything not CN
}
```

`evaluate` sends a DNS query to the specified server and saves the evaluated response for subsequent rules to match against, but **unlike `route`, it does not terminate rule evaluation**. So after `evaluate` runs and the `match_response` check fails (not a CN IP), execution continues to the next rule — which is now your fakeip catch-all. `final` is never reached.

## Full Corrected DNS Rules Section

```json
"rules": [
  {
    "query_type": ["AAAA"],
    "rule_set": ["geosite-cn"],
    "action": "reject"
  },
  {
    "rule_set": ["geosite-category-ads-all"],
    "action": "reject"
  },
  {
    "domain_suffix": [".cn"],
    "rule_set": ["geosite-cn"],
    "action": "route",
    "server": "dns-local"
  },
  {
    "rule_set": ["geosite-geolocation-!cn"],
    "action": "route",
    "server": "dns-fakeip"
  },
  {
    "action": "evaluate",
    "server": "dns-local"
  },
  {
    "match_response": true,
    "rule_set": ["geoip-cn"],
    "action": "route",
    "server": "dns-local"
  },
  {
    "action": "route",
    "server": "dns-fakeip"
  }
],
"final": "dns-remote"
```

Keep `final: dns-remote` — it's now just a safety net that's never actually reached for A/AAAA queries (since the last rule is a universal catch-all).

## What Each Domain Gets Now

| Domain | Path |
|---|---|
| `www.baidu.com` | matches `geosite-cn` → `dns-local` → real IP → direct |
| `www.google.com` | matches `geosite-geolocation-!cn` → `dns-fakeip` → `198.18.x.x` → proxy |
| Unknown (e.g. some obscure `.io` site) | `evaluate` via `dns-local` → if geoip-cn → `dns-local`; else → **`dns-fakeip`** → proxy |

The grey zone is now fully covered. Unknown foreign domains get fakeip and route through your proxy automatically.


---

## Q1: Top-down execution?

Yes, **DNS rules are strictly top-down, first match wins** — with the one exception of `evaluate` which doesn't terminate evaluation. Every other action (`route`, `reject`, `respond`) terminates immediately when the rule fires. This is the same model as route rules.

## Q2: No round-robin — sing-box has no such concept

There is **no round-robin or fallback between DNS servers** in sing-box. Rules map a condition to exactly one server tag. That's it. You can't write "try server A, fall back to B". The architecture assumes the server you route to is reliable.

## Q3: `type: local` vs `type: https` with `223.5.5.5`

**You absolutely can — and often should — use `type: https`/`type: udp` with an explicit Chinese IP instead of `type: local`.** They are not equivalent:

| | `type: local` | `type: https` `223.5.5.5` |
|---|---|---|
| Uses OS resolver | Yes (`/etc/resolv.conf`, etc.) | No |
| Explicit server | No — whatever the OS is configured | Yes — Alibaba DoH |
| Encrypted | No | Yes |
| TUN loop risk | **Yes, on Linux/OpenWRT** | None — routed directly |
| Depends on OS config | Yes | No |

A known issue: on Linux with `auto_route: true` in TUN inbound, using `type: local` for CN domains can cause DNS loops — the OS resolver sends a UDP query, TUN captures it, routes it back into sing-box, and it loops indefinitely.

Using `type: https` with an explicit IP bypasses this entirely because sing-box routes that connection directly as a known outbound, not through TUN capture.

Your existing config already has `dns-local-1` through `dns-local-3` as proper typed HTTPS servers — those are correct. The `type: local` one is the potential problem child. For your use case inside China, the practical recommendation is:

```json
{
  "tag": "dns-local",
  "type": "https",
  "server": "223.5.5.5"
}
```

or `type: udp` if you want plain DNS-over-UDP (faster, no TLS overhead, but not encrypted):

```json
{
  "tag": "dns-local",
  "type": "udp",
  "server": "223.5.5.5"
}
```

Pick one reliable CN server (`223.5.5.5` Alibaba, `119.29.29.29` DNSPod, or `114.114.114.114`). Since there's no round-robin anyway, having three identical servers in your config (`dns-local-1/2/3`) does nothing useful — they're declared but never referenced by your rules. Just keep one, tag it `dns-local`, and point all your CN rules at it.
