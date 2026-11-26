// Admin UI: structured config forms over the feeds' config.yml files.
// Server-rendered HTML like pages.js (no dependencies); ~20 lines of vanilla
// JS for copy buttons and the type/time-mode field toggles. Dark theme on top
// of the status-page stylesheet (STYLE from pages.js).
//
// Server contract (see server.js handleAdmin):
//   renderAdminPage({ env, rows, broken, unassigned, flash, override })
//   renderCreatePicker({ env, error, urlValue, unassigned })
//   renderCreateForm({ env, values, errors, sourceLine, sourceDetail, kind, dirnameFixed })
// Values model (submitted values re-rendered verbatim on validation errors):
//   { dirname, title, type, channel, tab, playlist, perWeek,
//     timeMode, time, start, first, shuffle, repeat, paused }

import { STYLE, esc } from './pages.js';
import { CHANNEL_URL_BASE } from './playlist.js';

export function channelUrl(ucid, tab) {
  return tab === 'all'
    ? `${CHANNEL_URL_BASE}/channel/${ucid}`
    : `${CHANNEL_URL_BASE}/channel/${ucid}/${tab || 'shorts'}`;
}

const ADMIN_CSS = `
  .banner { background: #1d2a20; border: 1px solid #2b4433; color: #9fd8b4;
            padding: .6rem .9rem; border-radius: 8px; margin: 1rem 0; font-size: .92rem; }
  .card { background: #1b1e24; border: 1px solid #2a2e34; border-radius: 10px;
          margin: .7rem 0; overflow: hidden; }
  .card > summary { cursor: pointer; list-style: none; display: flex; align-items: center;
                    gap: .6rem; padding: .7rem .9rem; flex-wrap: wrap; }
  .card > summary::-webkit-details-marker { display: none; }
  .card > summary:hover { background: #20242b; }
  .card[open] > summary { border-bottom: 1px solid #2a2e34; }
  .ftitle { font-weight: 600; font-size: .98rem; }
  .fmeta { color: #9aa3ad; font-size: .84rem; margin-left: auto; text-align: right; }
  .chev { color: #9aa3ad; transition: transform .15s; }
  .card[open] .chev { transform: rotate(90deg); }
  .cardbody { padding: .9rem; }
  .btn { display: inline-block; background: #1d3327; color: #6fd08c; border: 1px solid #2b4433;
         border-radius: 8px; padding: .45rem .9rem; font-size: .92rem; cursor: pointer;
         text-decoration: none; }
  a.btn:hover { text-decoration: none; filter: brightness(1.15); }
  .btn.primary { background: #1c3450; color: #7ab7ff; border-color: #2c4a6e; }
  .btn.ghost { background: transparent; color: #9aa3ad; border-color: #2a2e34; }
  .btn.mini { padding: .15rem .55rem; font-size: .8rem; }
  form.cfg { display: grid; grid-template-columns: 10rem 1fr; gap: .65rem .9rem;
             align-items: start; max-width: 42rem; }
  form.cfg label { color: #9aa3ad; font-size: .9rem; padding-top: .45rem; }
  form.cfg input[type="text"], form.cfg input[type="number"], form.cfg input[type="time"],
  form.cfg input[type="date"], form.cfg input[type="url"], form.cfg select, form.cfg textarea {
    width: 100%; box-sizing: border-box; background: #1e2126; color: #dde1e6;
    border: 1px solid #2a2e34; border-radius: 8px; padding: .45rem .6rem;
    font-size: 16px; font-family: inherit; }
  form.cfg input:focus, form.cfg select:focus { outline: 2px solid #2c4a6e; border-color: #2c4a6e; }
  form.cfg input[readonly] { color: #9aa3ad; background: #191c21; }
  .frow { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
  .frow input[type="checkbox"] { width: 1.05rem; height: 1.05rem; accent-color: #7ab7ff; }
  .frow .cb { display: inline-flex; gap: .35rem; align-items: center; font-size: .92rem; color: #dde1e6; }
  .fhint { color: #9aa3ad; font-size: .8rem; margin: .25rem 0 0; }
  .ferr { color: #e27a6f; font-size: .82rem; margin: .25rem 0 0; }
  .formerr { background: #2c1a1a; border: 1px solid #442a2a; color: #e27a6f;
             border-radius: 8px; padding: .5rem .8rem; font-size: .88rem;
             grid-column: 1 / span 2; }
  .actions { grid-column: 1 / span 2; display: flex; gap: .6rem; margin-top: .3rem; }
  .sourceline { background: #191c21; border: 1px solid #2a2e34; border-radius: 8px;
                padding: .45rem .6rem; font-size: .88rem; color: #b9c2cc; }
  .feedurl { font-family: ui-monospace, monospace; font-size: .85rem; color: #9fb6d4;
             background: #191c21; border: 1px solid #2a2e34; border-radius: 8px;
             padding: .4rem .6rem; display: inline-block; max-width: 100%;
             overflow-wrap: anywhere; }
  .cardlinks { display: flex; gap: .8rem; align-items: center; flex-wrap: wrap;
               border-top: 1px dashed #2a2e34; margin-top: .9rem; padding-top: .7rem;
               font-size: .88rem; }
  .chip { display: inline-block; background: #1e2126; border: 1px solid #2a2e34;
          border-radius: 8px; padding: .4rem .7rem; margin: .2rem .3rem .2rem 0;
          font-size: .9rem; }
  .paste { display: flex; gap: .6rem; margin: .8rem 0 1.2rem; flex-wrap: wrap; }
  .paste input { flex: 1 1 22rem; background: #1e2126; color: #dde1e6;
                 border: 1px solid #2a2e34; border-radius: 8px; padding: .55rem .7rem;
                 font-size: 16px; }
  form.cfg[data-type="dir"] .only-playlist, form.cfg[data-type="dir"] .only-channel,
  form.cfg[data-type="playlist"] .only-channel,
  form.cfg[data-type="channel"] .only-playlist { display: none; }
  @media (max-width: 560px) {
    form.cfg { grid-template-columns: 1fr; }
    form.cfg label { padding-top: 0; }
    .fmeta { margin-left: 0; flex-basis: 100%; text-align: left; }
    .formerr, .actions { grid-column: 1; }
  }
`;

