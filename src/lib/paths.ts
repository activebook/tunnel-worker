// ── Dynamic Path Generator ──────────────────────────────────────────────────

export const PATH_CATEGORIES = [
  'asset-cdn',
  'api-stream',
  'edge-convention',
  'media-stream',
  'upload-progress',
  'auth-flow',
] as const;

export type PathCategory = typeof PATH_CATEGORIES[number];

export interface PathOptions {
  uuid: string;
  category?: PathCategory;
}

// Deterministic PRNG seeded by string
function xmur3(str: string) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = h << 13 | h >>> 19;
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}

function mulberry32(a: number) {
  return function () {
    var t = a += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function hexChars(rand: () => number, length: number): string {
  const chars = '0123456789abcdef';
  let res = '';
  for (let i = 0; i < length; i++) res += chars[Math.floor(rand() * 16)];
  return res;
}

/**
 * Builds a deterministic, categorically authentic path.
 */
export function buildWsPath(options: PathOptions, index: number = 0): string {
  // Combine UUID and index to get a deterministic sequence of paths
  const seed = xmur3(`${options.uuid}:${index}`)();
  const rand = mulberry32(seed);

  const category = options.category || PATH_CATEGORIES[index % PATH_CATEGORIES.length];

  switch (category) {
    case 'asset-cdn': {
      const exts = ['.js', '.css', '.woff2'];
      const ext = exts[Math.floor(rand() * exts.length)];
      const hash = hexChars(rand, 8);
      if (ext === '.js') return `/_next/js/chunk-vendors.${hash}.js`;
      if (ext === '.css') return `/dist/css/app.${hash}.css`;
      return `/cdn/fonts/inter-var.${hash}.woff2`;
    }
    case 'api-stream': {
      const apiVers = ['v1', 'v2'];
      const ver = apiVers[Math.floor(rand() * apiVers.length)];
      const endpoints = [
        `/presence/channel/${hexChars(rand, 4)}`,
        '/events/stream',
        '/notifications/live',
        '/realtime/feed'
      ];
      return `/api/${ver}${endpoints[Math.floor(rand() * endpoints.length)]}`;
    }
    case 'edge-convention': {
      const edgePaths = ['/cdn-cgi/rum', '/cdn-cgi/trace', '/cdn-cgi/beacon/expect-ct', '/__cf_workers/ws'];
      return edgePaths[Math.floor(rand() * edgePaths.length)];
    }
    case 'media-stream': {
      const mediaId = hexChars(rand, 4);
      const mediaPaths = [
        `/hls/abr/session-${mediaId}/master.m3u8`,
        `/media/hls/live-${mediaId}.m3u8`,
        '/stream/video/manifest'
      ];
      return mediaPaths[Math.floor(rand() * mediaPaths.length)];
    }
    case 'upload-progress': {
      const uploadId = hexChars(rand, 12);
      return `/api/v2/uploads/${uploadId}/progress`;
    }
    case 'auth-flow': {
      const authPaths = ['/oauth2/token/silent', '/oidc/checksession'];
      return authPaths[Math.floor(rand() * authPaths.length)];
    }
    default:
      return '/';
  }
}

/**
 * Generates an array of N unique paths, cycling through categories.
 */
export function buildWsPathSet(n: number, options: { uuid: string; category?: PathCategory }): string[] {
  const paths: string[] = [];
  for (let i = 0; i < n; i++) {
    paths.push(buildWsPath(options, i));
  }
  return paths;
}
