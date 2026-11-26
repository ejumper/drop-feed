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

// Public Invidious origin used when writing channel URLs back to config files
// (the parser accepts any host; only the path shape matters).
export const CHANNEL_URL_BASE = 'https://tube.halfab.net';

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

// Classify a pasted URL / bare id for the admin create form. Returns one of:
//   { kind: 'channel', ucid, tab }   — resolvable now
//   { kind: 'handle', handle, tab }  — needs client.resolveHandle() first
//   { kind: 'playlist', playlist }
//   { kind: 'video' }                — a single video is not a feed source
//   { kind: 'unknown' }
export function detectSource(input) {
  if (typeof input !== 'string') return { kind: 'unknown' };
  const s = input.trim();
  if (!s) return { kind: 'unknown' };
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(s)) return { kind: 'channel', ucid: s, tab: 'shorts' };
  if (/^(?:PL|OL|UU|FL|RD|LL)[A-Za-z0-9_-]{10,}$/.test(s)) return { kind: 'playlist', playlist: s };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { kind: 'unknown' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { kind: 'unknown' };
  const segs = u.pathname.split('/').filter(Boolean);
  const tabAfter = (i) =>
    segs[i] && CHANNEL_TABS.includes(segs[i].toLowerCase()) ? segs[i].toLowerCase() : null;
  const ci = segs.indexOf('channel');
  if (ci !== -1 && segs[ci + 1]) {
    if (/^UC[A-Za-z0-9_-]{20,}$/.test(segs[ci + 1])) {
      return { kind: 'channel', ucid: segs[ci + 1], tab: tabAfter(ci + 2) || 'shorts' };
    }
    return { kind: 'unknown' }; // /channel/<custom-name> — no UCID to work with
  }
  if (segs[0] && segs[0].startsWith('@')) {
    return { kind: 'handle', handle: segs[0].slice(1), tab: tabAfter(1) || 'shorts' };
  }
  if (segs[0] === 'playlist') {
    const id = u.searchParams.get('list');
    if (id && /^[A-Za-z0-9_-]{12,}$/.test(id)) return { kind: 'playlist', playlist: id };
    const m = u.pathname.match(/^\/playlist\/([A-Za-z0-9_-]{12,})$/);
    if (m) return { kind: 'playlist', playlist: m[1] };
    return { kind: 'unknown' };
  }
  if ((segs[0] === 'watch' && u.searchParams.get('v')) || segs[0] === 'shorts') {
    return { kind: 'video' };
  }
  return { kind: 'unknown' };
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

  // Resolve an @handle to a UCID by scraping the vanity-URL page's HTML (the
  // channels API cannot resolve handles). Returns the UCID or null. The UCID
  // must be the most frequent /UC… match and appear at least 3 times.
  // Inject fetchPage(url) → html for tests.
  async resolveHandle(handle, { fetchPage = null } = {}) {
    const h = String(handle || '').replace(/^@+/, '').trim();
    if (!h || !/^[\w.-]{1,64}$/.test(h)) return null;
    let html = '';
    try {
      if (fetchPage) {
        html = await fetchPage(`${this.base}/@${encodeURIComponent(h)}`);
      } else {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
        try {
          const res = await fetch(`${this.base}/@${encodeURIComponent(h)}`, {
            signal: ctrl.signal,
            headers: { Accept: 'text/html' },
          });
          if (!res.ok) return null;
          html = await res.text();
        } finally {
          clearTimeout(timer);
        }
      }
    } catch {
      return null;
    }
    const counts = new Map();
    for (const m of html.matchAll(/UC[A-Za-z0-9_-]{20,}/g)) {
      counts.set(m[0], (counts.get(m[0]) || 0) + 1);
    }
    let best = null;
    let bestN = 0;
    for (const [id, n] of counts) {
      if (n > bestN) {
        best = id;
        bestN = n;
      }
    }
    return bestN >= 3 ? best : null;
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
  // title, author, lengthSeconds, published }] }), following `continuation`
  // pagination (48 per page). Cached like playlist listings. Throws on failure.
  // tab 'all' merges shorts + videos + streams (deduped, newest-published first).
  async channelVideos(ucid, tab = 'shorts', { maxPages = 40 } = {}) {
    const key = `${ucid}/${tab}`;
    const cached = this.listings.get(key);
    if (cached && Date.now() - cached.fetchedAt < this.listingTtlMs) return cached.data;

    let videos;
    if (tab === 'all') {
      const tabs = await Promise.allSettled([
        this.#fetchChannelTab(ucid, 'shorts', maxPages),
        this.#fetchChannelTab(ucid, 'videos', maxPages),
        this.#fetchChannelTab(ucid, 'streams', maxPages),
      ]);
      const seen = new Set();
      videos = [];
      for (const r of tabs) {
        if (r.status !== 'fulfilled') continue;
        for (const v of r.value) {
          if (!seen.has(v.videoId)) {
            seen.add(v.videoId);
            videos.push(v);
          }
        }
      }
      videos.sort((a, b) => (b.published || 0) - (a.published || 0)); // newest first
    } else {
      videos = await this.#fetchChannelTab(ucid, tab, maxPages);
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

  async #fetchChannelTab(ucid, tab, maxPages) {
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
            published: Number(v.published) || 0,
          });
        }
      }
      continuation = data.continuation || null;
      if (!continuation) break;
    }
    return videos;
  }
}
