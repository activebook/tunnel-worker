import { connect } from 'cloudflare:sockets';

/**
 * Performs a TCP connection to measure the network-level round-trip latency to a specific IP.
 * Utilizes the Cloudflare sockets API for accurate proxy latency measurement.
 * 
 * @param ip The IPv4 address to test.
 * @param timeoutMs Maximum time to wait for a connection in milliseconds.
 * @returns The latency in milliseconds, or null if the connection fails or times out.
 */
export async function checkLatency(ip: string, timeoutMs: number = 2000): Promise<number | null> {
  const start = Date.now();
  try {
    // We connect to port 443 as it's the standard TLS port for VLESS tunnels
    const socket = connect({ hostname: ip, port: 443 });
    
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), timeoutMs);
    });

    // Race the TCP handshake against the timeout
    await Promise.race([socket.opened, timeoutPromise]);
    
    const latency = Date.now() - start;
    
    // Clean up the socket immediately after handshake
    socket.close();
    
    return latency;
  } catch (_) {
    // Return null if there's any network failure, timeout, or unreachable host
    return null;
  }
}
