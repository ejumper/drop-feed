// drop-feed server: plain Node HTTP (tube-rss conventions — no framework).
// Routes: /healthz, / (index), /f/<slug>.xml, /m/<slug>/<path>, /<slug>/

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  discoverFeeds,
  listVideoFiles,
  ensureState,
  syncDeck,
  tickFeed,
  redealDeck,
  parseConfig,
  serializeConfig,
  REANCHOR_KEYS,
  slugify,
} from './scan.js';
import { buildFeedXml } from './feeds.js';
import { serveMedia, safeMediaPath, mimeFor } from './media.js';
import { InvidiousClient, parsePlaylistId, parseChannelSource, detectSource } from './playlist.js';
import { pageIndex, pageStatus, pagePlain } from './pages.js';
import { makeSchedule, upcomingSlots, parseTimeMinutes } from './schedule.js';
import { renderAdminPage, renderCreatePicker, renderCreateForm, channelUrl, defaultValues } from './admin.js';

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
  if (cfg.type === 'playlist' || cfg.type === 'channel') {
    const isChannel = cfg.type === 'channel';
    return {
      base: ENV.PUBLIC_BASE_URL,
      invidiousPublic: ENV.INVIDIOUS_PUBLIC_URL || 'https://tube.halfab.net',
      rng: Math.random,
      currentIds: async () => {
        const listing = isChannel
          ? await client.channelVideos(cfg.channel, cfg.tab)
          : await client.listing(cfg.playlist);
        state.sourceTitle = listing.title;
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
  let dirty = existing === null;

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
  if (state.flags.lastError) {
    state.flags.lastError = null;
    dirty = true;
  }

  if (existing === null) {
    redealDeck(state, ids, cfg.shuffle, Math.random, { sortNatural: cfg.type !== 'playlist' });
    state.flags.finished = ids.length === 0;
    log(`${slug}: created — ${ids.length} items, per_week=${cfg.per_week}, first=${cfg.first}`);
  } else {
    // live shuffle toggle → re-deal the pending deck
    if (state.lastShuffle !== cfg.shuffle) {
      const n = redealDeck(state, ids, cfg.shuffle, Math.random, {
        sortNatural: cfg.type !== 'playlist',
      });
      dirty = true;
      log(`${slug}: shuffle=${cfg.shuffle} — pending deck re-dealt (${n} items)`);
    } else {
      const { added, removed } = syncDeck(state, ids);
      if (added || removed) {
        dirty = true;
        log(`${slug}: deck +${added}/-${removed}`);
      }
    }
  }

  const { events, releasedNow } = await tickFeed(state, cfg, ctx, now);
  state.flags.configError = null;
  for (const ev of events) log(`${slug}: ${ev}`);
  if (releasedNow || events.length) dirty = true;
  if (dirty) saveState(state);
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

// ---------- admin UI ----------
// Structured config forms under /dropfeed/ (nginx passes the prefix through).
// Writes ONLY <feed dir>/config.yml, atomically, then runs processFeed for the
// feed immediately so the page can report the outcome (created / re-anchored
// / applied live).

const CREATE_DIRNAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function redirect(res, location) {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function readBody(req, cap = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function valuesFromBody(bodyText) {
  const b = new URLSearchParams(bodyText);
  const pick = (k) => String(b.getAll(k).at(-1) ?? '');
  const str = (k) => pick(k).trim();
  return {
    dirname: str('dirname'),
    title: str('title'),
    type: ['dir', 'playlist', 'channel'].includes(pick('type')) ? pick('type') : 'dir',
    channel: str('channel'),
    tab: pick('tab') || 'auto',
    playlist: str('playlist'),
    perWeek: str('per_week'),
    timeMode: pick('timeMode') === 'random' ? 'random' : 'fixed',
    time: str('time'),
    start: str('start'),
    first: pick('first') === 'immediate' ? 'immediate' : 'next',
    shuffle: pick('shuffle') === 'on',
    repeat: pick('repeat') === 'on',
    paused: pick('paused') === 'on',
  };
}

// Submitted form values → cfg object + per-field errors.
function buildConfigFromValues(v) {
  const errors = {};
  const per = /^\d+$/.test(v.perWeek) ? parseInt(v.perWeek, 10) : NaN;
  if (!Number.isInteger(per) || per < 1 || per > 168) errors.per_week = 'Integer between 1 and 168.';
  let time = null;
  if (v.timeMode === 'random') time = 'random';
  else if (v.time) {
    if (parseTimeMinutes(v.time) === null) errors.time = 'Expected HH:MM.';
    else time = v.time;
  }
  let start = null;
  if (v.start) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.start)) errors.start = 'Expected YYYY-MM-DD.';
    else start = v.start;
  }
  const cfg = {
    title: v.title || null,
    per_week: Number.isInteger(per) ? per : null,
    time,
    start,
    first: v.first,
    paused: v.paused,
    shuffle: v.shuffle,
    repeat: v.repeat,
    type: v.type,
  };
  if (v.type === 'playlist') {
    const pid = parsePlaylistId(v.playlist);
    if (!pid) errors.playlist = 'Playlist URL or ID required.';
    else cfg.playlist = pid;
  }
  if (v.type === 'channel') {
    const src = parseChannelSource(v.channel);
    if (!src) errors.channel = 'Channel URL (…/channel/UC…[/shorts|/videos|/streams]) or UCID required.';
    else {
      cfg.channel = src.ucid;
      cfg.tab = ['shorts', 'videos', 'streams', 'all'].includes(v.tab) ? v.tab : src.tab;
    }
  }
  return { cfg, errors };
}

// Serialize → parse round-trip. parseConfig stays the single validator, so
// the written file is exactly what the engine will read back.
function validateConfigText(cfg, dirname) {
  const text = serializeConfig(cfg);
  const parsed = parseConfig(text, dirname);
  const errors = {};
  if (!parsed.ok) {
    for (const msg of parsed.errors) {
      const key = String(msg).split(':')[0];
      if (['per_week', 'time', 'start', 'first', 'type', 'playlist', 'channel', 'tab'].includes(key)) errors[key] = msg;
      else errors.form = errors.form ? `${errors.form}; ${msg}` : msg;
    }
  }
  return { text, ok: parsed.ok, errors };
}

function dirAbsFor(dirname) {
  if (typeof dirname !== 'string' || !dirname || dirname.includes('/') || dirname.includes('\\') || dirname.startsWith('.')) return null;
  const root = path.resolve(ENV.FEEDS_DIR);
  const abs = path.resolve(root, dirname);
  return abs === root || !abs.startsWith(root + path.sep) ? null : abs;
}

async function writeAndProcess({ dirname, cfg, slug }) {
  const { text, ok, errors } = validateConfigText(cfg, dirname);
  if (!ok) return { errors };
  const dirAbs = dirAbsFor(dirname);
  if (!dirAbs) return { errors: { dirname: 'Invalid folder name.' } };
  const prev = loadState(slug);
  fs.mkdirSync(dirAbs, { recursive: true });
  const cfgPath = path.join(dirAbs, 'config.yml');
  const tmp = `${cfgPath}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, cfgPath);
  const feed = discoverFeeds(ENV.FEEDS_DIR).find((f) => !f.fatal && f.slug === slug);
  const state = feed ? await withLock(slug, () => processFeed(feed)) : null;
  const created = !prev;
  let note = 'Saved.';
  if (state && created) {
    const released = state.released.length ? ' — 1 released (first: immediate)' : '';
    note = `Feed created — ${state.deck.length} item${state.deck.length === 1 ? '' : 's'} in the deck${released}.`;
  } else if (state && prev) {
    const reAnchor = REANCHOR_KEYS.some(
      (k) => JSON.stringify(prev.snapshot?.[k]) !== JSON.stringify(state.snapshot?.[k])
    );
    const rel = state.released.length - (prev.released?.length || 0);
    note = reAnchor
      ? `Re-anchored — pending items re-slotted from now${rel > 0 ? `; ${rel} released` : ''}.`
      : `Saved — applies live (next scan ≤ ${ENV.SCAN_INTERVAL_SECONDS}s).`;
  }
  return { note, created, slug };
}

function feedsSnapshot() {
  const feeds = discoverFeeds(ENV.FEEDS_DIR).filter((f) => !f.fatal);
  return {
    rows: feeds.filter((f) => f.parsed?.ok).map((feed) => ({ feed, state: loadState(feed.slug) })),
    broken: feeds.filter((f) => f.parsed && !f.parsed.ok).map((feed) => ({ feed, state: loadState(feed.slug) })),
    unassigned: feeds.filter((f) => !f.parsed),
    all: feeds,
  };
}

function respondFormError(res, values, errors, snap) {
  const isDirPick = snap.unassigned.some((f) => f.dirname === values.dirname);
  const sourceLine =
    values.type === 'playlist'
      ? `playlist · ${values.playlist || '?'}`
      : values.type === 'channel'
        ? `channel · ${values.channel || '?'}`
        : `folder · ${values.dirname || '?'}`;
  const html = renderCreateForm({
    env: ENV,
    values,
    errors,
    sourceLine,
    sourceDetail: '',
    kind: isDirPick ? 'create-dir' : 'create-url',
    dirnameFixed: isDirPick,
  });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function respondFormErrorCard(res, feed, values, errors) {
  const snap = feedsSnapshot();
  const html = renderAdminPage({
    env: ENV,
    rows: snap.rows,
    broken: snap.broken,
    unassigned: snap.unassigned,
    flash: { saved: null, created: null, note: null },
    override: { slug: feed.slug, values, errors },
  });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

async function handleAdmin(req, res, segs, url) {
  const htmlHeaders = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };

  // GET /dropfeed/ — the list
  if (segs.length === 0 && req.method === 'GET') {
    const snap = feedsSnapshot();
    res.writeHead(200, htmlHeaders);
    res.end(
      renderAdminPage({
        env: ENV,
        rows: snap.rows,
        broken: snap.broken,
        unassigned: snap.unassigned,
        flash: {
          saved: url.searchParams.get('saved'),
          created: url.searchParams.get('created'),
          note: url.searchParams.get('note'),
        },
        override: null,
      })
    );
    return;
  }

  // GET /dropfeed/new — picker, or a prefilled create form
  if (segs.length === 1 && segs[0] === 'new' && req.method === 'GET') {
    const snap = feedsSnapshot();
    const dirParam = url.searchParams.get('dir');
    if (dirParam) {
      const feed = snap.unassigned.find((f) => f.dirname === dirParam);
      if (!feed) return redirect(res, '/dropfeed/new');
      res.writeHead(200, htmlHeaders);
      res.end(
        renderCreateForm({
          env: ENV,
          values: defaultValues(feed),
          errors: {},
          sourceLine: `folder · ${feed.dirname}`,
          sourceDetail: '',
          kind: 'create-dir',
          dirnameFixed: true,
        })
      );
      return;
    }
    const rawUrl = url.searchParams.get('url');
    if (!rawUrl) {
      res.writeHead(200, htmlHeaders);
      res.end(renderCreatePicker({ env: ENV, error: null, urlValue: '', unassigned: snap.unassigned }));
      return;
    }
    const showPicker = (error) => {
      res.writeHead(200, htmlHeaders);
      res.end(renderCreatePicker({ env: ENV, error, urlValue: rawUrl, unassigned: snap.unassigned }));
    };
    const src = detectSource(rawUrl);
    if (src.kind === 'video') {
      return showPicker('A single video is not a feed source — paste a channel, @handle or playlist URL.');
    }
    if (src.kind === 'unknown') {
      return showPicker('Not recognized — paste a channel (/channel/UC…), @handle or playlist URL.');
    }
    let ucid = null;
    let playlist = null;
    let tab = 'shorts';
    if (src.kind === 'channel') {
      ucid = src.ucid;
      tab = src.tab;
    } else if (src.kind === 'handle') {
      tab = src.tab;
      ucid = await client.resolveHandle(src.handle);
      if (!ucid) {
        return showPicker(
          `Could not resolve @${src.handle} — open it on ${ENV.INVIDIOUS_PUBLIC_URL || 'Invidious'} and paste the /channel/UC… URL instead.`
        );
      }
    } else {
      playlist = src.playlist;
    }
    let author = null;
    if (ucid) {
      try {
        author = (await client.channelAbout(ucid)).author;
      } catch {
        /* offline → blank title */
      }
    }
    const title = author || '';
    const dirname = slugify(title || playlist || ucid || 'feed');
    const values = {
      dirname,
      title,
      type: playlist ? 'playlist' : 'channel',
      channel: ucid ? channelUrl(ucid, tab) : '',
      tab: 'auto',
      playlist: playlist || '',
      perWeek: '',
      timeMode: 'fixed',
      time: '06:00',
      start: '',
      first: 'next',
      shuffle: false,
      repeat: true,
      paused: false,
    };
    res.writeHead(200, htmlHeaders);
    res.end(
      renderCreateForm({
        env: ENV,
        values,
        errors: {},
        sourceLine: playlist ? `playlist · ${playlist}` : `channel${author ? ` · ${author}` : ''} · ${tab}`,
        sourceDetail: rawUrl,
        kind: 'create-url',
        dirnameFixed: false,
      })
    );
    return;
  }

  // POST /dropfeed/create — new config from the create form
  if (segs.length === 1 && segs[0] === 'create' && req.method === 'POST') {
    const v = valuesFromBody(await readBody(req));
    const slug = slugify(v.dirname || 'feed');
    const snap = feedsSnapshot();
    if (snap.all.some((f) => f.slug === slug && f.parsed)) {
      return respondFormError(res, v, { dirname: 'A configured feed already uses that folder name.' }, snap);
    }
    const { cfg, errors } = buildConfigFromValues(v);
    if (v.dirname && !CREATE_DIRNAME_RE.test(v.dirname)) {
      errors.dirname = 'Lowercase letters, digits and dashes only.';
    }
    if (!Object.keys(errors).length) {
      const out = await writeAndProcess({ dirname: v.dirname, cfg, slug });
      if (out.errors) return respondFormError(res, v, out.errors, snap);
      return redirect(res, `/dropfeed/?created=${encodeURIComponent(slug)}&note=${encodeURIComponent(out.note)}`);
    }
    return respondFormError(res, v, errors, snap);
  }

  // POST /dropfeed/<slug> — edit an existing feed / first config for an unassigned dir
  if (segs.length === 1 && req.method === 'POST') {
    const slug = segs[0];
    if (!SLUG_RE.test(slug)) return pagePlain(res, 404, 'unknown feed');
    const feed = feedsSnapshot().all.find((f) => f.slug === slug);
    if (!feed) return pagePlain(res, 404, 'unknown feed');
    const v = valuesFromBody(await readBody(req));
    const { cfg, errors } = buildConfigFromValues(v);
    if (Object.keys(errors).length) return respondFormErrorCard(res, feed, v, errors);
    const out = await writeAndProcess({ dirname: feed.dirname, cfg, slug });
    if (out.errors) return respondFormErrorCard(res, feed, v, out.errors);
    return redirect(res, `/dropfeed/?saved=${encodeURIComponent(slug)}&note=${encodeURIComponent(out.note)}`);
  }

  pagePlain(res, 404, 'not found');
}

// ---------- router ----------

async function handler(req, res) {
  const started = Date.now();
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }

    // admin UI (nginx forwards /dropfeed/* with the prefix intact)
    if (segments[0] === 'dropfeed') {
      await handleAdmin(req, res, segments.slice(1), new URL(req.url, 'http://localhost'));
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
      serveMedia(req, res, hit.abs, hit.size, mimeFor(segments.at(-1)));
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
          ? upcomingSlots(
              Date.now(),
              makeSchedule({
                per_week: feed.parsed.config.per_week,
                time: feed.parsed.config.time,
                slug: feed.slug,
              }),
              3
            )
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
}

// bind all interfaces: docker-proxy traffic arrives on the container's eth0.
// createApp({ boot: false }) is the test entry point (no listen side effects
// beyond what the caller does; the scan interval only starts when booting).
export function createApp({ boot = false } = {}) {
  const server = http.createServer(handler);
  if (boot) {
    server.on('listening', () => {
      log(`listening on 127.0.0.1:${ENV.PORT}`);
      log(`feeds: ${ENV.FEEDS_DIR}  data: ${ENV.DATA_DIR}  base: ${ENV.PUBLIC_BASE_URL}`);
      processAll();
      setInterval(processAll, ENV.SCAN_INTERVAL_SECONDS * 1000);
    });
  }
  return server;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  createApp({ boot: true }).listen(ENV.PORT);
}
