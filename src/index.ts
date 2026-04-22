
// For testing purpose only, will be removed in the future
/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run "npm run dev" in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run "npm run deploy" to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
export default {
  async fetch(request: Request): Promise<Response> {
    console.log('[TEST] reached fetch handler');
    return new Response('ok', { status: 200 });
  }
};