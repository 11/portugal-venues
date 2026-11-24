// Shared helpers for build-cards.mjs and check-links.mjs.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VENUES_DIR = path.join(ROOT, 'venues');

export async function loadVenues() {
  const raw = await readFile(path.join(ROOT, 'data', 'venues.json'), 'utf8');
  return JSON.parse(raw).venues;
}

/**
 * Parse the strict list format:
 *
 * - url: https://...
 *   caption: ...
 *   source: https://...
 *   credit: ...
 *
 * Returns [{ url, caption, source, credit, line }]. Throws on malformed input.
 */
export function parseMediaMarkdown(text, file = '') {
  const items = [];
  let cur = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const start = line.match(/^- url:\s*(\S+)\s*$/);
    if (start) {
      cur = { url: start[1], caption: '', source: '', credit: '', line: i + 1 };
      items.push(cur);
      return;
    }
    const field = line.match(/^\s{2,}(caption|source|credit):\s*(.*?)\s*$/);
    if (field) {
      if (!cur) throw new Error(`${file}:${i + 1}: "${field[1]}" before any "- url:"`);
      cur[field[1]] = field[2];
      return;
    }
    if (/^\s*-\s/.test(line)) throw new Error(`${file}:${i + 1}: list item must start with "- url:"`);
  });
  for (const it of items) {
    if (!/^https?:\/\//.test(it.url)) throw new Error(`${file}:${it.line}: url is not http(s): ${it.url}`);
  }
  return items;
}

export async function readMedia(slug, kind) {
  const file = path.join(VENUES_DIR, slug, `${kind}.md`);
  if (!existsSync(file)) return [];
  return parseMediaMarkdown(await readFile(file, 'utf8'), path.relative(ROOT, file));
}

export async function venueFolders() {
  const entries = await readdir(VENUES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

/** Identify a video URL. */
export function parseVideo(url) {
  let m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
  if (m) return { provider: 'youtube', id: m[1] };
  m = url.match(/vimeo\.com\/(?:video\/|channels\/[\w-]+\/|showcase\/\d+\/video\/)?(\d+)(?:\/([\da-f]+))?/);
  if (m) return { provider: 'vimeo', id: m[1], hash: m[2] || null };
  return { provider: 'external', id: null };
}

export async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { redirect: 'follow', ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
