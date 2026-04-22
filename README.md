# tunnel-worker

A stateless WebSocket tunnel running on the Cloudflare edge network. Routes encrypted proxy traffic through Cloudflare Workers with an autonomous IP optimization engine and a self-bootstrapping admin portal.

## Quick Deploy (No source code required)

The `dist/` folder is a fully self-contained deployment package. You only need `wrangler` and a free Cloudflare account.

**Prerequisites**

- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js installed (`node -v` to verify)

**Steps**

1. Clone or download this repository.

2. Navigate into the `dist` folder:
   ```bash
   cd dist
   ```

3. Deploy to Cloudflare Workers:
   ```bash
   npx wrangler deploy
   ```

   Wrangler will prompt you to log in on the first run. It will also detect the required `TUNNEL` KV namespace, create it automatically, and bind it to your Worker.

4. Open your browser and visit:
   ```
   https://<your-worker-name>.<your-subdomain>.workers.dev/admin
   ```

   On the **first visit**, the portal will automatically generate a secure admin token, save it to KV, and redirect you to your unique admin URL. **Bookmark that URL** — it is your permanent admin link.

---

## Admin Portal

Access your admin panel at `/admin?token=<your-token>`. The portal provides:

| Feature | Description |
|---|---|
| **UUID Management** | View and rotate the VLESS authentication UUID |
| **IP Sync** | Crawls public Cloudflare IP databases to find optimal routing nodes |
| **Subscription Link** | A QR code and copyable Base64 subscription URL for proxy clients |

> **Security note:** The admin token is generated on first access and stored exclusively in your private KV namespace. It never appears in source code or configuration files.

---

## Subscription Endpoint

Proxy clients (V2RayN, Clash, Shadowrocket, etc.) can import the subscription URL directly:

```
https://<your-domain>/sub?token=<your-uuid>
```

The subscription URL is displayed in the admin portal along with a scannable QR code. The endpoint returns a Base64-encoded list of VLESS URIs using the optimized IP nodes from the last sync.

---

## Custom Domain (Optional)

To bind your own domain, edit `wrangler.toml` before deploying:

```toml
[[routes]]
pattern = "your.domain.com"
custom_domain = true
```

---

## Developer Guide

If you want to modify the source code and build your own distribution:

**Install dependencies**

```bash
npm install
```

**Local development** (runs against local KV, no obfuscation)

Uncomment the dev entry point in `wrangler.toml`:
```toml
#main = "src/worker.ts"  →  main = "src/worker.ts"
```
Then run:
```bash
wrangler dev
```

**Build the distribution package**

```bash
npm run build
```

This command:
1. Bundles all TypeScript source files into a single JavaScript module via `esbuild`
2. Applies multi-layer obfuscation via `javascript-obfuscator`
3. Generates a clean, standalone `dist/wrangler.toml` alongside the obfuscated `dist/index.js`

**Deploy**

```bash
npm run deploy
```

Builds and deploys in one step.

---

## License

MIT
