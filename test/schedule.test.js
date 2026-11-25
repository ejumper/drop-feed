// Schedule math tests — locks the table in the plan (§2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { weeklyOffsets, makeSchedule, nextSlotAfter, weekStart, upcomingSlots, randomWeekOffsets, parseTimeMinutes, mulberry32, hash32 } from '../schedule.js';

const DAY = 1440;
const at = (day, minutes) => day * DAY + minutes; // minutes offset from Mon 00:00
const M6 = 360;
const M18 = 1080;

test('per_week 1–7 daily patterns', () => {
  assert.deepEqual(weeklyOffsets(1), [at(0, M6)]);
  assert.deepEqual(weeklyOffsets(2), [at(0, M6), at(4, M6)]); // Mon, Fri
  assert.deepEqual(weeklyOffsets(3), [at(0, M6), at(2, M6), at(5, M6)]); // Mon, Wed, Sat
  assert.deepEqual(weeklyOffsets(4), [at(0, M6), at(2, M6), at(4, M6), at(5, M6)]); // Mon, Wed, Fri, Sat
  assert.deepEqual(weeklyOffsets(5), [at(0, M6), at(1, M6), at(3, M6), at(4, M6), at(6, M6)]);
  assert.deepEqual(weeklyOffsets(6), [at(0, M6), at(1, M6), at(2, M6), at(4, M6), at(5, M6), at(6, M6)]);
  assert.deepEqual(weeklyOffsets(7), [0, 1, 2, 3, 4, 5, 6].map((d) => at(d, M6)));
});

test('per_week 10 = daily 06:00 + Mon/Wed/Sat 18:00', () => {
  assert.deepEqual(weeklyOffsets(10), [
    at(0, M6), at(0, M18),
    at(1, M6),
    at(2, M6), at(2, M18),
    at(3, M6),
    at(4, M6),
    at(5, M6), at(5, M18),
    at(6, M6),
  ]);
});

test('per_week 14 = daily 06:00 & 18:00', () => {
  const expected = [];
  for (let d = 0; d < 7; d++) expected.push(at(d, M6), at(d, M18));
  assert.deepEqual(weeklyOffsets(14), expected);
});

test('per_week 21 = daily 06:00, 14:00, 22:00', () => {
  const expected = [];
  for (let d = 0; d < 7; d++) expected.push(at(d, 360), at(d, 840), at(d, 1320));
  assert.deepEqual(weeklyOffsets(21), expected);
});

test('per_week 8 = daily 06:00 + Mon 18:00', () => {
  const expected = [at(0, M6), at(0, M18)];
  for (let d = 1; d < 7; d++) expected.push(at(d, M6));
  assert.deepEqual(weeklyOffsets(8), expected.sort((a, b) => a - b));
});

test('offsets are unique, sorted, within one week', () => {
  for (let n = 1; n <= 35; n++) {
    const offs = weeklyOffsets(n);
    assert.equal(offs.length, n, `count for ${n}`);
    for (let i = 1; i < offs.length; i++) {
      assert.ok(offs[i] > offs[i - 1], `sorted+unique for ${n}`);
    }
    assert.ok(offs[0] >= 0 && offs.at(-1) < 7 * DAY, `range for ${n}`);
  }
});

test('validation', () => {
  assert.throws(() => weeklyOffsets(0));
  assert.throws(() => weeklyOffsets(2.5));
});

const d = (month, day, h, min = 0) => new Date(2026, month - 1, day, h, min, 0, 0);

