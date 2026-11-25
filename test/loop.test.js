// Release-loop tests with a fake clock and stub sources.
// Local TZ (America/Chicago) — Jan 1 2026 is a Thursday.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureState, syncDeck, tickFeed, redealDeck, naturalCompare, parseConfig } from '../scan.js';
import { makeSchedule, weekStart } from '../schedule.js';

const mkCfg = (over = {}) => ({
  title: 'T',
  per_week: 7,
  start: null,
  first: 'next',
  paused: false,
  shuffle: false,
  repeat: false,
  type: 'dir',
  playlist: null,
  ...over,
});

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mkCtx = (ids, over = {}) => ({
  base: 'http://x',
  invidiousPublic: 'https://tube.example',
  rng: mulberry32(42),
  currentIds: async () => [...ids],
  isAvailable: async () => true,
  meta: async (id) => ({ size: 100 }),
  ...over,
});

const T = (isoLocal) => new Date(isoLocal).getTime();
const iso = (d) => new Date(d).toISOString();

test('creation with past start backfills up to deck exhaustion, then tracks clock', async () => {
  const cfg = mkCfg({ start: '2026-01-01' });
  const { state } = ensureState(null, 'dir', 'dir', cfg, T('2026-01-05T12:00:00'));
  state.deck = ['a', 'b', 'c'];
  const ctx = mkCtx(['a', 'b', 'c']);

  const { releasedNow } = await tickFeed(state, cfg, ctx, T('2026-01-05T12:00:00'));
  assert.equal(releasedNow, 3);
  assert.equal(state.released.length, 3);
  // slots: Jan 1, 2, 3 at 06:00 (Jan 4/5 slots had no items left)
  assert.equal(state.released[0].slot, iso(T('2026-01-01T06:00:00')));
  assert.equal(state.released[1].slot, iso(T('2026-01-02T06:00:00')));
  assert.equal(state.released[2].slot, iso(T('2026-01-03T06:00:00')));
  assert.equal(state.flags.finished, true);
  assert.equal(state.cursor, iso(T('2026-01-05T12:00:00')));
});

test('first: immediate releases item 1 at creation, rest via slots', async () => {
  const cfg = mkCfg({ first: 'immediate' });
  const { state } = ensureState(null, 'dir', 'dir', cfg, T('2026-01-06T10:00:00'));
  state.deck = ['a', 'b'];
  const ctx = mkCtx(['a', 'b']);

  await tickFeed(state, cfg, ctx, T('2026-01-06T10:00:00'));
  assert.equal(state.released.length, 1);
  assert.equal(state.released[0].slot, iso(T('2026-01-06T10:00:00')));
  assert.equal(state.released[0].id, 'a');
  assert.equal(state.cursor, iso(T('2026-01-06T10:00:00')));
  assert.deepEqual(state.deck, ['b']);

  // next slot = Jan 7 06:00
  await tickFeed(state, cfg, ctx, T('2026-01-07T07:00:00'));
  assert.equal(state.released[1].slot, iso(T('2026-01-07T06:00:00')));
  assert.equal(state.released[1].id, 'b');
});

test('pause freezes progress; unpause resumes at next slot without dump', async () => {
  const cfg = mkCfg({ first: 'immediate' });
  const { state } = ensureState(null, 'dir', 'dir', cfg, T('2026-01-06T10:00:00'));
  state.deck = ['a', 'b'];
  const ctx = mkCtx(['a', 'b']);
  await tickFeed(state, cfg, ctx, T('2026-01-06T10:00:00'));

  // paused for two days — cursor pinned to now, nothing releases
  const paused = { ...cfg, paused: true };
  await tickFeed(state, paused, ctx, T('2026-01-07T12:00:00'));
  await tickFeed(state, paused, ctx, T('2026-01-08T12:00:00'));
  assert.equal(state.released.length, 1);
  assert.equal(state.cursor, iso(T('2026-01-08T12:00:00')));

  // unpause → nothing due yet (next slot Jan 9 06:00 is still in the future)
  await tickFeed(state, cfg, ctx, T('2026-01-08T13:00:00'));
  assert.equal(state.released.length, 1);

  // first slot after unpause
  await tickFeed(state, cfg, ctx, T('2026-01-09T07:00:00'));
  assert.equal(state.released.length, 2);
  assert.equal(state.released[1].slot, iso(T('2026-01-09T06:00:00')));
});

