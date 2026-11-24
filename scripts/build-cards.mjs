#!/usr/bin/env node
// Reads data/venues.json + venues/<slug>/{images,videos}.md and writes site/cards.json.
//
//   node scripts/build-cards.mjs            # fetches video thumbnails (needs network)
//   node scripts/build-cards.mjs --offline  # skips network; uses default YouTube thumbnails
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadVenues, readMedia, venueFolders, parseVideo, fetchWithTimeout, UA } from './lib.mjs';

const OFFLINE = process.argv.includes('--offline');

// Extra words that would give a venue away in a caption, beyond its full name.
const ALIASES = {
  'pestana-palace': ['Pestana Palace', 'Pestana', 'Valle Flôr', 'Valle Flor'],
  'queluz-national-palace': ['Palácio Nacional de Queluz', 'Palacio Nacional de Queluz', 'Queluz Palace', 'Palace of Queluz', 'Queluz', 'Robillion'],
  'palacio-de-tancos': ['Palácio Tancos', 'Palacio Tancos', 'Tancos'],
  'palacio-da-fonte-nova': ['Fonte Nova', 'Penha Longa', 'Ritz-Carlton', 'Ritz Carlton'],
  'palacio-do-correio-mor': ['Correio-Mor', 'Correio Mor'],
  'quinta-da-bella-vista': ['Bella Vista', 'Conan Doyle'],
  'quinta-das-torres': ['Quinta das Torres', 'Torres'],
  'quinta-da-nossa-senhora-da-conceicao': ['Quinta da Conceição', 'Quinta da Conceicao', 'Nossa Senhora da Conceição', 'Conceição', 'Conceicao'],
  'quinta-dos-gafanhotos': ['Gafanhotos'],
  'vandelli-botanical-garden': ['Jardim Botânico Vandelli', 'Vandelli Botanical Garden', 'Vandelli'],
  'forte-da-cruz': ['Forte da Cruz', 'Fort of Cruz'],
  'herdade-do-peru': ['Herdade do Perú', 'Herdade do Peru'],
};
// Also hide who organised it when the planner/caterer is tied to one venue.
const GLOBAL_HIDE = ['Casa do Marquês', 'Casa do Marques'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function buildStripper(venues) {
  const terms = new Set(GLOBAL_HIDE);
  for (const v of venues) {
    terms.add(v.name);
    terms.add(v.name.normalize('NFD').replace(/[̀-ͯ]/g, ''));
    for (const a of ALIASES[v.slug] || []) terms.add(a);
  }
  // Longest first so "Quinta das Torres" goes before "Torres".
  const sorted = [...terms].sort((a, b) => b.length - a.length).map(escapeRe);
  // "at (the) X" goes entirely; "in the X gardens" keeps "in the".
  const re = new RegExp(`(?:\\bat\\s+(?:the\\s+)?)?(?<![\\p{L}])(?:${sorted.join('|')})(?![\\p{L}])`, 'giu');
  return (caption) => {
    if (!caption) return '';
    let out = caption.replace(re, ' ');
    out = out
      .replace(/\s+([,.;:!?)])/g, '$1')
      .replace(/([(])\s+/g, '$1')
      .replace(/\(\s*\)/g, '')
      .replace(/[,;:\-–—]\s*([,;:\-–—])/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .replace(/^[\s,;:\-–—]+|[\s,;:\-–—]+$/g, '')
      .trim();
    return out ? out[0].toUpperCase() + out.slice(1) : '';
  };
}

async function youtubeThumb(id) {
  const max = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  const hq = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
  if (OFFLINE) return hq;
  try {
    const r = await fetchWithTimeout(max, { method: 'HEAD', headers: { 'User-Agent': UA } }, 8000);
    return r.ok ? max : hq;
  } catch {
    return hq;
  }
}

async function vimeoThumb(url) {
  if (OFFLINE) return null;
  try {
    const r = await fetchWithTimeout(
      `https://vimeo.com/api/oembed.json?width=1280&url=${encodeURIComponent(url)}`,
      { headers: { 'User-Agent': UA } },
      8000,
    );
    if (!r.ok) return null;
    const j = await r.json();
    return j.thumbnail_url ? j.thumbnail_url.replace(/_\d+x\d+(\.\w+)?$/, '_1280$1') : null;
  } catch {
    return null;
  }
}

async function main() {
  const venues = await loadVenues();
  const slugs = new Set(venues.map((v) => v.slug));
  const strip = buildStripper(venues);

  for (const f of await venueFolders()) {
    if (!slugs.has(f)) console.warn(`! venues/${f}/ has no entry in data/venues.json, so it's skipped`);
  }

  const cards = [];
  const summary = [];
  for (const v of venues) {
    const images = await readMedia(v.slug, 'images');
    const videos = await readMedia(v.slug, 'videos');
    images.forEach((m, i) => {
      cards.push({
        id: `${v.slug}:img:${i}`,
        venue: v.slug,
        type: 'image',
        src: m.url,
        caption: strip(m.caption),
        credit: strip(m.credit) || 'Venue gallery',
        source: m.source,
      });
    });
    for (const [i, m] of videos.entries()) {
      const vid = parseVideo(m.url);
      const card = {
        id: `${v.slug}:vid:${i}`,
        venue: v.slug,
        type: 'video',
        provider: vid.provider,
        videoId: vid.id,
        videoHash: vid.hash || null,
        src: m.url,
        caption: strip(m.caption.replace(/\(opens externally\)/i, '')),
        external: vid.provider === 'external' || /\(opens externally\)/i.test(m.caption),
        credit: strip(m.credit) || 'Venue film',
        source: m.source,
        poster: null,
      };
      if (vid.provider === 'youtube') card.poster = await youtubeThumb(vid.id);
      else if (vid.provider === 'vimeo') card.poster = await vimeoThumb(m.url);
      cards.push(card);
    }
    summary.push(`${v.slug.padEnd(40)} ${String(images.length).padStart(3)} images ${String(videos.length).padStart(3)} videos`);
  }

  // Public venue info for the results page. Drop working notes that aren't for display.
  const publicVenues = venues.map(({ seedImages, ...rest }) => rest);
  const out = { builtAt: new Date().toISOString(), venues: publicVenues, cards };
  const file = path.join(ROOT, 'site', 'cards.json');
  await writeFile(file, JSON.stringify(out) + '\n');
  console.log(summary.join('\n'));
  console.log(`\nWrote ${cards.length} cards to site/cards.json`);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
