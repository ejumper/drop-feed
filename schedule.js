// Weekly slot schedules computed in local time (container TZ = America/Chicago).
// Two modes:
//   fixed  — recurring weekly minute-offsets anchored on `time` (default 06:00)
//   random — `time: "random"`: day structure stays deterministic (cyclically
//            even days, same per-day counts), but each slot's time of day is
//            seeded per (feed, week) so slots are stable within a week and
//            fresh every week — recomputable at any time for catch-up, the
//            status page, and backfill.
// A slot is a minute-offset from Monday 00:00; calendar math (setDate/setHours)
// keeps wall-clock times stable across DST.

const DAY = 1440; // minutes
const WEEK = 7 * DAY;
const DEFAULT_ANCHOR = 6 * 60; // 06:00

// Days (0=Mon .. 6=Sun) that receive an extra slot when per_week doesn't
// divide evenly, spread as evenly as possible.
function extraDays(R) {
  const s = new Set();
  for (let i = 0; i < R; i++) s.add(Math.round((i * 7) / R));
  return s;
}

// Slots per weekday for per_week releases: [n_mon .. n_sun].
// N <= 7 : N days, day_i = round(i*7/N)  (cyclically even)
// N >  7 : every day floor(N/7), the R = N mod 7 days round(i*7/R) get +1.
function dayStructure(perWeek) {
  const counts = new Array(7).fill(0);
  if (perWeek <= 7) {
    for (let i = 0; i < perWeek; i++) counts[Math.round((i * 7) / perWeek)]++;
    return counts;
  }
  const k = Math.floor(perWeek / 7);
  const R = perWeek % 7;
  const extra = extraDays(R);
  for (let d = 0; d < 7; d++) counts[d] = k + (extra.has(d) ? 1 : 0);
  return counts;
}

// Sorted minute-offsets (from Monday 00:00, in [0, WEEK)) for the fixed mode.
// N <= 7 : N days at the anchor, day_i = round(i*7/N).
// N >  7 : every day gets floor(N/7) slots evenly spaced from the anchor;
//          remainder days get one extra and are re-spaced to k+1 slots.
// A slot past midnight spills into the next day (Sunday's spill wraps to next
// Monday 00:00, offset 0).
export function weeklyOffsets(perWeek, anchorMinutes = DEFAULT_ANCHOR) {
  if (!Number.isInteger(perWeek) || perWeek < 1) {
    throw new Error(`per_week must be an integer >= 1, got ${perWeek}`);
  }
  const offs = [];
  dayStructure(perWeek).forEach((n, d) => {
    for (let j = 0; j < n; j++) {
      let off = d * DAY + anchorMinutes + Math.round((j * DAY) / n);
      if (off >= WEEK) off -= WEEK;
      offs.push(off);
    }
  });
  return [...new Set(offs)].sort((a, b) => a - b);
}

// Random-mode offsets: same day structure, random minute of each day.
// Duplicates within a day are allowed (keeps the slot count exact).
export function randomWeekOffsets(perWeek, rng) {
  if (!Number.isInteger(perWeek) || perWeek < 1) {
    throw new Error(`per_week must be an integer >= 1, got ${perWeek}`);
  }
  const offs = [];
  dayStructure(perWeek).forEach((n, d) => {
    for (let j = 0; j < n; j++) offs.push(d * DAY + Math.floor(rng() * DAY));
  });
  return offs.sort((a, b) => a - b);
}

export function hash32(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// "HH:MM" -> minutes since midnight; null if malformed. Absent -> default.
export function parseTimeMinutes(s) {
  if (s === undefined || s === null || s === '') return DEFAULT_ANCHOR;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Monday 00:00 (local) of the week containing t.
export function weekStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

// Instant for minute-offset o within the week starting at Monday 00:00 (ms).
// Calendar construction (not ms addition) so wall-clock survives DST.
function instantAt(mondayMs, o) {
  const d = new Date(mondayMs);
  d.setDate(d.getDate() + Math.floor(o / DAY));
  d.setHours(Math.floor((o % DAY) / 60), o % 60, 0, 0);
  return d.getTime();
}

// A schedule answers "which instants does this week hold?".
//   fixed  — one static offsets array mapped onto any week
//   random — offsets regenerated per week from a (slug, week)-seeded PRNG:
//            stable within the week, fresh every week, recomputable anytime.
export function makeSchedule({ per_week, time, slug }) {
  if (time === 'random') {
    if (!Number.isInteger(per_week) || per_week < 1) {
      throw new Error(`per_week must be an integer >= 1, got ${per_week}`);
    }
    return {
      mode: 'random',
      slotInstants(mondayMs) {
        const rng = mulberry32(hash32(`${slug}:${Math.floor(mondayMs / 60000)}`));
        return randomWeekOffsets(per_week, rng).map((o) => instantAt(mondayMs, o));
      },
    };
  }
  const anchor = parseTimeMinutes(time);
  if (anchor === null) throw new Error(`time: expected HH:MM or "random", got ${time}`);
  const offsets = weeklyOffsets(per_week, anchor);
  return {
    mode: 'fixed',
    slotInstants(mondayMs) {
      return offsets.map((o) => instantAt(mondayMs, o));
    },
  };
}

// First slot instant strictly after t.
export function nextSlotAfter(t, schedule) {
  const monday = weekStart(t).getTime();
  let best = null;
  for (const inst of schedule.slotInstants(monday)) {
    if (inst > t && (best === null || inst < best)) best = inst;
  }
  if (best !== null) return best;
  const next = new Date(monday);
  next.setDate(next.getDate() + 7);
  return schedule.slotInstants(next.getTime())[0];
}

// The n slot instants after t (for the status page preview).
export function upcomingSlots(t, schedule, n) {
  const out = [];
  let cursor = t;
  for (let i = 0; i < n; i++) {
    const inst = nextSlotAfter(cursor, schedule);
    out.push(inst);
    cursor = inst;
  }
  return out;
}