test('items added to a dry feed start at the next slot (no backfill dump)', async () => {
  const cfg = mkCfg({ start: '2026-01-01' });
  const { state } = ensureState(null, 'dir', 'dir', cfg, T('2026-01-05T12:00:00'));
  state.deck = ['a'];
  const ctx = mkCtx(['a']);
  await tickFeed(state, cfg, ctx, T('2026-01-05T12:00:00'));
  assert.equal(state.flags.finished, true);

  // file appears two days later
  const ctx2 = mkCtx(['a', 'd']);
  syncDeck(state, ['a', 'd']);
  assert.deepEqual(state.deck, ['d']);
  state.flags.finished = false;
  await tickFeed(state, cfg, ctx2, T('2026-01-07T12:00:00'));
  assert.equal(state.released[1].slot, iso(T('2026-01-06T06:00:00'))); // first slot after the dry cursor — no backfill dump
});

test('re-anchor keeps released history and re-slots the rest', async () => {
  const cfg = mkCfg({ per_week: 7, first: 'immediate' });
  const { state } = ensureState(null, 'dir', 'dir', cfg, T('2026-01-06T10:00:00'));
  state.deck = ['a', 'b', 'c'];
  const ctx = mkCtx(['a', 'b', 'c']);
  await tickFeed(state, cfg, ctx, T('2026-01-06T10:00:00'));
  await tickFeed(state, cfg, ctx, T('2026-01-07T07:00:00')); // b @ Jan 7 06:00
  assert.equal(state.released.length, 2);
  const guidA = state.released[0].guid;

  // per_week 7 → 2 (and immediate → next: both re-anchor fields)
  const cfg2 = { ...cfg, per_week: 2, first: 'next' };
  const { state: same, events } = ensureState(state, 'dir', 'dir', cfg2, T('2026-01-08T10:00:00'));
  assert.ok(events.some((e) => e.startsWith('re-anchored')));
  assert.equal(same.released.length, 2);
  assert.equal(same.released[0].guid, guidA); // frozen

  // due slots are now Mon/Fri 06:00 → next is Fri Jan 9
  await tickFeed(same, cfg2, ctx, T('2026-01-08T10:00:00'));
  assert.equal(same.released.length, 2); // nothing due yet
  await tickFeed(same, cfg2, ctx, T('2026-01-12T07:00:00'));
  assert.equal(same.released.length, 3);
  assert.equal(same.released[2].slot, iso(T('2026-01-09T06:00:00')));
  assert.equal(same.released[2].id, 'c');
});

test('repeat starts a new cycle with fresh GUIDs', async () => {
  const cfg = mkCfg({ per_week: 7, first: 'immediate', repeat: true });
  const { state } = ensureState(null, 'dir', 'dir', cfg, T('2026-01-06T10:00:00'));
  state.deck = ['a', 'b'];
  const ctx = mkCtx(['a', 'b']);
  await tickFeed(state, cfg, ctx, T('2026-01-06T10:00:00'));
  await tickFeed(state, cfg, ctx, T('2026-01-07T07:00:00'));
  await tickFeed(state, cfg, ctx, T('2026-01-08T07:00:00'));
  // Jan 8 06:00 slot with empty deck + repeat → cycle 2 starts on that slot
  assert.equal(state.cycle, 2);
  assert.equal(state.released.length, 3);
  assert.equal(state.released[2].id, 'a');
  assert.equal(state.released[2].guid, 'dropfeed:dir:2:a');
  assert.equal(state.released[0].guid, 'dropfeed:dir:1:a');

  // cycle 2 continues on subsequent slots
  await tickFeed(state, cfg, ctx, T('2026-01-09T07:00:00'));
  assert.equal(state.released.length, 4);
  assert.equal(state.released[3].id, 'b');
  assert.equal(state.released[3].slot, iso(T('2026-01-09T06:00:00')));
});

test('playlist deck keeps playlist order (no natural re-sort of ids)', () => {
  const cfg = mkCfg({ type: 'playlist', playlist: 'PLtest12345678' });
  const { state } = ensureState(null, 'pl', 'pl', cfg, T('2026-01-06T10:00:00'));
  // ids deliberately NOT alphabetically sorted — playlist order must survive
  const ids = ['zvid3', 'avid1', 'mvid2', '-eTYA9n2YlE'];
  redealDeck(state, ids, false, Math.random, { sortNatural: false });
  assert.deepEqual(state.deck, ['zvid3', 'avid1', 'mvid2', '-eTYA9n2YlE']);
});

