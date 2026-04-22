
// For testing purpose only, will be removed in the future
export default {
  async fetch(request: Request): Promise<Response> {
    console.log('[TEST] reached fetch handler');
    return new Response('ok', { status: 200 });
  }
};