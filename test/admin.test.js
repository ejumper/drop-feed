// Admin UI tests: serializeConfig round-trips, detectSource classification,
// handle resolution, and the /dropfeed/ routes (against a fake Invidious).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { serializeConfig, parseConfig } from '../scan.js';
import { detectSource, InvidiousClient, CHANNEL_URL_BASE } from '../playlist.js';

const UCID = 'UCtest1234567890abcdefgh';

// ---------- serializeConfig ----------

test('serializeConfig: dir minimal, defaults omitted, round-trips', () => {
  const text = serializeConfig({ title: 'My Course', per_week: 3 });
  assert.match(text, /^title: My Course$/m);
  assert.match(text, /^per_week: 3$/m);
  assert.match(text, /^type: dir$/m);
  assert.doesNotMatch(text, /paused|shuffle|repeat|first|time|start/);
  const parsed = parseConfig(text, 'dir');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.title, 'My Course');
  assert.equal(parsed.config.per_week, 3);
  assert.equal(parsed.config.paused, false);
  assert.equal(parsed.config.first, 'next');
});

test('serializeConfig: optional fields written only when set', () => {
  const text = serializeConfig({
    title: 'X', per_week: 7, time: 'random', first: 'immediate',
    shuffle: true, repeat: true, paused: true,
  });
  assert.match(text, /^time: random$/m);
  assert.match(text, /^first: immediate$/m);
  assert.match(text, /^shuffle: true$/m);
  assert.match(text, /^repeat: true$/m);
  assert.match(text, /^paused: true$/m);
  const parsed = parseConfig(text, 'x');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.time, 'random');
  assert.equal(parsed.config.first, 'immediate');
});

test('serializeConfig: fixed time round-trips', () => {
  const text = serializeConfig({ title: 'X', per_week: 1, time: '06:00' });
  const parsed = parseConfig(text, 'x');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.time, '06:00');
});

test('serializeConfig: channel tab lives in the URL; all needs the tab line', () => {
  const shorts = serializeConfig({ title: 'S', per_week: 7, type: 'channel', channel: UCID, tab: 'shorts' });
  assert.match(shorts, new RegExp(`^channel: ${CHANNEL_URL_BASE}/channel/${UCID}/shorts$`, 'm'));
  assert.doesNotMatch(shorts, /^tab:/m);
  const p1 = parseConfig(shorts, 's');
  assert.equal(p1.config.tab, 'shorts');
  assert.equal(p1.config.channel, UCID);

  const all = serializeConfig({ title: 'A', per_week: 7, type: 'channel', channel: UCID, tab: 'all' });
  assert.match(all, new RegExp(`^channel: ${CHANNEL_URL_BASE}/channel/${UCID}$`, 'm'));
  assert.match(all, /^tab: all$/m);
  const p2 = parseConfig(all, 'a');
  assert.equal(p2.ok, true);
  assert.equal(p2.config.tab, 'all');
  assert.equal(p2.config.channel, UCID);

  const videos = serializeConfig({ title: 'V', per_week: 7, type: 'channel', channel: UCID, tab: 'videos' });
  assert.match(videos, /\/videos$/m);
  const p3 = parseConfig(videos, 'v');
  assert.equal(p3.config.tab, 'videos');
});

test('serializeConfig: playlist id and awkward titles round-trip', () => {
  const text = serializeConfig({ title: 'A: B "C"', per_week: 2, type: 'playlist', playlist: 'PLabc123456789' });
  const parsed = parseConfig(text, 'p');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.title, 'A: B "C"');
  assert.equal(parsed.config.playlist, 'PLabc123456789');
  assert.equal(parsed.config.type, 'playlist');
});

test('serializeConfig: blank title omitted → dirname default', () => {
  const text = serializeConfig({ title: null, per_week: 4 });
  assert.doesNotMatch(text, /^title:/m);
  const parsed = parseConfig(text, 'some_dir');
  assert.equal(parsed.config.title, 'some_dir');
});

