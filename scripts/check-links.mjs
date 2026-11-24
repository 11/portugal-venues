#!/usr/bin/env node
// Finds dead, hotlink-blocked, non-image, or low-resolution media links.
//
//   node scripts/check-links.mjs                 # report only
//   node scripts/check-links.mjs --prune         # also delete failing items from the .md files
//   node scripts/check-links.mjs --min-width 1600 --venue pestana-palace
//   node scripts/check-links.mjs --urls a.jpg b.jpg   # check loose image URLs (for research)
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VENUES_DIR, loadVenues, readMedia, parseVideo, fetchWithTimeout, UA } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const PRUNE = args.includes('--prune');
const MIN_WIDTH = Number(opt('--min-width', 1600));
const ONLY = opt('--venue', null);
// The deployed site sends this Referer, so a host that blocks hotlinking will block it.
const REFERER = 'https://portugal-venues.github.io/';

// ---------- image dimension sniffing ----------
function dims(buf) {
  const u8 = buf;
  const be16 = (o) => (u8[o] << 8) | u8[o + 1];
  const be32 = (o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
  const le16 = (o) => u8[o] | (u8[o + 1] << 8);
  const le24 = (o) => u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16);
  const ascii = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));

  // PNG
  if (u8[0] === 0x89 && ascii(1, 3) === 'PNG') return { format: 'png', width: be32(16), height: be32(20) };
  // GIF
  if (ascii(0, 3) === 'GIF') return { format: 'gif', width: le16(6), height: le16(8) };
  // JPEG
  if (u8[0] === 0xff && u8[1] === 0xd8) {
    let o = 2;
    while (o + 9 < u8.length) {
      if (u8[o] !== 0xff) { o++; continue; }
      const marker = u8[o + 1];
      if (marker === 0xff) { o++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { format: 'jpeg', height: be16(o + 5), width: be16(o + 7) };
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { o += 2; continue; }
      o += 2 + be16(o + 2);
    }
    return { format: 'jpeg', width: null, height: null };
  }
  // WebP
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const chunk = ascii(12, 4);
    if (chunk === 'VP8 ') return { format: 'webp', width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = u8.subarray(21, 25);
      return {
        format: 'webp',
        width: 1 + (((b[1] & 0x3f) << 8) | b[0]),
        height: 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)),
      };
    }
    if (chunk === 'VP8X') return { format: 'webp', width: 1 + le24(24), height: 1 + le24(27) };
  }
  // AVIF / HEIF: find the 'ispe' box
  if (ascii(4, 4) === 'ftyp') {
    const i = buf.indexOf(Buffer.from('ispe'));
    if (i > 0) return { format: 'avif', width: be32(i + 8), height: be32(i + 12) };
  }
  return null;
}

async function checkImage(url) {
  let r;
  try {
    r = await fetchWithTimeout(url, { headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' } });
  } catch (e) {
    return { ok: false, why: `network error (${e.name === 'AbortError' ? 'timeout' : e.message})` };
  }
  if (!r.ok) return { ok: false, why: `HTTP ${r.status}${r.status === 403 ? ' (hotlink blocked?)' : ''}` };
  const type = r.headers.get('content-type') || '';
  const buf = Buffer.from(await r.arrayBuffer());
  const d = dims(buf);
  if (!d) return { ok: false, why: `not an image (content-type: ${type || 'none'})` };
  if (!d.width) return { ok: false, why: `${d.format}: couldn't read size` };
  const kb = Math.round(buf.length / 1024);
  const info = `${d.width}×${d.height} ${d.format} ${kb} KB`;
  if (d.width < MIN_WIDTH && d.height < MIN_WIDTH) return { ok: false, why: `too small: ${info}` };
  return { ok: true, why: info };
}

async function checkVideo(url) {
  const v = parseVideo(url);
  const endpoint =
    v.provider === 'youtube'
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${v.id}`)}`
      : v.provider === 'vimeo'
        ? `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`
        : null;
  try {
    if (!endpoint) {
      const r = await fetchWithTimeout(url, { headers: { 'User-Agent': UA } });
      return r.ok ? { ok: true, why: `external link, HTTP ${r.status}` } : { ok: false, why: `HTTP ${r.status}` };
    }
    const r = await fetchWithTimeout(endpoint, { headers: { 'User-Agent': UA } });
    if (r.status === 401 || r.status === 403) return { ok: false, why: `${v.provider}: embedding disabled or private` };
    if (!r.ok) return { ok: false, why: `${v.provider}: HTTP ${r.status} (removed?)` };
    const j = await r.json();
    return { ok: true, why: `${v.provider}: "${(j.title || '').slice(0, 60)}"` };
  } catch (e) {
    return { ok: false, why: `network error (${e.message})` };
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

async function pruneFile(slug, kind, badUrls) {
  if (!badUrls.size) return;
  const file = path.join(VENUES_DIR, slug, `${kind}.md`);
  const lines = (await readFile(file, 'utf8')).split('\n');
  const keep = [];
  let skipping = false;
  for (const line of lines) {
    const m = line.match(/^- url:\s*(\S+)/);
    if (m) skipping = badUrls.has(m[1]);
    else if (!/^\s{2,}\S/.test(line)) skipping = false;
    if (!skipping) keep.push(line);
  }
  await writeFile(file, keep.join('\n').replace(/\n{3,}/g, '\n\n'));
}

async function main() {
  if (args.includes('--urls')) {
    const urls = args.slice(args.indexOf('--urls') + 1).filter((a) => /^https?:/.test(a));
    const res = await pool(urls, 6, checkImage);
    urls.forEach((u, i) => console.log(`${res[i].ok ? '✓' : '✗'} ${res[i].why.padEnd(34)} ${u}`));
    return;
  }

  const venues = (await loadVenues()).filter((v) => !ONLY || v.slug === ONLY);
  let failures = 0;
  const totals = [];
  for (const v of venues) {
    const images = await readMedia(v.slug, 'images');
    const videos = await readMedia(v.slug, 'videos');
    const ir = await pool(images, 6, (m) => checkImage(m.url));
    const vr = await pool(videos, 4, (m) => checkVideo(m.url));
    console.log(`\n${v.name} (${v.slug})`);
    const bad = { images: new Set(), videos: new Set() };
    images.forEach((m, i) => {
      console.log(`  ${ir[i].ok ? '✓' : '✗'} img ${ir[i].why.padEnd(34)} ${m.url}`);
      if (!ir[i].ok) bad.images.add(m.url);
    });
    videos.forEach((m, i) => {
      console.log(`  ${vr[i].ok ? '✓' : '✗'} vid ${vr[i].why.padEnd(34)} ${m.url}`);
      if (!vr[i].ok) bad.videos.add(m.url);
    });
    failures += bad.images.size + bad.videos.size;
    totals.push({ slug: v.slug, images: images.length - bad.images.size, videos: videos.length - bad.videos.size });
    if (PRUNE) {
      await pruneFile(v.slug, 'images', bad.images);
      await pruneFile(v.slug, 'videos', bad.videos);
    }
  }

  console.log('\nGood links per venue (target: 10–15 images, 2–5 videos)');
  for (const t of totals) {
    const flag = t.images < 10 || t.videos < 2 ? '  ← under target' : '';
    console.log(`  ${t.slug.padEnd(40)} ${String(t.images).padStart(3)} img ${String(t.videos).padStart(3)} vid${flag}`);
  }
  console.log(`\n${failures} failing link(s)${PRUNE && failures ? ', removed from the markdown' : ''}.`);
  if (failures && !PRUNE) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
