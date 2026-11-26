// HTML pages: index + per-feed status. No dependencies, inline CSS.

import path from 'node:path';

export function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

// Base stylesheet shared by the status pages and the admin UI (admin.js adds
// ADMIN_CSS on top of this).
export const STYLE = `
  :root { color-scheme: dark; }
  body { font-family: system-ui, sans-serif; background: #14161a; color: #dde1e6;
         margin: 2rem auto; max-width: 60rem; padding: 0 1rem; line-height: 1.5; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 1.8rem; }
  a { color: #7ab7ff; text-decoration: none; } a:hover { text-decoration: underline; }
  table { border-collapse: collapse; width: 100%; margin: .8rem 0; font-size: .92rem; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #2a2e34; vertical-align: top; }
  th { color: #9aa3ad; font-weight: 600; }
  code { background: #1e2126; padding: .1rem .35rem; border-radius: 4px; font-size: .88em; }
  .badge { display: inline-block; padding: .05rem .45rem; border-radius: 10px; font-size: .78rem; margin-right: .3rem; }
  .ok { background: #1d3327; color: #6fd08c; } .warn { background: #3a2f1d; color: #e2b555; }
  .bad { background: #3a1d1d; color: #e27a6f; } .muted { color: #9aa3ad; }
  .url { font-family: ui-monospace, monospace; font-size: .85rem; }
  li { margin: .2rem 0; }
`;

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — drop-feed</title><style>${STYLE}</style></head>
<body><h1>drop-feed</h1>${body}</body></html>`;

const badges = (state, cfg) => {
  const out = [];
  if (!cfg) return '';
  if (cfg.paused) out.push('<span class="badge warn">paused</span>');
  if (state?.flags?.finished) out.push('<span class="badge ok">finished</span>');
  if (state?.flags?.configError) out.push('<span class="badge bad">config error</span>');
  if (state?.flags?.lastError) out.push('<span class="badge bad">source error</span>');
  if (state?.flags?.failedSlots?.length) out.push(`<span class="badge bad">${state.flags.failedSlots.length} failed slots</span>`);
  return out.join(' ');
};

export function pageIndex(rows, env) {
  const active = rows.filter((r) => r.feed.parsed?.ok);
  const broken = rows.filter((r) => r.feed.parsed && !r.feed.parsed.ok);
  const unconf = rows.filter((r) => !r.feed.parsed);

  const body = [];
  body.push('<h2>Feeds</h2>');
  if (!active.length) body.push('<p class="muted">No configured feeds.</p>');
  else {
    body.push('<table><tr><th>Feed</th><th>Type</th><th>per_week</th><th>Released</th><th>Pending</th><th>Status</th><th>Feed URL</th></tr>');
    for (const r of active) {
      const cfg = r.feed.parsed.config;
      body.push('<tr>');
      body.push(`<td><a href="/${esc(r.feed.slug)}/">${esc(cfg.title)}</a> <span class="muted">(${esc(r.feed.dirname)})</span></td>`);
      body.push(`<td>${esc(cfg.type)}</td>`);
      body.push(`<td>${cfg.per_week}</td>`);
      body.push(`<td>${r.state?.released.length ?? 0}${cfg.repeat ? ` <span class="muted">↻</span>` : ''}</td>`);
      body.push(`<td>${r.state?.deck.length ?? 0}</td>`);
      body.push(`<td>${badges(r.state, cfg) || '<span class="badge ok">ok</span>'}</td>`);
      body.push(`<td class="url">${esc(r.url)}</td>`);
      body.push('</tr>');
    }
    body.push('</table>');
  }

  if (broken.length) {
    body.push('<h2>Broken configs</h2><ul>');
    for (const r of broken) {
      body.push(`<li><code>${esc(r.feed.dirname)}</code> — ${esc(r.feed.parsed.errors.join('; '))}</li>`);
    }
    body.push('</ul>');
  }
  if (unconf.length) {
    body.push('<h2>Unconfigured dirs</h2><ul>');
    for (const r of unconf) {
      body.push(`<li><code>${esc(r.feed.dirname)}</code> <span class="muted">— add a config.yml (see repo README)</span></li>`);
    }
    body.push('</ul>');
  }
  return page('feeds', body.join('\n'));
}

function titleOf(state, id, cfg) {
  if (cfg?.type === 'playlist' || cfg?.type === 'channel') return state.meta?.[id]?.title || id;
  return path.basename(id);
}

export function pageStatus({ feed, state, cfg, next, env }) {
  const b = [];
  const t = cfg?.title || state.slug;

  b.push(`<h2>${esc(t)} ${badges(state, cfg)}</h2>`);
  b.push(`<p class="url">${esc(`${env.PUBLIC_BASE_URL}/f/${state.slug}.xml`)}</p>`);

  if (state.flags.configError) {
    b.push(`<p class="bad">Config error: ${esc(state.flags.configError)} — history is still served, but nothing new will release until it is fixed.</p>`);
  }
  if (state.flags.lastError) b.push(`<p class="bad">Source error: ${esc(state.flags.lastError)}</p>`);

  if (cfg) {
    b.push('<h2>Settings</h2><table>');
    b.push(`<tr><th>type</th><td>${esc(cfg.type)}${cfg.playlist ? ` — <span class="url">${esc(String(state.playlistTitle || cfg.playlist))}</span>` : ''}${cfg.channel ? ` — <span class="url">${esc(String(state.sourceTitle || cfg.channel))}</span>` : ''}</td></tr>`);
    b.push(`<tr><th>per_week</th><td>${cfg.per_week}</td></tr>`);
    b.push(`<tr><th>time</th><td>${esc(cfg.time || '06:00 (default)')}</td></tr>`);
    b.push(`<tr><th>first</th><td>${esc(cfg.first)}</td></tr>`);
    b.push(`<tr><th>start</th><td>${esc(cfg.start || 'when first seen')}</td></tr>`);
    b.push(`<tr><th>shuffle / repeat / paused</th><td>${cfg.shuffle ? 'yes' : 'no'} / ${cfg.repeat ? 'yes' : 'no'} / ${cfg.paused ? 'yes' : 'no'}</td></tr>`);
    b.push(`<tr><th>cycle</th><td>${state.cycle}</td></tr>`);
    b.push(`<tr><th>created</th><td>${esc(fmtDate(state.createdAt))}</td></tr>`);
    b.push('</table>');
  }

  b.push('<h2>Upcoming</h2>');
  if (cfg?.paused) b.push('<p class="muted">Paused.</p>');
  else if (state.flags.finished) b.push('<p class="muted">Finished — everything released. New items start at the next slot.</p>');
  else if (state.deck.length === 0 && !cfg?.repeat) b.push('<p class="muted">Deck is empty.</p>');
  else {
    b.push('<table><tr><th>Slot</th><th>Item</th></tr>');
    const heads = state.deck.slice(0, next.length || 3);
    for (let i = 0; i < next.length; i++) {
      const item = heads[i];
      b.push(
        `<tr><td>${esc(fmtDate(new Date(next[i]).toISOString()))}</td><td>${item ? esc(titleOf(state, item, cfg)) : '<span class="muted">—</span>'}</td></tr>`
      );
    }
    b.push('</table>');
  }

  if (state.flags.failedSlots.length) {
    b.push('<h2>Failed slots</h2><ul>');
    for (const f of state.flags.failedSlots.slice(-10)) {
      b.push(`<li>${esc(fmtDate(f.slot))} — ${esc(f.reason)}</li>`);
    }
    b.push('</ul>');
  }

  b.push(`<h2>Deck</h2><p>${state.deck.length} pending${cfg?.shuffle ? ' (shuffled)' : ''}${cfg?.repeat ? ', repeating' : ''}</p>`);
  if (state.deck.length) {
    b.push('<ul>');
    for (const id of state.deck.slice(0, 10)) b.push(`<li>${esc(titleOf(state, id, cfg))}</li>`);
    if (state.deck.length > 10) b.push(`<li class="muted">… ${state.deck.length - 10} more</li>`);
    b.push('</ul>');
  }

  b.push(`<h2>Released (${state.released.length})</h2>`);
  if (state.released.length) {
    b.push('<table><tr><th>Slot</th><th>Item</th><th>Cycle</th><th>Link</th></tr>');
    const recent = [...state.released].sort((x, y) => y.slot.localeCompare(x.slot)).slice(0, 10);
    for (const r of recent) {
      const missing =
        r.enclosure && !state.flags.configError
          ? '' // existence is checked live in /m/; keep the table simple
          : '';
      b.push(
        `<tr><td>${esc(fmtDate(r.slot))}</td><td>${esc(r.title)}</td><td>${r.cycle}</td><td><a href="${esc(r.link)}">open</a></td></tr>`
      );
    }
    b.push('</table>');
  } else {
    b.push('<p class="muted">Nothing released yet.</p>');
  }

  return page(t, b.join('\n'));
}

export function pagePlain(res, code, msg) {
  res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(msg);
}