// ---------- detectSource ----------

test('detectSource: URL shapes', () => {
  assert.deepEqual(detectSource(`https://tube.halfab.net/channel/${UCID}/shorts`), { kind: 'channel', ucid: UCID, tab: 'shorts' });
  assert.deepEqual(detectSource(`https://tube.halfab.net/channel/${UCID}/videos`), { kind: 'channel', ucid: UCID, tab: 'videos' });
  assert.deepEqual(detectSource(`https://tube.halfab.net/channel/${UCID}/streams`), { kind: 'channel', ucid: UCID, tab: 'streams' });
  assert.deepEqual(detectSource(`https://tube.halfab.net/channel/${UCID}`), { kind: 'channel', ucid: UCID, tab: 'shorts' });
  assert.deepEqual(detectSource(`https://www.youtube.com/channel/${UCID}/shorts`), { kind: 'channel', ucid: UCID, tab: 'shorts' });
  assert.deepEqual(detectSource(UCID), { kind: 'channel', ucid: UCID, tab: 'shorts' });
  assert.deepEqual(detectSource('https://tube.halfab.net/@somehandle'), { kind: 'handle', handle: 'somehandle', tab: 'shorts' });
  assert.deepEqual(detectSource('https://www.youtube.com/@somehandle/shorts/'), { kind: 'handle', handle: 'somehandle', tab: 'shorts' });
  assert.deepEqual(detectSource('https://tube.halfab.net/playlist?list=PLabc123456789'), { kind: 'playlist', playlist: 'PLabc123456789' });
  assert.deepEqual(detectSource('PLabc123456789'), { kind: 'playlist', playlist: 'PLabc123456789' });
  assert.equal(detectSource('https://tube.halfab.net/watch?v=abc12345678').kind, 'video');
  assert.equal(detectSource('https://tube.halfab.net/shorts/abc12345678').kind, 'video');
  assert.equal(detectSource('https://tube.halfab.net/c/somecustomname').kind, 'unknown');
  assert.equal(detectSource('not a url').kind, 'unknown');
  assert.equal(detectSource('').kind, 'unknown');
  assert.equal(detectSource('ftp://tube.halfab.net/channel/' + UCID).kind, 'unknown');
});

// ---------- resolveHandle ----------

test('resolveHandle: majority UCID wins, needs 3+ occurrences', async () => {
  const client = new InvidiousClient('http://127.0.0.1:1');
  const html = `<html>${UCID.repeat(4).length ? UCID + ' x x x ' : ''}</html>`.replaceAll('x', UCID.slice(0, 0) + 'filler ');
  const ucid = await client.resolveHandle('somebody', { fetchPage: async () => `junk ${UCID} ${UCID} ${UCID} more` });
  assert.equal(ucid, UCID);
  const none = await client.resolveHandle('somebody', { fetchPage: async () => '<html>no ids here</html>' });
  assert.equal(none, null);
  const weak = await client.resolveHandle('somebody', { fetchPage: async () => `${UCID} ${UCID} once more` });
  assert.equal(weak, null);
});

// ---------- routes ----------

let app;
let baseUrl;
let fake;
let feedsDir;
let dataDir;

function startFakeInvidious() {
  return http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const json = (o) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(o));
    };
    if (p === `/api/v1/channels/${UCID}`) return json({ author: 'Fake Channel' });
    if (p === `/api/v1/channels/${UCID}/shorts`) {
      return json({
        videos: [
          { videoId: 'aaa11111111', title: 'Short One', author: 'Fake Channel', lengthSeconds: 30 },
          { videoId: 'bbb22222222', title: 'Short Two', author: 'Fake Channel', lengthSeconds: 41 },
        ],
      });
    }
    if (p.startsWith('/@')) {
      res.setHeader('content-type', 'text/html');
      return res.end(`<html>page ${UCID} ${UCID} ${UCID} ${UCID} ${UCID}</html>`);
    }
    if (p.startsWith('/api/v1/videos/')) return json({});
    res.statusCode = 404;
    json({ error: 'not found' });
  });
}

