// Feed discovery, config parsing, deck management, and the release engine.
//
// Model: state per feed is a cursor ("last released slot") plus an ordered
// deck of pending item ids. tickFeed releases deck items at due weekly slots.
// Released items are frozen (never re-dated, GUIDs stable); unreleased items
// are re-slotted freely. Empty deck without repeat = cursor tracks the clock
// (items added later start at the next slot, no catch-up dump).

import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { makeSchedule, nextSlotAfter, parseTimeMinutes } from './schedule.js';
import { isVideoFile, mimeFor } from './media.js';
import { parsePlaylistId, parseChannelSource } from './playlist.js';

export const VIDEO_EXTS = null; // see media.js (kept for reference)

const REANCHOR_KEYS = ['per_week', 'start', 'first', 'type', 'playlist', 'time', 'channel'];
const SLOT_SKIP_CAP = 10;

export function slugify(name) {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'feed';
}

export const naturalCompare = (a, b) =>
  a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

export function shuffle(ids, rng = Math.random) {
  const arr = [...ids];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Re-deal the pending deck (shuffle toggle / cycle start). Keeps released
// items frozen; pending = current ids minus this cycle's releases.
// sortNatural: filename feeds sort naturally; playlist feeds keep playlist order.
export function redealDeck(state, ids, shuffleOn, rng = Math.random, { sortNatural = true } = {}) {
  const releasedThisCycle = new Set(
    state.released.filter((r) => r.cycle === state.cycle).map((r) => r.id)
  );
  const pending = ids.filter((id) => !releasedThisCycle.has(id));
  state.deck = shuffleOn
    ? shuffle(pending, rng)
    : sortNatural
      ? [...pending].sort(naturalCompare)
      : [...pending];
  state.lastShuffle = shuffleOn;
  return pending.length;
}

function startInstant(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return null;
  const [y, m, d] = s.trim().split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

// parse config.yml text → { ok, config?, errors? }
export function parseConfig(text, dirname) {
  let raw;
  try {
    raw = parse(text);
  } catch (e) {
    return { ok: false, errors: [`YAML parse error: ${e.message}`] };
  }
  if (raw === null || raw === undefined) raw = {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['config must be a YAML mapping'] };
  }
  const errors = [];
  const cfg = {
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : dirname,
    per_week: raw.per_week,
    start: typeof raw.start === 'string' && raw.start.trim() ? raw.start.trim() : null,
    first: raw.first === 'immediate' ? 'immediate' : 'next',
    paused: raw.paused === true,
    shuffle: raw.shuffle === true,
    repeat: raw.repeat === true,
    time: typeof raw.time === 'string' && raw.time.trim() ? raw.time.trim().toLowerCase() : null,
    type: raw.type === 'playlist' ? 'playlist' : raw.type === 'channel' ? 'channel' : 'dir',
    playlist: null,
    channel: null,
  };
  if (!Number.isInteger(cfg.per_week) || cfg.per_week < 1) {
    errors.push('per_week: required integer >= 1');
  }
  if (cfg.time && cfg.time !== 'random' && parseTimeMinutes(cfg.time) === null) {
    errors.push('time: expected HH:MM or "random"');
  }
  if (cfg.start && !startInstant(cfg.start)) {
    errors.push('start: expected YYYY-MM-DD');
  }
  if (cfg.type === 'playlist') {
    const pid = parsePlaylistId(raw.playlist);
    if (!pid) errors.push('playlist: required playlist URL or ID when type is playlist');
    else cfg.playlist = pid;
  }
  if (cfg.type === 'channel') {
    const src = parseChannelSource(raw.channel);
    if (!src) errors.push('channel: required channel URL (…/channel/UC…[/shorts|/videos|/streams]) or UCID');
    else {
      cfg.channel = src.ucid;
      cfg.tab = src.tab;
    }
    const rawTab = typeof raw.tab === 'string' && raw.tab.trim() ? raw.tab.trim().toLowerCase() : null;
    if (rawTab && !['shorts', 'videos', 'streams', 'all'].includes(rawTab)) {
      errors.push('tab: expected shorts, videos, streams or all');
    } else if (rawTab) {
      cfg.tab = rawTab; // explicit override — the only way to express "all"
    }
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, config: cfg };
}

// One subdir under the feeds root.
export function discoverFeeds(feedsDir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(feedsDir, { withFileTypes: true });
  } catch (e) {
    return [{ fatal: `cannot read feeds dir: ${e.message}` }];
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dirAbs = path.join(feedsDir, e.name);
    const cfgPath = ['config.yml', 'config.yaml']
      .map((n) => path.join(dirAbs, n))
      .find((p) => fs.existsSync(p));
    const feed = { dirname: e.name, slug: slugify(e.name), dirAbs };
    if (!cfgPath) {
      feed.parsed = null; // unconfigured
    } else {
      feed.configPath = cfgPath;
      feed.parsed = parseConfig(fs.readFileSync(cfgPath, 'utf8'), e.name);
    }
    out.push(feed);
  }
  return out;
}

