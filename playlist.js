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

export const CHANNEL_TABS = ['shorts', 'videos', 'streams'];

// Channel feed source: bare UCID (tab defaults to shorts) or a channel URL
// whose path segment after the UCID picks the tab (…/channel/UC…/videos).
// @handles are not supported — the API can't resolve them.
export function parseChannelSource(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(s)) return { ucid: s, tab: 'shorts' };
  try {
    const u = new URL(s);
    const parts = u.pathname.split('/').filter(Boolean);
    const ci = parts.indexOf('channel');
    if (ci !== -1 && parts[ci + 1] && /^UC[A-Za-z0-9_-]{20,}$/.test(parts[ci + 1])) {
      const tab = CHANNEL_TABS.includes(parts[ci + 2]) ? parts[ci + 2] : 'shorts';
      return { ucid: parts[ci + 1], tab };
    }
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
    this.listings = new Map(); // listing key -> { fetchedAt, data }
    this.abouts = new Map(); // ucid -> { fetchedAt, data }
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

  // { author } for a channel (cached). Throws on failure.
  async channelAbout(ucid) {
    const cached = this.abouts.get(ucid);
    if (cached && Date.now() - cached.fetchedAt < this.listingTtlMs) return cached.data;
    const data = await this.#fetchJson(`${this.base}/api/v1/channels/${encodeURIComponent(ucid)}`);
    const out = { author: data.author || null };
    this.abouts.set(ucid, { fetchedAt: Date.now(), data: out });
    return out;
  }

  // A channel tab's full video listing ({ title, tab, videos: [{ videoId,
  // title, author, lengthSeconds }] }), following `continuation` pagination
  // (48 per page). Cached like playlist listings. Throws on failure.
  async channelVideos(ucid, tab = 'shorts', { maxPages = 40 } = {}) {
    const key = `${ucid}/${tab}`;
    const cached = this.listings.get(key);
    if (cached && Date.now() - cached.fetchedAt < this.listingTtlMs) return cached.data;

    const videos = [];
    let continuation = null;
    for (let page = 0; page < maxPages; page++) {
      const qs = continuation ? `?continuation=${encodeURIComponent(continuation)}` : '';
      const data = await this.#fetchJson(
        `${this.base}/api/v1/channels/${encodeURIComponent(ucid)}/${encodeURIComponent(tab)}${qs}`
      );
      for (const v of Array.isArray(data.videos) ? data.videos : []) {
        if (v && v.videoId) {
          videos.push({
            videoId: v.videoId,
            title: v.title || v.videoId,
            author: v.author || null,
            lengthSeconds: Number(v.lengthSeconds) || 0,
          });
        }
      }
      continuation = data.continuation || null;
      if (!continuation) break;
    }

    let title = `${ucid} — ${tab}`;
    try {
      const about = await this.channelAbout(ucid);
      if (about.author) title = `${about.author} — ${tab}`;
    } catch {
      /* fallback title */
    }
    const out = { title, tab, videos };
    this.listings.set(key, { fetchedAt: Date.now(), data: out });
    return out;
  }
}
