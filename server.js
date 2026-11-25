// drop-feed server: plain Node HTTP (tube-rss conventions — no framework).
// Routes: /healthz, / (index), /f/<slug>.xml, /m/<slug>/<path>, /<slug>/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  discoverFeeds,
  listVideoFiles,
  ensureState,
  syncDeck,
  tickFeed,
  redealDeck,
} from './scan.js';
import { buildFeedXml } from './feeds.js';
import { serveMedia, safeMediaPath } from './media.js';
import { InvidiousClient } from './playlist.js';
import { pageIndex, pageStatus, pagePlain } from './pages.js';
import { weeklyOffsets, upcomingSlots } from './schedule.js';

const ENV = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  FEEDS_DIR: process.env.FEEDS_DIR || './feeds',
  DATA_DIR: process.env.DATA_DIR || './data',
  PUBLIC_BASE_URL: (process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/+$/, ''),
  INVIDIOUS_INTERNAL_URL: (process.env.INVIDIOUS_INTERNAL_URL || '').replace(/\/+$/, ''),
  INVIDIOUS_PUBLIC_URL: (process.env.INVIDIOUS_PUBLIC_URL || '').replace(/\/+$/, ''),
  SCAN_INTERVAL_SECONDS: parseInt(process.env.SCAN_INTERVAL_SECONDS || '60', 10),
};

const log = (msg) => console.log(`[drop-feed] ${new Date().toISOString()} ${msg}`);

fs.mkdirSync(ENV.DATA_DIR, { recursive: true });
const client = new InvidiousClient(ENV.INVIDIOUS_INTERNAL_URL);

// ---------- state persistence ----------

const statePath = (slug) => path.join(ENV.DATA_DIR, `${slug}.json`);

function loadState(slug) {
  try {
    return JSON.parse(fs.readFileSync(statePath(slug), 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  const p = statePath(state.slug);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, p);
}

// ---------- per-slug locking ----------

const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => {})
  );
  return next;
}

// ---------- feed pipeline ----------

function makeCtx(feed, cfg, state) {
  if (cfg.type === 'playlist') {
    return {
      base: ENV.PUBLIC_BASE_URL,
      invidiousPublic: ENV.INVIDIOUS_PUBLIC_URL || 'https://tube.halfab.net',
      rng: Math.random,
      currentIds: async () => {
        const listing = await client.listing(cfg.playlist);
        state.playlistTitle = listing.title;
        state.meta = Object.fromEntries(
          listing.videos.map((v) => [
            v.videoId,
            { title: v.title, author: v.author, lengthSeconds: v.lengthSeconds },
          ])
        );
        return listing.videos.map((v) => v.videoId);
      },
      isAvailable: (id) => client.available(id),
      meta: async (id) => state.meta?.[id] || null,
    };
  }
  const feedDir = feed.dirAbs;
  return {
    base: ENV.PUBLIC_BASE_URL,
    invidiousPublic: ENV.INVIDIOUS_PUBLIC_URL || 'https://tube.halfab.net',
    rng: Math.random,
    currentIds: async () => listVideoFiles(feedDir),
    isAvailable: async () => true,
    meta: async (id) => {
      try {
        return { size: fs.statSync(path.join(feedDir, id)).size };
      } catch {
        return { size: 0 };
      }
    },
  };
}

// Full pipeline for one feed: config → state → deck sync → release loop → save.
async function processFeed(feed) {
  const slug = feed.slug;
  if (!feed.parsed || !feed.parsed.ok) {
    // invalid config: keep serving existing history untouched, flag the error
    const state = loadState(slug);
    if (state) {
      const msg = feed.parsed ? feed.parsed.errors.join('; ') : 'no config.yml';
      if (state.flags.configError !== msg) {
        state.flags.configError = msg;
        saveState(state);
        log(`${slug}: config error — ${msg} (history still served)`);
      }
      return state;
    }
    return null;
  }
  const cfg = feed.parsed.config;
  const now = Date.now();
  const existing = loadState(slug);
  const { state } = ensureState(existing, feed.dirname, slug, cfg, now);
  const ctx = makeCtx(feed, cfg, state);

  // ids for creation / deck sync (transient playlist failure → skip this round)
  let ids = null;
  try {
    ids = await ctx.currentIds();
  } catch (e) {
    state.flags.lastError = `source listing failed: ${e.message}`;
    log(`${slug}: ${state.flags.lastError}`);
    saveState(state);
    return state;
  }
  if (state.flags.lastError) state.flags.lastError = null;

  if (existing === null) {
    redealDeck(state, ids, cfg.shuffle);
    state.flags.finished = ids.length === 0;
    log(`${slug}: created — ${ids.length} items, per_week=${cfg.per_week}, first=${cfg.first}`);
  } else {
    // live shuffle toggle → re-deal the pending deck
    if (state.lastShuffle !== cfg.shuffle) {
      const n = redealDeck(state, ids, cfg.shuffle);
      log(`${slug}: shuffle=${cfg.shuffle} — pending deck re-dealt (${n} items)`);
    } else {
      const { added, removed } = syncDeck(state, ids);
      if (added || removed) log(`${slug}: deck +${added}/-${removed}`);
    }
  }

  const { events, releasedNow } = await tickFeed(state, cfg, ctx, now);
  state.flags.configError = null;
  for (const ev of events) log(`${slug}: ${ev}`);
  if (releasedNow || events.length || existing === null) saveState(state);
  return state;
}