const form = (fields) =>
  Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');

test.before(async () => {
  feedsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-admin-feeds-'));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-admin-data-'));
  fs.mkdirSync(path.join(feedsDir, 'empty-dir'));
  fake = startFakeInvidious();
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.PORT = '0';
  process.env.FEEDS_DIR = feedsDir;
  process.env.DATA_DIR = dataDir;
  process.env.PUBLIC_BASE_URL = 'http://127.0.0.1/base';
  process.env.INVIDIOUS_INTERNAL_URL = `http://127.0.0.1:${fake.address().port}`;
  process.env.INVIDIOUS_PUBLIC_URL = 'https://tube.halfab.net';
  process.env.SCAN_INTERVAL_SECONDS = '3600';
  const mod = await import(pathToFileURL(path.join(fileURLToPath(new URL('.', import.meta.url)), '..', 'server.js')).href);
  app = mod.createApp({ boot: false });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${app.address().port}`;
});

test.after(async () => {
  await new Promise((r) => app?.close(r));
  await new Promise((r) => fake?.close(r));
  fs.rmSync(feedsDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const get = (p) => fetch(`${baseUrl}${p}`, { redirect: 'manual' });
const post = (p, body) =>
  fetch(`${baseUrl}${p}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form(body),
  });

test('GET /dropfeed/ lists configured and unconfigured feeds', async () => {
  fs.mkdirSync(path.join(feedsDir, 'with-config'));
  fs.writeFileSync(path.join(feedsDir, 'with-config', 'config.yml'), 'title: Existing\nper_week: 7\n');
  const res = await get('/dropfeed/');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Existing/);
  assert.match(html, /empty-dir/);
  assert.match(html, /not set up/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('GET /dropfeed/new resolves @handle and prefills the create form', async () => {
  const res = await get(`/dropfeed/new?url=${encodeURIComponent('https://tube.halfab.net/@fakehandle/shorts')}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, new RegExp(UCID));
  assert.match(html, /Fake Channel/);
  assert.match(html, /fake-channel/); // suggested folder slug
});

test('GET /dropfeed/new rejects a bare video URL', async () => {
  const res = await get(`/dropfeed/new?url=${encodeURIComponent('https://tube.halfab.net/watch?v=abc12345678')}`);
  const html = await res.text();
  assert.match(html, /not a feed source/);
});

test('GET /dropfeed/new?dir= shows the folder create form', async () => {
  const res = await get(`/dropfeed/new?dir=${encodeURIComponent('empty-dir')}`);
  const html = await res.text();
  assert.match(html, /folder · empty-dir/);
});

test('POST /dropfeed/create makes a channel feed with random times', async () => {
  const res = await post('/dropfeed/create', {
    kind: 'create-url', dirname: 'fake-shorts', type: 'channel',
    channel: `https://tube.halfab.net/channel/${UCID}/shorts`, tab: 'auto',
    title: 'Fake Shorts', per_week: '7', timeMode: 'random', time: '',
    start: '', first: 'next', shuffle: 'on', repeat: 'on',
  });
  assert.equal(res.status, 303);
  const loc = res.headers.get('location');
  assert.match(loc, /created=fake-shorts/);
  assert.match(loc, /Feed%20created/);

  const text = fs.readFileSync(path.join(feedsDir, 'fake-shorts', 'config.yml'), 'utf8');
  assert.match(text, /time: random/);
  assert.match(text, new RegExp(`channel: ${CHANNEL_URL_BASE.replace(/\./g, '\\.')}/channel/${UCID}/shorts`));
  const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'fake-shorts.json'), 'utf8'));
  assert.equal(state.deck.length, 2);
  assert.equal(state.released.length, 0);
});