// Recursive, dotfile-skipping, naturally sorted video relpaths (forward slashes).
export function listVideoFiles(rootDir) {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), relPath);
      else if (e.isFile() && isVideoFile(e.name)) out.push(relPath);
    }
  };
  walk(rootDir, '');
  out.sort(naturalCompare);
  return out;
}

const iso = (t) => new Date(t).toISOString();

// Create-or-re-anchor snapshot. Returns { state, events }.
export function ensureState(prev, dirname, slug, cfg, now) {
  const snap = {
    per_week: cfg.per_week,
    start: cfg.start,
    first: cfg.first,
    type: cfg.type,
    playlist: cfg.playlist || null,
    channel: cfg.channel || null,
    time: cfg.time || null,
  };
  const events = [];
  if (!prev) {
    const state = {
      slug,
      dirname,
      snapshot: snap,
      cycle: 1,
      deck: [],
      released: [],
      cursor: null,
      lastPaused: false,
      lastShuffle: cfg.shuffle,
      pendingImmediate: cfg.first === 'immediate',
      playlistTitle: null,
      meta: {}, // playlist videoId -> { title, author, lengthSeconds }
      flags: { finished: false, configError: null, lastError: null, failedSlots: [] },
      createdAt: iso(now),
    };
    if (cfg.first !== 'immediate') {
      // cursor = start (or now): slots after it are due → backfill for past start
      state.cursor = iso(cfg.start ? startInstant(cfg.start) : now);
    } else {
      state.cursor = iso(now);
    }
    events.push('created');
    return { state, events };
  }
  const changed = REANCHOR_KEYS.filter(
    (k) => JSON.stringify(prev.snapshot?.[k]) !== JSON.stringify(snap[k])
  );
  if (changed.length) {
    prev.snapshot = snap;
    prev.cursor = iso(now);
    prev.flags.failedSlots = [];
    events.push(`re-anchored (${changed.join(', ')})`);
    if (cfg.first === 'immediate') prev.pendingImmediate = true;
  }
  return { state: prev, events };
}

// Append new ids, drop ids that vanished. Preserves deck order.
export function syncDeck(state, ids) {
  const idset = new Set(ids);
  const removed = state.deck.length;
  state.deck = state.deck.filter((id) => idset.has(id));
  const removedCount = removed - state.deck.length;
  const inDeck = new Set(state.deck);
  const releasedThisCycle = new Set(
    state.released.filter((r) => r.cycle === state.cycle).map((r) => r.id)
  );
  const fresh = ids.filter((id) => !inDeck.has(id) && !releasedThisCycle.has(id));
  if (fresh.length) {
    state.deck.push(...fresh);
    state.flags.finished = false;
  }
  return { added: fresh.length, removed: removedCount };
}

function buildEntry(state, cfg, id, meta, due, ctx) {
  const guid = `dropfeed:${state.slug}:${state.cycle}:${id}`;
  if (cfg.type === 'playlist' || cfg.type === 'channel') {
    const len = meta?.lengthSeconds;
    const dur =
      Number.isFinite(len) && len > 0
        ? `${Math.floor(len / 60)}:${String(len % 60).padStart(2, '0')}`
        : null;
    const source = state.sourceTitle || state.playlistTitle || cfg.title;
    const descBits = [`From ${source}`];
    if (dur) descBits.push(dur);
    return {
      guid,
      id,
      cycle: state.cycle,
      slot: iso(due),
      title: meta?.title || id,
      link: `${ctx.invidiousPublic}/embed/${encodeURIComponent(id)}?speed=1.8&quality_dash=auto`,
      enclosure: null,
      desc: descBits.join(' • '),
    };
  }
  const encoded = id.split('/').map(encodeURIComponent).join('/');
  const url = `${ctx.base}/m/${state.slug}/${encoded}`;
  return {
    guid,
    id,
    cycle: state.cycle,
    slot: iso(due),
    title: path.basename(id).replace(/\.[^.]+$/, ''),
    link: url,
    enclosure: { url, mime: mimeFor(id), size: meta?.size ?? 0 },
    desc: id,
  };
}