test('shuffle deck holds the same set; re-deal on toggle keeps released frozen', () => {
  const cfg = mkCfg({ shuffle: true });
  const { state } = ensureState(null, 'dir', 'dir', cfg, T('2026-01-06T10:00:00'));
  const ids = ['01-a.mp4', '02-b.mp4', '10-c.mp4', '03-d.mp4'];
  redealDeck(state, ids, true, mulberry32(7));
  assert.equal(state.deck.length, 4);
  assert.deepEqual([...state.deck].sort(naturalCompare), [...ids].sort(naturalCompare));
  assert.equal(state.lastShuffle, true);

  // release two, then toggle shuffle off → remaining deck sorted naturally
  state.deck = ['10-c.mp4', '01-a.mp4', '02-b.mp4', '03-d.mp4'];
  state.released = [
    { guid: 'g1', id: '10-c.mp4', cycle: 1, slot: '', title: 'c', link: '', enclosure: null, desc: '' },
    { guid: 'g2', id: '03-d.mp4', cycle: 1, slot: '', title: 'd', link: '', enclosure: null, desc: '' },
  ];
  redealDeck(state, ids, false);
  assert.deepEqual(state.deck, ['01-a.mp4', '02-b.mp4']);
  assert.equal(state.lastShuffle, false);
});

test('playlist: skips dead entries, releases next available', async () => {
  const cfg = mkCfg({ type: 'playlist', playlist: 'PLtest12345678', per_week: 7, first: 'immediate' });
  const { state } = ensureState(null, 'pl', 'pl', cfg, T('2026-01-06T10:00:00'));
  state.playlistTitle = 'PL';
  state.deck = ['dead1', 'dead2', 'alive', 'x'];
  const dead = new Set(['dead1', 'dead2']);
  const ctx = mkCtx(state.deck, {
    isAvailable: async (id) => !dead.has(id),
    meta: async (id) => ({ title: `t-${id}`, lengthSeconds: 60 }),
  });
  await tickFeed(state, cfg, ctx, T('2026-01-06T10:00:00'));
  assert.equal(state.released.length, 1);
  assert.equal(state.released[0].id, 'alive');
  assert.ok(state.released[0].link.includes('/embed/alive'));
  assert.deepEqual(state.deck, ['dead1', 'dead2', 'x']);
});

test('playlist: 10+ consecutive dead entries fail the slot, cursor advances', async () => {
  const cfg = mkCfg({ type: 'playlist', playlist: 'PLtest12345678', per_week: 7, first: 'immediate' });
  const { state } = ensureState(null, 'pl', 'pl', cfg, T('2026-01-06T10:00:00'));
  const deadIds = Array.from({ length: 12 }, (_, i) => `dead${i}`);
  state.deck = [...deadIds, 'alive'];
  const ctx = mkCtx(state.deck, {
    isAvailable: async (id) => !deadIds.includes(id),
    meta: async (id) => ({ title: id, lengthSeconds: 1 }),
  });
  await tickFeed(state, cfg, ctx, T('2026-01-06T10:00:00'));
  // immediate walk hits the 10-skip cap (12 dead heads) → nothing released now
  assert.equal(state.released.length, 0);

  // next slot: deck head is 12 dead entries → slot fails, cursor advances past it
  state.deck = deadIds;
  await tickFeed(state, cfg, ctx, T('2026-01-07T07:00:00'));
  assert.equal(state.released.length, 0);
  assert.equal(state.flags.failedSlots.length, 1);
  assert.equal(state.cursor, iso(T('2026-01-07T06:00:00')));
  assert.equal(state.deck.length, deadIds.length); // nothing dropped
});

test('config parsing: time and channel', () => {
  const okT = parseConfig('per_week: 4\ntime: "14:30"\n', 'dir');
  assert.equal(okT.ok, true);
  assert.equal(okT.config.time, '14:30');
  const okR = parseConfig('per_week: 4\ntime: random\n', 'dir');
  assert.equal(okR.ok, true);
  assert.equal(okR.config.time, 'random');
  const badT = parseConfig('per_week: 4\ntime: "25:99"\n', 'dir');
  assert.equal(badT.ok, false);
  const okC = parseConfig('per_week: 4\ntype: channel\nchannel: https://tube.halfab.net/channel/UCX6OQ3DkcsbYNE6H8uQQuVA/videos\n', 'c');
  assert.equal(okC.ok, true);
  assert.equal(okC.config.channel, 'UCX6OQ3DkcsbYNE6H8uQQuVA');
  assert.equal(okC.config.tab, 'videos');
  const badC = parseConfig('per_week: 4\ntype: channel\n', 'c');
  assert.equal(badC.ok, false);
});