test('nextSlotAfter basics (local time, Dec 2026: Dec 1 = Tue)', () => {
  const w7 = makeSchedule({ per_week: 7 });
  // Wednesday Dec 2 12:00 → Thursday Dec 3 06:00
  assert.deepEqual(new Date(nextSlotAfter(d(12, 2, 12), w7)), d(12, 3, 6));
  // Sunday Dec 6 23:00 → Monday Dec 7 06:00
  assert.deepEqual(new Date(nextSlotAfter(d(12, 6, 23), w7)), d(12, 7, 6));
  // exactly at a slot → strictly after
  assert.deepEqual(new Date(nextSlotAfter(d(12, 7, 6), w7)), d(12, 8, 6));
  // per_week 3 (Mon, Wed, Sat): Thu Dec 3 → Sat Dec 5
  const w3 = makeSchedule({ per_week: 3 });
  assert.deepEqual(new Date(nextSlotAfter(d(12, 3, 12), w3)), d(12, 5, 6));
  // per_week 14: Thu 09:00 → Thu 18:00
  assert.deepEqual(new Date(nextSlotAfter(d(12, 3, 9), makeSchedule({ per_week: 14 }))), d(12, 3, 18));
  // per_week 21 (06/14/22): Thu 15:00 → Thu 22:00
  assert.deepEqual(new Date(nextSlotAfter(d(12, 3, 15), makeSchedule({ per_week: 21 }))), d(12, 3, 22));
});

test('weekStart lands on Monday 00:00', () => {
  assert.deepEqual(weekStart(d(12, 2, 12)), d(11, 30, 0)); // Wed → Mon Nov 30
  assert.deepEqual(weekStart(d(12, 7, 6)), d(12, 7, 0)); // Monday itself
  assert.deepEqual(weekStart(d(12, 6, 23)), d(11, 30, 0)); // Sunday
});

test('upcomingSlots returns strictly increasing future slots', () => {
  const ups = upcomingSlots(d(12, 2, 12), makeSchedule({ per_week: 3 }), 3);
  assert.equal(ups.length, 3);
  assert.deepEqual(new Date(ups[0]), d(12, 5, 6)); // Sat
  assert.deepEqual(new Date(ups[1]), d(12, 7, 6)); // Mon
  assert.deepEqual(new Date(ups[2]), d(12, 9, 6)); // Wed
});

test('anchor param moves slot times', () => {
  assert.deepEqual(weeklyOffsets(2, 870), [870, 870 + 4 * DAY]);
  const sched = makeSchedule({ per_week: 1, time: '14:30' });
  const inst = sched.slotInstants(weekStart(d(12, 7, 6)).getTime())[0];
  assert.deepEqual(new Date(inst), d(12, 7, 14, 30));
});

test('parseTimeMinutes', () => {
  assert.equal(parseTimeMinutes('06:00'), 360);
  assert.equal(parseTimeMinutes('6:00'), 360);
  assert.equal(parseTimeMinutes('14:30'), 870);
  assert.equal(parseTimeMinutes(undefined), 360);
  assert.equal(parseTimeMinutes('random'), null);
  assert.equal(parseTimeMinutes('25:00'), null);
  assert.equal(parseTimeMinutes('12:99'), null);
});

test('random: deterministic per (slug, week), correct structure', () => {
  const monday = weekStart(d(12, 7, 6)).getTime();
  const sched = makeSchedule({ per_week: 14, time: 'random', slug: 'x' });
  const a = sched.slotInstants(monday);
  const b = sched.slotInstants(monday);
  assert.deepEqual(a, b);              // stable within the week
  assert.equal(a.length, 14);
  const perDay = new Array(7).fill(0);
  for (const inst of a) perDay[(new Date(inst).getDay() + 6) % 7]++;
  assert.deepEqual(perDay, [2, 2, 2, 2, 2, 2, 2]);   // 2 random slots every day
  const nm = new Date(monday);
  nm.setDate(nm.getDate() + 7);
  const c = sched.slotInstants(nm.getTime());
  assert.equal(c.length, 14);
  assert.notDeepEqual(a, c);          // fresh times the next week
});

test('randomWeekOffsets: count, range, sorted', () => {
  const offs = randomWeekOffsets(21, mulberry32(hash32('seed')));
  assert.equal(offs.length, 21);
  for (const o of offs) assert.ok(o >= 0 && o < 7 * DAY, `range: ${o}`);
  assert.deepEqual(offs, [...offs].sort((x, y) => x - y));
});