// The release loop. Mutates state; returns { events, releasedNow }.
// ctx: {
//   base, invidiousPublic, rng,
//   currentIds(): string[]  — sorted/current-order ids (throws → caller skips round)
//   isAvailable(id): boolean
//   meta(id): { size } | { title, author, lengthSeconds } | null
// }
export async function tickFeed(state, cfg, ctx, now) {
  const events = [];
  let releasedNow = 0;
  const schedule = makeSchedule({
    per_week: cfg.per_week,
    time: cfg.time,
    slug: state.slug,
  });

  if (cfg.paused) {
    state.cursor = iso(now); // frozen at now; unpause resumes at next slot
    state.flags.finished = !cfg.repeat && state.deck.length === 0 && state.released.length > 0;
    return { events, releasedNow };
  }
  if (state.lastPaused) {
    events.push('unpaused');
  }
  state.lastPaused = false;

  // first: immediate — release one item at now (waits for a non-empty deck)
  if (state.pendingImmediate) {
    if (state.deck.length > 0) {
      state.pendingImmediate = false;
      releasedNow += await releaseNext(state, cfg, ctx, now, events);
      state.cursor = iso(now);
    }
  }

  let guard = 0;
  while (guard++ < 10000) {
    const due = nextSlotAfter(new Date(state.cursor).getTime(), schedule);
    if (due > now) break;

    if (state.deck.length === 0) {
      if (cfg.repeat) {
        let ids;
        try {
          ids = await ctx.currentIds();
        } catch (e) {
          state.flags.lastError = `repeat rebuild failed: ${e.message}`;
          break;
        }
        if (!ids.length) {
          state.flags.finished = true;
          state.cursor = iso(now);
          break;
        }
        state.cycle += 1;
        state.deck = cfg.shuffle ? shuffle(ids, ctx.rng) : [...ids];
        state.flags.finished = false;
        events.push(`cycle ${state.cycle} started (${state.deck.length} items)`);
        continue; // this due slot releases the new cycle's first item
      }
      state.flags.finished = true;
      state.cursor = iso(now); // track the clock; new items start at next slot
      break;
    }

    const released = await releaseNext(state, cfg, ctx, due, events);
    if (released === 'failed') {
      state.flags.failedSlots.push({ slot: iso(due), reason: `${SLOT_SKIP_CAP}+ consecutive unavailable entries` });
      state.cursor = iso(due);
      continue;
    }
    releasedNow += released ? 1 : 0;
    if (released) state.cursor = iso(due);
    else break; // nothing releasable this round; avoid spinning
  }

  return { events, releasedNow };
}

// Release the next releasable deck item at slot time `due`.
// Returns true/false (released) or 'failed' (skip cap exhausted).
async function releaseNext(state, cfg, ctx, due, events) {
  let idx = 0;
  let consecutive = 0;
  while (idx < state.deck.length) {
    if (cfg.type !== 'playlist') break; // dir items are always available
    const ok = await ctx.isAvailable(state.deck[idx]);
    if (ok) break;
    consecutive += 1;
    if (consecutive >= SLOT_SKIP_CAP) {
      events.push(`slot skipped: ${consecutive} consecutive unavailable entries`);
      return 'failed';
    }
    idx += 1;
  }
  if (idx >= state.deck.length) {
    // deck empty can't happen (caller checks); dir path never reaches here
    return false;
  }
  const id = state.deck.splice(idx, 1)[0];
  let meta = null;
  try {
    meta = await ctx.meta(id);
  } catch {
    meta = null;
  }
  const entry = buildEntry(state, cfg, id, meta, due, ctx);
  state.released.push(entry);
  state.flags.finished = false;
  events.push(`released: ${id}`);
  return true;
}
