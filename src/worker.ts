import { connect } from 'cloudflare:sockets';

export interface Env {
	UUID: string;
	PROXYIP?: string;
}

/** Converts raw 16-byte UUID payload into canonical hyphenated string. */
function stringifyUuid(b: Uint8Array): string {
	const h = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		// Health-check endpoint — configure Clash to use this for latency probing.
		if (url.pathname === '/generate_204') {
			return new Response(null, { status: 204 });
		}

		// Degrade gracefully for plain HTTP visitors.
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('VLESS Relay Active', { status: 200 });
		}

		// Establish full-duplex WebSocket conduit.
		const [client, webSocket] = Object.values(new WebSocketPair());
		webSocket.accept();

		let tcpSocket: Socket | null = null;
		let tcpWriter: WritableStreamDefaultWriter | null = null;
		let ready = false;
		let queue: Uint8Array[] = [];

		webSocket.addEventListener('message', async (event: MessageEvent) => {
			const raw = new Uint8Array(event.data as ArrayBuffer);

			// ── Phase 1: Parse VLESS header and open egress TCP socket ──────────
			if (!ready && !tcpSocket) {
				const version  = raw[0];
				const uuid     = stringifyUuid(raw.slice(1, 17));

				if (uuid !== env.UUID) {
					webSocket.close(1008, 'Unauthorized');
					return;
				}

				const optLen  = raw[17];
				let   off     = 18 + optLen;

				const cmd     = raw[off++];
				const port    = (raw[off++] << 8) | raw[off++];
				const atype   = raw[off++];

				let address = '';
				if (atype === 1) {                          // IPv4
					address = Array.from(raw.slice(off, off + 4)).join('.');
					off += 4;
				} else if (atype === 2) {                   // FQDN
					const len = raw[off++];
					address = new TextDecoder().decode(raw.slice(off, off + len));
					off += len;
				} else if (atype === 3) {                   // IPv6
					const segs = [];
					for (let i = 0; i < 16; i += 2)
						segs.push(((raw[off + i] << 8) | raw[off + i + 1]).toString(16));
					address = segs.join(':');
					off += 16;
				}

				if (cmd !== 1) {                            // Only TCP supported
					webSocket.close(1003, 'Unsupported command');
					return;
				}

				const payload = raw.slice(off);
				const target  = env.PROXYIP ?? address;

				try {
					tcpSocket  = connect({ hostname: target, port });
					tcpWriter  = tcpSocket.writable.getWriter();
					ready      = true;

					// VLESS response header: echo version + 0 addons
					webSocket.send(new Uint8Array([version, 0]));

					if (payload.byteLength > 0) await tcpWriter.write(payload);
					for (const chunk of queue)  await tcpWriter.write(chunk);
					queue = [];

					// Pipe TCP → WebSocket in background without blocking the isolate.
					ctx.waitUntil((async () => {
						const reader = tcpSocket!.readable.getReader();
						try {
							while (true) {
								const { done, value } = await reader.read();
								if (done) break;
								if (value) webSocket.send(value);
							}
						} catch { /* stream cancelled on WebSocket close — expected */ }
						finally { reader.releaseLock(); }
					})());
				} catch (err) {
					webSocket.close(1011, 'TCP connect failed');
				}

			// ── Phase 2: Forward subsequent frames directly to egress socket ─────
			} else if (ready && tcpWriter) {
				await tcpWriter.write(raw);
			} else {
				queue.push(raw);
			}
		});

		webSocket.addEventListener('close', () => {
			try { tcpSocket?.close(); } catch { /* ignore */ }
		});

		return new Response(null, { status: 101, webSocket: client });
	},
};
