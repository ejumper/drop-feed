// RSS 2.0 XML builder for a feed's released items.

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function rfc822(iso) {
  return new Date(iso).toUTCString();
}

// st.released entries: { guid, id, cycle, slot (ISO), title, link, enclosure|null, desc }
export function buildFeedXml({ title, slug, description }, st, base, maxItems = 500) {
  const items = [...st.released]
    .sort((a, b) => b.slot.localeCompare(a.slot))
    .slice(0, maxItems);

  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push('<rss version="2.0"><channel>');
  parts.push(`<title>${esc(title)}</title>`);
  parts.push(`<link>${esc(`${base}/${slug}/`)}</link>`);
  parts.push(`<description>${esc(description || `Drip-fed by drop-feed — ${title}`)}</description>`);
  parts.push('<generator>drop-feed</generator>');
  parts.push(`<lastBuildDate>${rfc822(new Date().toISOString())}</lastBuildDate>`);
  for (const it of items) {
    parts.push('<item>');
    parts.push(`<title>${esc(it.title)}</title>`);
    parts.push(`<link>${esc(it.link)}</link>`);
    parts.push(`<guid isPermaLink="false">${esc(it.guid)}</guid>`);
    parts.push(`<pubDate>${rfc822(it.slot)}</pubDate>`);
    parts.push(`<description>${esc(it.desc || '')}</description>`);
    if (it.enclosure && it.enclosure.url) {
      parts.push(
        `<enclosure url="${esc(it.enclosure.url)}" length="${Number(it.enclosure.size) || 0}" type="${esc(it.enclosure.mime || 'video/mp4')}"/>`
      );
    }
    parts.push('</item>');
  }
  parts.push('</channel></rss>');
  return parts.join('\n');
}