test('created feed serves XML and shows the subscribe banner', async () => {
  const xml = await get('/f/fake-shorts.xml');
  assert.equal(xml.status, 200);
  assert.match(xml.headers.get('content-type') || '', /rss\+xml/);
  assert.match(await xml.text(), /<rss/);
  const page = await get(`/dropfeed/?created=fake-shorts&note=hi`);
  const html = await page.text();
  assert.match(html, /Subscribe in FreshRSS/);
  assert.match(html, /\/f\/fake-shorts\.xml/);
});

test('POST /dropfeed/<slug> edit re-anchors and can switch tab to all', async () => {
  const res = await post('/dropfeed/fake-shorts', {
    kind: 'edit', dirname: 'fake-shorts', type: 'channel',
    channel: `https://tube.halfab.net/channel/${UCID}`, tab: 'all',
    title: 'Fake Shorts Renamed', per_week: '14', timeMode: 'random', time: '',
    first: 'next', repeat: 'on',
  });
  assert.equal(res.status, 303);
  const loc = decodeURIComponent(res.headers.get('location'));
  assert.match(loc, /saved=fake-shorts/);
  assert.match(loc, /Re-anchored/);

  const text = fs.readFileSync(path.join(feedsDir, 'fake-shorts', 'config.yml'), 'utf8');
  assert.match(text, /^tab: all$/m);
  assert.match(text, /title: Fake Shorts Renamed/);
  assert.match(text, /per_week: 14/);
  const parsed = parseConfig(text, 'fake-shorts');
  assert.equal(parsed.config.tab, 'all');
  assert.equal(parsed.config.channel, UCID);
});

test('POST /dropfeed/<slug> invalid input re-renders with field errors', async () => {
  const res = await post('/dropfeed/fake-shorts', {
    kind: 'edit', dirname: 'fake-shorts', type: 'channel', channel: 'not-a-channel',
    tab: 'auto', title: 'X', per_week: '0', timeMode: 'fixed', time: '99:99',
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Integer between 1 and 168/);
  assert.match(html, /Channel URL/);
  // config untouched
  const text = fs.readFileSync(path.join(feedsDir, 'fake-shorts', 'config.yml'), 'utf8');
  assert.match(text, /per_week: 14/);
});

test('POST /dropfeed/create rejects bad folder names without writing', async () => {
  const res = await post('/dropfeed/create', {
    kind: 'create-url', dirname: '../escape', type: 'dir', title: 'Nope',
    per_week: '3', timeMode: 'fixed', time: '06:00',
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Lowercase letters, digits and dashes only/);
  assert.equal(fs.existsSync(path.resolve(feedsDir, '..', 'escape')), false);
});

test('POST /dropfeed/create rejects a taken folder name', async () => {
  const res = await post('/dropfeed/create', {
    kind: 'create-url', dirname: 'with-config', type: 'dir', title: 'Dup',
    per_week: '3', timeMode: 'fixed', time: '06:00',
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /already uses that folder/);
});

test('POST /dropfeed/<slug> on an unassigned dir creates its first config', async () => {
  const res = await post('/dropfeed/empty-dir', {
    kind: 'create-dir', dirname: 'empty-dir', type: 'dir', title: 'Dir Feed',
    per_week: '1', timeMode: 'fixed', time: '06:30', first: 'immediate',
  });
  assert.equal(res.status, 303);
  assert.match(res.headers.get('location'), /saved=empty-dir/);
  const text = fs.readFileSync(path.join(feedsDir, 'empty-dir', 'config.yml'), 'utf8');
  const parsed = parseConfig(text, 'empty-dir');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.time, '06:30');
  assert.equal(parsed.config.first, 'immediate');
  assert.ok(fs.existsSync(path.join(dataDir, 'empty-dir.json')));
});

test('path traversal in the slug is rejected', async () => {
  const res = await post('/dropfeed/..%2Fetc', { per_week: '1' });
  assert.equal(res.status, 404);
});

test('existing status-page and XML routes still work', async () => {
  const status = await get('/fake-shorts/');
  assert.equal(status.status, 200);
  const missing = await get('/nope/');
  assert.equal(missing.status, 404);
});
