// Minimal Invidious client: playlist listings (cached) + per-video
// availability checks. Node 24 global fetch.

export function parsePlaylistId(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  // bare ID
  if (/^[A-Za-z0-9_-]{12,}$/.test(s) && !s.includes('/')) return s;
  // URL form: extract list= param
  try {
    const u = new URL(s);
    const list = u.searchParams.get('list');
    if (list && /^[A-Za-z0-9_-]{12,}$/.test(list)) return list;
  } catch {
    /* not a URL */
  }
  return null;
}

export class InvidiousClient {
  constructor(baseUrl, { listingTtlMs = 3600_000, timeoutMs = 20_000 } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.listingTtlMs = listingTtlMs;
    this.timeoutMs = timeoutMs;
    this.listings = new Map(); // id -> { fetchedAt, data }
  }

  async #fetchJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${url}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // { title, videos: [{ videoId, title, author, lengthSeconds, index }] }
  // Cached for listingTtlMs; throws on failure (caller keeps previous state).
  async listing(playlistId) {
    const cached = this.listings.get(playlistId);
    if (cached && Date.now() - cached.fetchedAt < this.listingTtlMs) {
      return cached.data;
    }
    const data = await this.#fetchJson(
      `${this.base}/api/v1/playlists/${encodeURIComponent(playlistId)}`
    );
    const videos = (Array.isArray(data.videos) ? data.videos : [])
      .filter((v) => v && v.videoId)
      .map((v) => ({
        videoId: v.videoId,
        title: v.title || v.videoId,
        author: v.author || null,
        lengthSeconds: Number(v.lengthSeconds) || 0,
        index: Number.isInteger(v.index) ? v.index : null,
      }));
    const out = { title: data.title || playlistId, videos };
    this.listings.set(playlistId, { fetchedAt: Date.now(), data: out });
    return out;
  }

  // true (2xx = playable), false (definite non-2xx, network error, or a
  // zero-length listing entry). Never throws.
  async available(videoId) {
    try {
      await this.#fetchJson(`${this.base}/api/v1/videos/${encodeURIComponent(videoId)}`);
      return true;
    } catch (e) {
      if (e.name === 'AbortError') {
        // inconclusive: treat as unavailable this round; it gets another
        // chance at the next slot
      }
      return false;
    }
  }
}
