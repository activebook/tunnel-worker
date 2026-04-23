# tunnel-worker

A stateless WebSocket tunnel running on the Cloudflare edge network. Routes encrypted proxy traffic through Cloudflare Workers with an autonomous IP optimization engine and a self-bootstrapping admin portal.

## Quick Deploy (No source code required)

**Prerequisites**

- A [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js installed (`node -v` to verify)

**Steps**

1. Go to the [**Releases**](../../releases/latest) page and download `tunnel-worker.zip`.

2. Extract the zip and open a terminal inside the extracted folder.

3. Deploy to Cloudflare Workers:
   ```bash
   npx wrangler deploy
   ```

   Wrangler will prompt you to log in on the first run. It will also detect the required `TUNNEL` KV namespace, create it automatically, and bind it to your Worker.

4. Open your browser and visit:
   ```
   https://<your-worker-name>.<your-subdomain>.workers.dev/admin
   ```

   On the **first visit**, the portal will automatically generate a secure admin token, and redirect you to your unique admin URL. **Bookmark that URL** and **Don't lose it** — it's your permanent admin link.

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

## Routing & IP Optimization

The tunnel utilizes two distinct IP mechanisms to ensure optimal connectivity and resilience. These can be synchronized via the Admin Portal:

- **Anycast Edge IPs**: Direct Cloudflare edge nodes ranked by client-to-edge latency. These provide the fastest and most direct connection path for your proxy clients.
- **Reverse Proxy Bridge IPs**: Fallback external relays. If direct connections to the target are blocked or restricted, the worker routes traffic through these bridge nodes to maintain connectivity.

---

## Configuration

You can customize the `wrangler.toml` file before deployment:

- **`name`**: You can change this to any name you prefer for your Worker.
- **`binding = "TUNNEL"`**: **DO NOT CHANGE THIS.** The code is hard-wired to look for the `TUNNEL` binding.

### Custom Domain (Optional)

To bind your own domain, edit `wrangler.toml`:

```toml
[[routes]]
pattern = "your.domain.com"
custom_domain = true
```

---

## License

MIT
