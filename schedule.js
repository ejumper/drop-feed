// Weekly slot schedule anchored on Monday 06:00, computed in local time
// (container TZ = America/Chicago). Slots recur every week; a slot is stored
// as a minute-offset from Monday 00:00. Calendar math (setDate/setHours) keeps
// wall-clock times stable across DST transitions.

const DAY = 1440; // minutes
const WEEK = 7 * DAY;
const ANCHOR = 6 * 60; // 06:00

// Days (0=Mon .. 6=Sun) that receive an extra slot when per_week doesn't
// divide evenly, spread as evenly as possible around the week.
function extraDays(R) {
  const s = new Set();
  for (let i = 0; i < R; i++) s.add(Math.round((i * 7) / R));
  return s;
}

// Sorted minute-offsets (from Monday 00:00, in [0, WEEK)) for per_week slots.
//
// N <= 7 : N days at 06:00, day_i = round(i*7/N)  (cyclically even)
// N >  7 : every day gets floor(N/7) slots at 06:00 + j*(24h/k); the
//          remainder R = N mod 7 days (round(i*7/R)) get one extra slot and
//          are re-spaced to k+1 slots. A slot past midnight spills into the
//          next day (Sunday's spill wraps to next Monday 00:00, offset 0).
export function weeklyOffsets(perWeek) {
  if (!Number.isInteger(perWeek) || perWeek < 1) {
    throw new Error(`per_week must be an integer >= 1, got ${perWeek}`);
  }
  const offs = new Set();
  if (perWeek <= 7) {
    for (let i = 0; i < perWeek; i++) {
      offs.add(Math.round((i * 7) / perWeek) * DAY + ANCHOR);
    }
  } else {
    const k = Math.floor(perWeek / 7);
    const R = perWeek % 7;
    const extra = extraDays(R);
    for (let d = 0; d < 7; d++) {
      const n = k + (extra.has(d) ? 1 : 0);
      for (let j = 0; j < n; j++) {
        let off = d * DAY + ANCHOR + Math.round((j * DAY) / n);
        if (off >= WEEK) off -= WEEK;
        offs.add(off);
      }
    }
  }
  return [...offs].sort((a, b) => a - b);
}

// Monday 00:00 (local) of the week containing t.
export function weekStart(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

// Instant for minute-offset o within the week starting at Monday 00:00.
// Calendar construction (not ms addition) so wall-clock survives DST.
function instantAt(monday, o) {
  const d = new Date(monday);
  d.setDate(d.getDate() + Math.floor(o / DAY));
  d.setHours(Math.floor((o % DAY) / 60), o % 60, 0, 0);
  return d.getTime();
}

// First slot instant strictly after t.
export function nextSlotAfter(t, offsets) {
  const monday = weekStart(t);
  let best = null;
  for (const o of offsets) {
    const inst = instantAt(monday, o);
    if (inst > t && (best === null || inst < best)) best = inst;
  }
  if (best !== null) return best;
  const next = new Date(monday);
  next.setDate(next.getDate() + 7);
  return instantAt(next, offsets[0]);
}

// The n slot instants after t (for the status page preview).
export function upcomingSlots(t, offsets, n) {
  const out = [];
  let cursor = t;
  for (let i = 0; i < n; i++) {
    const inst = nextSlotAfter(cursor, offsets);
    out.push(inst);
    cursor = inst;
  }
  return out;
}