const ADMIN_JS = `
  document.querySelectorAll('form.cfg').forEach((form) => {
    const typeSel = form.querySelector('select[name="type"]');
    if (typeSel) {
      const syncType = () => { form.dataset.type = typeSel.value; };
      typeSel.addEventListener('change', syncType);
      syncType();
    }
    const mode = form.querySelector('select[name="timeMode"]');
    const time = form.querySelector('input[name="time"]');
    if (mode && time) {
      const syncTime = () => { time.disabled = mode.value !== 'fixed'; };
      mode.addEventListener('change', syncTime);
      syncTime();
    }
  });
  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(btn.dataset.copy);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      } catch (e) { /* clipboard unavailable */ }
    });
  });
`;

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — drop-feed</title><style>${STYLE}${ADMIN_CSS}</style></head>
<body><h1>drop-feed</h1>${body}<script>${ADMIN_JS}</script></body></html>`;

// ---------- value models ----------

// Form values for an existing feed row (or blank defaults for unconfigured).
export function defaultValues(feed) {
  const cfg = feed?.parsed?.config;
  if (!cfg) {
    return {
      dirname: feed?.dirname || '', title: '', type: 'dir', channel: '', tab: 'auto',
      playlist: '', perWeek: '', timeMode: 'fixed', time: '06:00', start: '',
      first: 'next', shuffle: false, repeat: false, paused: false,
    };
  }
  return {
    dirname: feed.dirname,
    title: cfg.title || '',
    type: cfg.type,
    channel: cfg.channel ? channelUrl(cfg.channel, cfg.tab) : '',
    tab: cfg.tab === 'all' ? 'all' : 'auto',
    playlist: cfg.playlist || '',
    perWeek: String(cfg.per_week ?? ''),
    timeMode: cfg.time === 'random' ? 'random' : 'fixed',
    time: cfg.time && cfg.time !== 'random' ? cfg.time : '06:00',
    start: '',
    first: cfg.first || 'next',
    shuffle: !!cfg.shuffle,
    repeat: !!cfg.repeat,
    paused: !!cfg.paused,
  };
}

function sourceOf(feed, state) {
  const cfg = feed.parsed?.config;
  if (!cfg) return { line: `folder · ${feed.dirname}` };
  if (cfg.type === 'channel') {
    return { line: state?.sourceTitle || channelUrl(cfg.channel, cfg.tab), detail: channelUrl(cfg.channel, cfg.tab) };
  }
  if (cfg.type === 'playlist') {
    return { line: state?.sourceTitle || state?.playlistTitle || cfg.playlist, detail: cfg.playlist };
  }
  return { line: `folder · ${feed.dirname}` };
}

function metaOf(feed, state) {
  const cfg = feed.parsed?.config;
  if (!cfg) return [];
  const meta = [`${cfg.per_week}/wk`, cfg.time === 'random' ? 'random time' : cfg.time || '06:00'];
  if (cfg.shuffle) meta.push('shuffle');
  if (cfg.repeat) meta.push('repeat');
  if (cfg.paused) meta.push('paused');
  return meta;
}

// ---------- form rendering ----------

const RE_HINT = '<p class="fhint">Re-slots pending items from now — released history is kept.</p>';

function renderForm({ action, kind, dirname, values, errors, sourceLine, sourceDetail, fixedType, dirnameFixed, isNewFeed, hasReleases }) {
  const e = (name) => (errors?.[name] ? `<p class="ferr">${esc(errors[name])}</p>` : '');
  const hint = !isNewFeed && hasReleases ? RE_HINT : '';
  const cb = (name, label) => `
      <input type="hidden" name="${name}" value="off">
      <label class="cb"><input type="checkbox" name="${name}" value="on" ${values[name] ? 'checked' : ''}> ${esc(label)}</label>`;
  const sel = (name, opts, cur) => `
      <select name="${name}">${opts.map(([val, label]) => `<option value="${esc(val)}" ${cur === val ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;

  const typeField = fixedType
    ? `<input type="hidden" name="type" value="${esc(values.type)}">
       <input type="text" value="${esc(values.type)}" readonly>`
    : sel('type', [['dir', 'local files (folder)'], ['playlist', 'Invidious playlist'], ['channel', 'Invidious channel']], values.type);

  const sourceHtml = `
    <label>Source</label>
    <div>
      <div class="sourceline">${esc(sourceLine)}${sourceDetail && sourceDetail !== sourceLine ? `<br><span class="url">${esc(sourceDetail)}</span>` : ''}</div>
    </div>`;
  const dirnameField = dirnameFixed
    ? `<input type="hidden" name="dirname" value="${esc(values.dirname)}">
       <input type="text" value="${esc(values.dirname)}" readonly>`
    : `<input type="text" name="dirname" value="${esc(values.dirname)}" placeholder="folder-name" required>
       ${e('dirname')}`;

  return `<form method="post" action="${esc(action)}" class="cfg">
    <input type="hidden" name="kind" value="${esc(kind)}">
    <input type="hidden" name="dirname" value="${esc(dirname)}">
    ${errors?.form ? `<div class="formerr">${esc(errors.form)}</div>` : ''}
    ${sourceHtml}
    ${kind === 'create-url' ? `<label>Folder</label><div>${dirnameField}</div>` : ''}
    <label>Type</label><div>${typeField}${e('type')}</div>
    <div class="only-channel"><label>Channel URL</label>
      <div><input type="text" name="channel" value="${esc(values.channel)}" placeholder="https://tube.halfab.net/channel/UC…/shorts">
      ${e('channel')}</div>
    </div>
    <div class="only-channel"><label>Tab</label>
      <div>${sel('tab', [['auto', 'from URL'], ['shorts', 'shorts'], ['videos', 'videos'], ['streams', 'streams'], ['all', 'all (merged, newest first)']], values.tab)}${e('tab')}</div>
    </div>
    <div class="only-playlist"><label>Playlist</label>
      <div><input type="text" name="playlist" value="${esc(values.playlist)}" placeholder="https://tube.halfab.net/playlist?list=PL…">
      ${e('playlist')}</div>
    </div>
    <label>Title</label>
    <div><input type="text" name="title" value="${esc(values.title)}" placeholder="${esc(dirname)}">${e('title')}</div>
    <label>Releases / week</label>
    <div><input type="number" name="per_week" min="1" max="168" step="1" value="${esc(values.perWeek)}" required>
    ${hint}${e('per_week')}</div>
    <label>Time of day</label>
    <div class="frow">
      ${sel('timeMode', [['fixed', 'fixed'], ['random', 'random']], values.timeMode)}
      <input type="time" name="time" value="${esc(values.time)}">
    </div>
    ${isNewFeed ? `<label>Start date</label>
    <div><input type="date" name="start" value="${esc(values.start || '')}">
    <p class="fhint">Blank = now. A past date backfills missed releases up to today.</p>${e('start')}</div>` : ''}
    <label>First release</label>
    <div>${sel('first', [['next', 'at the next slot'], ['immediate', 'immediately on create/re-anchor']], values.first)}${hint}${e('first')}</div>
    <label>Options</label>
    <div class="frow">${cb('shuffle', 'shuffle')}${cb('repeat', 'repeat')}${cb('paused', 'paused')}</div>
    <div class="actions">
      <button type="submit" class="btn primary">Save</button>
      <a class="btn ghost" href="/dropfeed/">Cancel</a>
    </div>
  </form>`;
}

function cardFor(row, { open, values, errors, flashSlug }) {
  const { feed, state } = row;
  const cfg = feed.parsed?.config;
  const isNewFeed = !cfg;
  const hasReleases = !!state?.released?.length;
  const v = values || defaultValues(feed);
  const kind = isNewFeed ? 'create-dir' : 'edit';
  const source = isNewFeed
    ? { line: `folder · ${feed.dirname}`, detail: '' }
    : sourceOf(feed, state);

  const badges = [];
  if (!feed.parsed) badges.push('<span class="badge warn">not set up</span>');
  else if (!feed.parsed.ok) badges.push('<span class="badge bad">config error</span>');
  else if (state && cfg) {
    if (cfg.paused) badges.push('<span class="badge warn">paused</span>');
    if (state.flags?.finished) badges.push('<span class="badge ok">finished</span>');
    if (state.flags?.configError) badges.push('<span class="badge bad">config error</span>');
    if (state.flags?.lastError) badges.push('<span class="badge bad">source error</span>');
    if (state.flags?.failedSlots?.length) badges.push(`<span class="badge bad">${state.flags.failedSlots.length} failed slots</span>`);
  }

  const meta = isNewFeed
    ? [esc(feed.dirname)]
    : metaOf(feed, state).map(esc).join(' · ');
  const title = esc(cfg?.title || feed.dirname);

  const errLine = feed.parsed && !feed.parsed.ok
    ? `<div class="formerr" style="grid-column:auto">${esc(feed.parsed.errors.join('; '))} — fix the fields below and save.</div>`
    : '';

  const feedUrl = feed.parsed?.ok ? `/f/${feed.slug}.xml` : '';
  const links = [];
  if (feed.parsed?.ok) {
    links.push(`<a href="/${esc(feed.slug)}/">status page →</a>`);
    links.push(`<span class="feedurl">${esc(feedUrl)}</span>
    <button type="button" class="btn ghost mini" data-copy="${esc(feedUrl)}">Copy</button>`);
  } else {
    links.push('<span class="muted">feed URL appears once the config is saved</span>');
  }

  const body = `${errLine}
  ${renderForm({
    action: `/dropfeed/${feed.slug}`,
    kind,
    dirname: feed.dirname,
    values: v,
    errors,
    sourceLine: source.line,
    sourceDetail: source.detail,
    fixedType: false,
    dirnameFixed: false,
    isNewFeed,
    hasReleases,
  })}
  <div class="cardlinks">${links.join('')}</div>`;

  const result = flashSlug && flashSlug === feed.slug
    ? `<div class="banner">Subscribe in FreshRSS with:<br><span class="feedurl">${esc(feedUrl)}</span>
       <button type="button" class="btn ghost mini" data-copy="${esc(feedUrl)}">Copy</button></div>`
    : '';

  return `<details class="card" ${open ? 'open' : ''}>
    <summary><span class="chev">▸</span><span class="ftitle">${title}</span>${badges.join(' ')}<span class="fmeta">${meta}</span></summary>
    <div class="cardbody">${result}${body}</div>
  </details>`;
}

// ---------- pages ----------

export function renderAdminPage({ env, rows, broken, unassigned, flash, override }) {
  const openSlug = override?.slug || flash?.saved || flash?.created || null;
  const banner = flash?.note
    ? `<div class="banner">${esc(flash.note)}</div>`
    : '';

  const configured = rows.map((row) =>
    cardFor(row, {
      open: openSlug === row.feed.slug,
      values: override && override.slug === row.feed.slug ? override.values : null,
      errors: override && override.slug === row.feed.slug ? override.errors : null,
      flashSlug: flash?.created || null,
    })
  );

  const brokenCards = broken.map((row) =>
    cardFor(row, {
      open: openSlug === row.feed.slug,
      values: override && override.slug === row.feed.slug ? override.values : defaultValues(row.feed),
      errors: override && override.slug === row.feed.slug ? override.errors : null,
      flashSlug: null,
    })
  );

  const unassignedCards = unassigned.map((feed) =>
    cardFor(
      { feed, state: null },
      { open: openSlug === feed.slug, values: null, errors: null, flashSlug: null }
    )
  );

  const count = rows.length + broken.length + unassigned.length;
  const body = `
  <p class="muted" style="margin-top:-.6rem"><a href="/">status index</a> · every change here edits <code>config.yml</code> in the feed folder — same rules as editing it by hand</p>
  ${banner}
  <p><a class="btn primary" href="/dropfeed/new">+ Create feed</a></p>
  <h2>Feeds (${count})</h2>
  ${count === 0 ? '<p class="muted">No feed folders yet — create one below.</p>' : ''}
  ${configured.join('\n')}
  ${brokenCards.join('\n')}
  ${unassignedCards.join('\n')}`;
  return page('admin', body);
}

export function renderCreatePicker({ env, error, urlValue, unassigned }) {
  const dirChips = unassigned.length
    ? unassigned.map((f) => `<a class="chip" href="/dropfeed/new?dir=${encodeURIComponent(f.dirname)}">${esc(f.dirname)}</a>`).join('')
    : '<span class="muted">none — every folder already has a config</span>';
  const body = `
  <p class="muted" style="margin-top:-.6rem"><a href="/dropfeed/">← back to feeds</a></p>
  ${error ? `<div class="banner" style="background:#2c1a1a;border-color:#442a2a;color:#e27a6f">${esc(error)}</div>` : ''}
  <h2>Create a feed</h2>
  <form method="get" action="/dropfeed/new" class="paste">
    <input type="text" name="url" value="${esc(urlValue || '')}" placeholder="paste a channel, @handle or playlist URL"
           autofocus required>
    <button type="submit" class="btn primary">Detect</button>
  </form>
  <p class="muted">Channel URLs (<code>/channel/UC…[/shorts|videos|streams]</code>), <code>@handles</code>, bare UCIDs and playlist URLs/IDs all work. A single video is not a feed source.</p>
  <h2>…or use an unassigned folder</h2>
  <p>${dirChips}</p>`;
  return page('create feed', body);
}

export function renderCreateForm({ env, values, errors, sourceLine, sourceDetail, kind, dirnameFixed }) {
  const isNewFeed = true;
  const body = `
  <p class="muted" style="margin-top:-.6rem"><a href="/dropfeed/new">← change source</a> · <a href="/dropfeed/">feeds</a></p>
  <h2>New feed</h2>
  <div class="card"><div class="cardbody">
  ${renderForm({
    action: '/dropfeed/create',
    kind,
    dirname: values.dirname,
    values,
    errors,
    sourceLine,
    sourceDetail,
    fixedType: true,
    dirnameFixed,
    isNewFeed,
    hasReleases: false,
  })}
  </div></div>`;
  return page('new feed', body);
}