async function processAll() {
  const feeds = discoverFeeds(ENV.FEEDS_DIR);
  for (const feed of feeds) {
    if (feed.fatal) {
      log(`discovery: ${feed.fatal}`);
      continue;
    }
    await withLock(feed.slug, () => processFeed(feed));
  }
}

// ---------- helpers ----------

const SLUG_RE = /^[\w-]+$/;

function findFeed(slug) {
  return discoverFeeds(ENV.FEEDS_DIR).find((f) => !f.fatal && f.slug === slug) || null;
}

function sendXml(res, state, feed) {
  const xml = buildFeedXml(
    { title: feed.parsed.config.title, slug: state.slug, description: null },
    state,
    ENV.PUBLIC_BASE_URL
  );
  res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
  res.end(xml);
}

// ---------- router ----------

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    // index
    if (segments.length === 0) {
      if (req.method !== 'GET') return pagePlain(res, 405, 'method not allowed');
      await processAll();
      const feeds = discoverFeeds(ENV.FEEDS_DIR);
      const rows = [];
      for (const feed of feeds) {
        if (feed.fatal) continue;
        const state = loadState(feed.slug);
        rows.push({ feed, state, url: `${ENV.PUBLIC_BASE_URL}/f/${feed.slug}.xml` });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageIndex(rows, ENV));
      log(`index served (${Date.now() - started}ms)`);
      return;
    }

    // feed XML
    if (segments.length === 2 && segments[0] === 'f' && segments[1].endsWith('.xml')) {
      const slug = segments[1].replace(/\.xml$/, '');
      if (!SLUG_RE.test(slug)) return pagePlain(res, 404, 'unknown feed');
      const feed = findFeed(slug);
      if (!feed || !feed.parsed || !feed.parsed.ok) {
        const state = loadState(slug);
        if (feed && state) return sendXml(res, state, feed); // broken config → history
        return pagePlain(res, 404, 'unknown feed');
      }
      const state = await withLock(slug, () => processFeed(feed));
      if (!state) return pagePlain(res, 404, 'unknown feed');
      sendXml(res, state, feed);
      return;
    }

    // media
    if (segments[0] === 'm' && segments.length >= 3) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return pagePlain(res, 405, 'method not allowed');
      }
      const slug = segments[1];
      if (!SLUG_RE.test(slug)) return pagePlain(res, 404, 'not found');
      const feed = findFeed(slug);
      if (!feed) return pagePlain(res, 404, 'not found');
      const hit = safeMediaPath(feed.dirAbs, segments.slice(2).join('/'));
      if (!hit) return pagePlain(res, 404, 'not found');
      serveMedia(req, res, hit.abs, hit.size, safeMime(segments.at(-1)));
      return;
    }

    // status page
    if (segments.length === 1 && SLUG_RE.test(segments[0])) {
      if (req.method !== 'GET') return pagePlain(res, 405, 'method not allowed');
      const feed = findFeed(segments[0]);
      if (!feed) return pagePlain(res, 404, 'not found');
      const state = feed.parsed?.ok
        ? await withLock(feed.slug, () => processFeed(feed))
        : loadState(feed.slug);
      if (!state && !feed.parsed) return pagePlain(res, 404, 'unconfigured feed dir (no config.yml)');
      if (!state) return pagePlain(res, 404, 'feed not initialized yet');
      const next =
        feed.parsed?.ok && !feed.parsed.config.paused
          ? upcomingSlots(Date.now(), weeklyOffsets(feed.parsed.config.per_week), 3)
          : [];
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(pageStatus({ feed, state, cfg: feed.parsed?.config, next, env: ENV }));
      return;
    }

    pagePlain(res, 404, 'not found');
  } catch (e) {
    log(`request error: ${e.stack || e.message}`);
    try {
      pagePlain(res, 500, 'internal error');
    } catch {
      /* response already sent */
    }
  }
});

// mime from the decoded filename (media.js maps by extension)
import { mimeFor } from './media.js';
function safeMime(name) {
  return mimeFor(name);
}

server.listen(ENV.PORT, '127.0.0.1', () => {
  log(`listening on 127.0.0.1:${ENV.PORT}`);
  log(`feeds: ${ENV.FEEDS_DIR}  data: ${ENV.DATA_DIR}  base: ${ENV.PUBLIC_BASE_URL}`);
  processAll();
});

setInterval(processAll, ENV.SCAN_INTERVAL_SECONDS * 1000);