test('time change re-anchors pending items under the new anchor', async () => {
  const cfg = mkCfg({ per_week: 7, first: 'immediate', time: '06:00' });
  const { state } = ensureState(null, 'dir', 'dir', cfg, T('2026-01-06T10:00:00'));
  state.deck = ['a', 'b', 'c'];
  const ctx = mkCtx(['a', 'b', 'c']);
  await tickFeed(state, cfg, ctx, T('2026-01-06T10:00:00'));
  assert.equal(state.released.length, 1);

  const cfg2 = { ...cfg, time: '14:30' };
  const { state: same, events } = ensureState(state, 'dir', 'dir', cfg2, T('2026-01-06T11:00:00'));
  assert.ok(events.some((e) => e.startsWith('re-anchored')));
  await tickFeed(same, cfg2, ctx, T('2026-01-06T11:00:00'));
  assert.equal(same.released.length, 2); // immediate fired again at re-anchor
  assert.equal(same.released[1].slot, iso(T('2026-01-06T11:00:00')));

  // future slots follow the 14:30 anchor: next is Jan 6 14:30 (same day, after the 11:00 re-anchor)
  await tickFeed(same, cfg2, ctx, T('2026-01-07T15:00:00'));
  assert.equal(same.released[2].slot, iso(T('2026-01-06T14:30:00')));
});

test('random mode: catch-up releases at the deterministic random slots', async () => {
  const slug = 'dir';
  const cfg = mkCfg({ per_week: 14, first: 'next', time: 'random', start: '2026-01-01' });
  const { state } = ensureState(null, 'dir', slug, cfg, T('2026-01-05T12:00:00'));
  const ids = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, '0')}`);
  state.deck = [...ids];
  const ctx = mkCtx(ids);
  const start = T('2026-01-01T00:00:00');
  const now = T('2026-01-05T12:00:00');
  await tickFeed(state, cfg, ctx, now);

  // recompute the expected due set from the schedule itself
  const sched = makeSchedule({ per_week: 14, time: 'random', slug });
  const expected = [];
  for (const monday of [weekStart(start).getTime(), weekStart(now).getTime()]) {
    for (const inst of sched.slotInstants(monday)) {
      if (inst > start && inst <= now) expected.push(inst);
    }
  }
  expected.sort((a, b) => a - b);
  assert.equal(state.released.length, expected.length);
  assert.deepEqual(state.released.map((r) => T(r.slot)), expected);

  // determinism across fresh runs
  const { state: s2 } = ensureState(null, 'dir', slug, cfg, T('2026-01-05T12:00:00'));
  s2.deck = [...ids];
  await tickFeed(s2, cfg, mkCtx(ids), now);
  assert.deepEqual(s2.released.map((r) => r.slot), state.released.map((r) => r.slot));
});

test('deck sync appends new files and drops vanished ones', () => {
  const { state } = ensureState(null, 'dir', 'dir', mkCfg(), T('2026-01-06T10:00:00'));
  state.deck = ['a', 'b'];
  const { added, removed } = syncDeck(state, ['b', 'c']);
  assert.equal(added, 1);
  assert.equal(removed, 1);
  assert.deepEqual(state.deck, ['b', 'c']);
});

test('config parsing validates per_week and playlist', () => {
  const bad = parseConfig('title: x\n', 'dir');
  assert.equal(bad.ok, false);
  const ok = parseConfig('per_week: 4\nshuffle: true\n', 'dir');
  assert.equal(ok.ok, true);
  assert.equal(ok.config.shuffle, true);
  assert.equal(ok.config.title, 'dir');
  const pl = parseConfig('per_week: 3\ntype: playlist\nplaylist: https://tube.halfab.net/playlist?list=PLabc123456789\n', 'pl');
  assert.equal(pl.ok, true);
  assert.equal(pl.config.playlist, 'PLabc123456789');
  const plBad = parseConfig('per_week: 3\ntype: playlist\n', 'pl');
  assert.equal(plBad.ok, false);
});
