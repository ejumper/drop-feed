// Media file serving: extension/MIME mapping, path confinement, HTTP Range.

import fs from 'node:fs';
import path from 'node:path';

export const VIDEO_EXTS = [
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'ts', 'mpg', 'mpeg', 'wmv', 'flv', 'ogv',
];

const MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  ts: 'video/mp2t',
  mpg: 'video/mpeg',
  mpeg: 'video/mpeg',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  ogv: 'video/ogg',
};

export function isVideoFile(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return VIDEO_EXTS.includes(ext);
}

export function mimeFor(name) {
  const ext = path.extname(name).slice(1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// Resolve relPath inside feedDir, refusing traversal and non-video files.
// Returns absolute path or null.
export function safeMediaPath(feedDir, relPath) {
  if (!relPath || relPath.includes('\0') || relPath.includes('\\')) return null;
  const abs = path.resolve(feedDir, relPath);
  const root = path.resolve(feedDir) + path.sep;
  if (!abs.startsWith(root)) return null;
  if (!isVideoFile(abs)) return null;
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return { abs, size: stat.size };
}

// Serve a file with single-range support (206) for seeking.
export function serveMedia(req, res, abs, size, mime) {
  const rangeHeader = req.headers.range;
  const baseHeaders = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  let start = 0;
  let end = size - 1;
  let partial = false;

  if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    if (m[1] === '') {
      // suffix: last N bytes
      const n = parseInt(m[2], 10);
      if (n === 0 || n > size) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
      start = size - n;
      end = size - 1;
    } else {
      start = parseInt(m[1], 10);
      end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
      if (start >= size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${size}` });
        res.end();
        return;
      }
    }
    partial = true;
  }

  const headers = {
    ...baseHeaders,
    'Content-Length': end - start + 1,
  };
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;

  if (req.method === 'HEAD') {
    res.writeHead(partial ? 206 : 200, headers);
    res.end();
    return;
  }

  res.writeHead(partial ? 206 : 200, headers);
  const stream = fs.createReadStream(abs, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
