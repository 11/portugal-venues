(() => {
  'use strict';

  const KEY = 'portugal-venues:v1';
  const PRELOAD_AHEAD = 3;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  let data;            // { venues, cards }
  let cardsById;       // Map id -> card
  let venuesBySlug;    // Map slug -> venue
  let state;           // { order: [id], decisions: {id: 'like'|'pass'|'skip'}, history: [id] }
  let busy = false;    // a card is mid-flight
  let sortMode = 'ratio';
  const elCache = new Map(); // id -> card element (keeps loaded images around)

  // ---------- storage (never throws) ----------
  const store = {
    load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } },
    save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode etc. */ } },
    clear() { try { localStorage.removeItem(KEY); } catch { /* ignore */ } },
  };

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const usd = (n) => '$' + Math.round(n).toLocaleString('en-US');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Shuffle so the same venue rarely appears twice within a few cards.
  // Picks a venue at random, weighted by how many cards it has left,
  // excluding the venues used in the last couple of picks.
  function spreadDeck(cards) {
    const groups = new Map();
    for (const c of shuffle([...cards])) {
      if (!groups.has(c.venue)) groups.set(c.venue, []);
      groups.get(c.venue).push(c.id);
    }
    const out = [];
    const recent = [];
    while (groups.size) {
      const gap = Math.min(3, groups.size - 1);
      const blocked = new Set(recent.slice(-gap));
      let pool = [...groups.entries()].filter(([v]) => !blocked.has(v));
      if (!pool.length) pool = [...groups.entries()];
      const total = pool.reduce((s, [, ids]) => s + ids.length, 0);
      let r = Math.random() * total;
      let pick = pool[0];
      for (const entry of pool) { r -= entry[1].length; if (r <= 0) { pick = entry; break; } }
      const [venue, ids] = pick;
      out.push(ids.pop());
      if (!ids.length) groups.delete(venue);
      recent.push(venue);
    }
    return out;
  }

  function freshState() {
    return { order: spreadDeck(data.cards), decisions: {}, history: [], startedAt: Date.now() };
  }

  // Keep saved progress if cards.json changed: drop removed cards, add new ones at the end.
  function reconcile(saved) {
    if (!saved || !Array.isArray(saved.order)) return freshState();
    const order = saved.order.filter((id) => cardsById.has(id));
    const known = new Set(order);
    const added = data.cards.filter((c) => !known.has(c.id));
    const decisions = {};
    for (const [id, d] of Object.entries(saved.decisions || {})) if (cardsById.has(id)) decisions[id] = d;
    const history = (saved.history || []).filter((id) => id in decisions);
    return { ...saved, order: order.concat(spreadDeck(added)), decisions, history };
  }

  const decidedCount = () => Object.keys(state.decisions).length;
  const undecided = () => state.order.filter((id) => !(id in state.decisions));
  const isDone = () => state.order.length > 0 && decidedCount() >= state.order.length;

  // ---------- screens ----------
  function show(id) {
    for (const s of $$('.screen')) s.hidden = s.id !== id;
    if (id === 'results') { renderResults(); $('#results').scrollTop = 0; }
    if (id === 'swipe') renderDeck();
  }

  // ---------- deck rendering ----------
  function makeCardEl(c) {
    const el = document.createElement('div');
    el.className = 'card';
    el.dataset.id = c.id;

    if (c.type === 'image') {
      const img = new Image();
      img.className = 'media';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.alt = c.caption || 'Venue photo';
      img.draggable = false;
      img.addEventListener('load', () => img.classList.add('loaded'));
      img.addEventListener('error', () => showFallback(el, "This photo didn't load."));
      img.src = c.src;
      el.append(img);
      el.insertAdjacentHTML('beforeend', '<div class="spinner"></div>');
    } else {
      if (c.poster) {
        const img = new Image();
        img.className = 'media';
        img.decoding = 'async';
        img.referrerPolicy = 'no-referrer';
        img.alt = c.caption || 'Wedding film';
        img.draggable = false;
        img.addEventListener('load', () => img.classList.add('loaded'));
        img.src = c.poster;
        el.append(img);
        el.insertAdjacentHTML('beforeend', '<div class="spinner"></div>');
      } else {
        el.style.background = 'var(--ink)';
      }
      el.insertAdjacentHTML(
        'beforeend',
        `<span class="kind">${c.external ? 'Film · opens externally' : 'Film'}</span>
         <button class="play" aria-label="${c.external ? 'Open video' : 'Play video'}">
           ${c.external
             ? '<svg viewBox="0 0 24 24" width="30" height="30"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
             : '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M7 4.5v15l12.5-7.5z" fill="currentColor"/></svg>'}
         </button>`,
      );
    }
    el.insertAdjacentHTML(
      'beforeend',
      `<div class="shade"></div>
       <div class="meta">
         ${c.caption ? `<p class="caption">${esc(c.caption)}</p>` : ''}
         <p class="credit">${esc(c.credit)}</p>
       </div>
       <div class="stamp like" aria-hidden="true">❤️</div>
       <div class="stamp pass" aria-hidden="true">✕</div>`,
    );
    return el;
  }

  function showFallback(el, msg) {
    if ($('.fallback', el)) return;
    el.insertAdjacentHTML('beforeend', `<div class="fallback"><p>${esc(msg)}</p><button class="btn ghost skip">Skip this card</button></div>`);
    $('.spinner', el)?.remove();
  }

  function cardEl(id) {
    if (!elCache.has(id)) elCache.set(id, makeCardEl(cardsById.get(id)));
    return elCache.get(id);
  }

  function resetEl(el) {
    el.classList.remove('dragging', 'behind', 'behind-2');
    el.style.transform = '';
    el.style.opacity = '';
    for (const s of $$('.stamp', el)) s.style.opacity = '';
  }

  function stopVideo(el) {
    $('.frame', el)?.remove();
    $('.grip', el)?.remove();
    el.classList.remove('playing');
  }

  function renderDeck() {
    const upcoming = undecided();
    const stage = $('#stage');
    const visible = upcoming.slice(0, 3);
    const els = visible.map(cardEl);
    els.forEach((el, i) => {
      if (i > 0) stopVideo(el);
      el.classList.toggle('behind', i === 1);
      el.classList.toggle('behind-2', i === 2);
      if (i === 0) el.classList.remove('behind', 'behind-2');
    });
    // Remove anything no longer in the visible stack.
    for (const child of [...stage.children]) if (!els.includes(child)) child.remove();
    // Bottom of the stack first so the top card is last in the DOM.
    // Only move nodes that are out of place (moving an iframe reloads it).
    els.slice().reverse().forEach((el, i) => {
      if (stage.children[i] !== el) stage.insertBefore(el, stage.children[i] || null);
    });
    if (!visible.length) stage.insertAdjacentHTML('beforeend', '<div class="done-msg">That’s every card ✨</div>');

    // Preload a few more images beyond the visible stack.
    for (const id of upcoming.slice(3, 3 + PRELOAD_AHEAD)) {
      const c = cardsById.get(id);
      const src = c.type === 'image' ? c.src : c.poster;
      if (src) { const i = new Image(); i.referrerPolicy = 'no-referrer'; i.src = src; }
    }

    // Keep the cache small: visible cards plus the last few swiped (for undo).
    const keep = new Set([...visible, ...state.history.slice(-4)]);
    for (const id of elCache.keys()) if (!keep.has(id)) elCache.delete(id);

    // Progress
    const total = state.order.length;
    const done = decidedCount();
    $('#progress-text').textContent = `${Math.min(done + 1, total)} / ${total}`;
    $('#progress-fill').style.width = `${total ? (done / total) * 100 : 0}%`;
    $('#undo-btn').disabled = state.history.length === 0;
  }

  const topEl = () => {
    const id = undecided()[0];
    return id ? elCache.get(id) : null;
  };

  // ---------- decisions ----------
  function decide(kind, from = null) {
    const id = undecided()[0];
    const el = topEl();
    if (!id || !el || busy) return;
    busy = true;
    const w = $('#stage').clientWidth || 360;
    const dir = kind === 'pass' ? -1 : 1;
    const dx = kind === 'skip' ? 0 : dir * w * 1.4;
    const dy = kind === 'skip' ? -w * 1.6 : (from?.dy ?? 30);
    el.classList.remove('dragging');
    if (kind !== 'skip') $(`.stamp.${kind}`, el).style.opacity = '1';
    // Force a frame so the transition runs even from a button press.
    requestAnimationFrame(() => {
      el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dir * 18}deg)`;
      el.style.opacity = '0';
    });
    setTimeout(() => {
      stopVideo(el);
      el.remove();
      resetEl(el);
      state.decisions[id] = kind;
      state.history.push(id);
      store.save();
      busy = false;
      if (isDone()) {
        renderDeck();
        setTimeout(() => show('results'), 350);
      } else {
        renderDeck();
      }
    }, 300);
  }

  function undo() {
    if (busy || !state.history.length) return;
    const id = state.history.pop();
    const kind = state.decisions[id];
    delete state.decisions[id];
    store.save();
    if ($('#swipe').hidden) show('swipe');
    else renderDeck();
    const el = cardEl(id);
    const w = $('#stage').clientWidth || 360;
    const dir = kind === 'pass' ? -1 : 1;
    el.classList.add('dragging');
    el.style.transform = kind === 'skip'
      ? `translate(0, ${-w * 1.6}px)`
      : `translate(${dir * w * 1.4}px, 30px) rotate(${dir * 18}deg)`;
    el.style.opacity = '0';
    el.getBoundingClientRect(); // reflow
    el.classList.remove('dragging');
    el.style.transform = '';
    el.style.opacity = '';
  }

  // ---------- dragging ----------
  let drag = null;

  function onDown(e) {
    const el = topEl();
    if (!el || busy || !el.contains(e.target) || e.button > 0) return;
    if (e.target.closest('.play, .skip, iframe')) return;
    if (el.classList.contains('playing') && !e.target.closest('.grip-area')) return;
    drag = { el, id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0, t: performance.now(), lastX: e.clientX, lastT: performance.now(), vx: 0 };
    el.classList.add('dragging');
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }

  function onMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag.dx = e.clientX - drag.x0;
    drag.dy = e.clientY - drag.y0;
    const now = performance.now();
    const dt = now - drag.lastT;
    if (dt > 0) drag.vx = 0.8 * ((e.clientX - drag.lastX) / dt) + 0.2 * drag.vx;
    drag.lastX = e.clientX;
    drag.lastT = now;
    const rot = drag.dx / 18;
    drag.el.style.transform = `translate(${drag.dx}px, ${drag.dy * 0.35}px) rotate(${rot}deg)`;
    const k = clamp(Math.abs(drag.dx) / 110, 0, 1);
    $('.stamp.like', drag.el).style.opacity = drag.dx > 0 ? k : 0;
    $('.stamp.pass', drag.el).style.opacity = drag.dx < 0 ? k : 0;
  }

  function onUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const { el, dx, dy, vx } = drag;
    drag = null;
    const w = $('#stage').clientWidth || 360;
    const fling = Math.abs(vx) > 0.55 && Math.abs(dx) > 40 && Math.sign(vx) === Math.sign(dx);
    if (Math.abs(dx) > w * 0.28 || fling) {
      decide(dx > 0 ? 'like' : 'pass', { dy: dy * 0.35 });
    } else {
      el.classList.remove('dragging');
      el.style.transform = '';
      for (const s of $$('.stamp', el)) s.style.opacity = '';
    }
  }

  // ---------- video ----------
  function embedUrl(c, autoplay) {
    if (c.provider === 'youtube') {
      return `https://www.youtube-nocookie.com/embed/${c.videoId}?playsinline=1&rel=0&modestbranding=1${autoplay ? '&autoplay=1' : ''}`;
    }
    if (c.provider === 'vimeo') {
      return `https://player.vimeo.com/video/${c.videoId}?title=0&byline=0&portrait=0&dnt=1&playsinline=1${c.videoHash ? `&h=${c.videoHash}` : ''}${autoplay ? '&autoplay=1' : ''}`;
    }
    return null;
  }

  function playVideo(el, c) {
    if (c.external || !embedUrl(c)) { window.open(c.src, '_blank', 'noopener'); return; }
    el.classList.add('playing');
    el.insertAdjacentHTML(
      'beforeend',
      `<div class="frame"><iframe src="${esc(embedUrl(c, true))}" title="Wedding film" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>
         <div class="mask grip-area" aria-hidden="true"></div></div>
       <div class="grip grip-area">Drag here to swipe</div>`,
    );
  }

  // ---------- results ----------
  function guestCapacity(v) {
    // Largest guest number in the first clause, ignoring m² areas.
    const first = String(v.capacity || '').split(/[;.](?:\s|$)/)[0];
    let max = 0;
    for (const m of first.matchAll(/(\d[\d,]*)(?:\s*[–-]\s*(\d[\d,]*))?\s*(m²|m2)?/g)) {
      if (m[3]) continue;
      for (const n of [m[1], m[2]]) if (n) max = Math.max(max, Number(n.replace(/,/g, '')));
    }
    return max;
  }

  function venueStats() {
    return data.venues.map((v) => {
      const cards = data.cards.filter((c) => c.venue === v.slug && state.decisions[c.id] !== 'skip');
      const liked = cards.filter((c) => state.decisions[c.id] === 'like');
      const passed = cards.filter((c) => state.decisions[c.id] === 'pass');
      const seen = liked.length + passed.length;
      return {
        v,
        total: cards.length,
        seen,
        liked,
        passed: passed.length,
        ratio: seen ? liked.length / seen : -1,
        cap: guestCapacity(v),
      };
    });
  }

  function sorted(stats) {
    const byRatio = (a, b) => b.ratio - a.ratio || b.liked.length - a.liked.length || a.v.name.localeCompare(b.v.name);
    const s = [...stats];
    if (sortMode === 'cost') s.sort((a, b) => (a.v.estimate150Usd?.min ?? 1e12) - (b.v.estimate150Usd?.min ?? 1e12) || (a.v.estimate150Usd?.max ?? 1e12) - (b.v.estimate150Usd?.max ?? 1e12) || byRatio(a, b));
    else if (sortMode === 'capacity') s.sort((a, b) => b.cap - a.cap || byRatio(a, b));
    else s.sort(byRatio);
    // Rank always reflects like ratio, whatever the display order.
    const rankOrder = [...stats].sort(byRatio);
    return s.map((x) => ({ ...x, rank: rankOrder.indexOf(stats.find((y) => y.v.slug === x.v.slug)) + 1 }));
  }

  const pct = (r) => (r < 0 ? '–' : `${Math.round(r * 100)}%`);
  const srcLink = (url) => (url ? ` <a class="src" href="${esc(url)}" target="_blank" rel="noopener">source ↗</a>` : '');

  function renderResults() {
    const stats = venueStats();
    const totalLiked = stats.reduce((s, x) => s + x.liked.length, 0);
    const totalSeen = stats.reduce((s, x) => s + x.seen, 0);
    $('#results-summary').textContent = `You loved ${totalLiked} of ${totalSeen} cards. Here's how the ${stats.length} venues compare, ranked by the share of their cards you liked.`;
    for (const b of $$('.sortbar .chip')) b.classList.toggle('active', b.dataset.sort === sortMode);

    $('#venue-list').innerHTML = sorted(stats).map((x) => {
      const { v } = x;
      const lw = x.seen ? (x.liked.length / x.seen) * 100 : 0;
      const pw = x.seen ? (x.passed / x.seen) * 100 : 0;
      const est = v.estimate150Usd ? `${usd(v.estimate150Usd.min)}–${usd(v.estimate150Usd.max)}` : '–';
      const thumbs = x.liked.map((c) => {
        const src = c.type === 'image' ? c.src : c.poster;
        return `<button class="thumb" data-card="${esc(c.id)}" aria-label="Open ${c.type}">
          ${src ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}
          ${c.type === 'video' ? '<span class="tplay">▶</span>' : ''}
        </button>`;
      }).join('');
      const links = [
        v.googleMaps && `<a href="${esc(v.googleMaps)}" target="_blank" rel="noopener">Google Maps</a>`,
        v.weddingBox && `<a href="${esc(v.weddingBox)}" target="_blank" rel="noopener">Wedding Box</a>`,
        v.officialSite && `<a href="${esc(v.officialSite)}" target="_blank" rel="noopener">Official site</a>`,
      ].filter(Boolean).join('');
      return `<li class="venue">
        <div class="venue-head">
          <span class="rank">${x.rank}</span>
          <div>
            <h2>${esc(v.name)}</h2>
            <p class="sub">${esc(v.category)} · ${esc(v.area)}</p>
          </div>
        </div>
        <div class="score">
          <div class="score-line">
            <strong>${x.seen ? `Liked ${x.liked.length} of ${x.seen} (${pct(x.ratio)})` : 'No cards swiped yet'}</strong>
            <span>❤️ ${x.liked.length} · ✕ ${x.passed}</span>
          </div>
          <div class="meter" role="img" aria-label="${x.liked.length} liked, ${x.passed} passed"><div class="l" style="width:${lw}%"></div><div class="p" style="width:${pw}%"></div></div>
        </div>
        <dl class="facts">
          <dt>Style</dt><dd>${esc(v.style)}</dd>
          <dt>Capacity</dt><dd>${esc(v.capacity)}${srcLink(v.capacitySource)}</dd>
          <dt>Venue price</dt><dd>${esc(v.venuePrice)}${srcLink(v.venuePriceSource)}</dd>
          <dt>All-in, 150</dt><dd>${est} <span style="color:var(--muted)">(estimate)</span></dd>
        </dl>
        ${v.notes ? `<p class="notes">${esc(v.notes)}</p>` : ''}
        ${thumbs ? `<div class="thumbs">${thumbs}</div>` : `<p class="no-likes">${x.total ? 'No liked cards.' : 'No photos or films for this venue yet.'}</p>`}
        ${links ? `<div class="links">${links}</div>` : ''}
      </li>`;
    }).join('');
  }

  function resultsText() {
    const label = { ratio: 'like ratio', cost: 'lowest estimated cost', capacity: 'capacity' }[sortMode];
    const lines = [`Our Lisbon wedding venue ranking (sorted by ${label})`, ''];
    for (const x of sorted(venueStats())) {
      const v = x.v;
      lines.push(`${x.rank}. ${v.name}: ${x.seen ? `liked ${x.liked.length} of ${x.seen} (${pct(x.ratio)})` : 'not swiped'}`);
      lines.push(`   ${v.category} · ${v.area}`);
      lines.push(`   Capacity: ${v.capacity}`);
      lines.push(`   Venue price: ${v.venuePrice}`);
      if (v.estimate150Usd) lines.push(`   Est. all-in for 150: ${usd(v.estimate150Usd.min)}–${usd(v.estimate150Usd.max)}`);
      lines.push('');
    }
    lines.push('Open these results: ' + shareUrl());
    return lines.join('\n');
  }

  async function copyResults() {
    const text = resultsText();
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.append(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
      toast(ok ? 'Copied to clipboard' : "Couldn't copy. Try again from another browser.");
    }
  }

  // ---------- export / import ----------
  // Share link: every card (sorted by id) gets 2 bits: 0 unswiped, 1 like, 2 pass, 3 skip.
  const CODE = { like: 1, pass: 2, skip: 3 };
  const DECODE = [null, 'like', 'pass', 'skip'];
  const sortedIds = () => [...cardsById.keys()].sort();

  function encodeDecisions() {
    const ids = sortedIds();
    const bytes = new Uint8Array(Math.ceil(ids.length / 4));
    ids.forEach((id, i) => { bytes[i >> 2] |= (CODE[state.decisions[id]] || 0) << ((i & 3) * 2); });
    const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${ids.length}.${b64}`;
  }

  function decodeDecisions(str) {
    const [n, b64] = String(str).split('.');
    const ids = sortedIds();
    if (Number(n) !== ids.length || !b64) {
      throw new Error('This link was made from a different version of the deck. Use “Save file” and “Import” instead.');
    }
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    const out = {};
    ids.forEach((id, i) => {
      const code = (bin.charCodeAt(i >> 2) >> ((i & 3) * 2)) & 3;
      if (code) out[id] = DECODE[code];
    });
    return out;
  }

  function shareUrl() {
    return `${location.origin}${location.pathname}#r=${encodeDecisions()}`;
  }

  async function shareLink() {
    const url = shareUrl();
    if (navigator.share && matchMedia('(pointer: coarse)').matches) {
      try { await navigator.share({ title: 'Our venue swipes', url }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    try { await navigator.clipboard.writeText(url); toast('Share link copied'); }
    catch { prompt('Copy this link:', url); }
  }

  function exportData() {
    const stats = venueStats();
    return {
      app: 'portugal-venues',
      version: 1,
      exportedAt: new Date().toISOString(),
      swiped: decidedCount(),
      totalCards: state.order.length,
      decisions: state.decisions,
      order: state.order,
      summary: sorted(stats).map((x) => ({ rank: x.rank, venue: x.v.name, liked: x.liked.length, passed: x.passed, ratio: x.ratio < 0 ? null : Math.round(x.ratio * 1000) / 1000 })),
    };
  }

  async function exportFile() {
    const json = JSON.stringify(exportData(), null, 2);
    const name = `venue-swipes-${new Date().toISOString().slice(0, 10)}.json`;
    const file = new File([json], name, { type: 'application/json' });
    if (navigator.canShare && matchMedia('(pointer: coarse)').matches && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Our venue swipes' }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Saved ' + name);
  }

  function applyImport(decisions, label) {
    const clean = {};
    let unknown = 0;
    for (const [id, d] of Object.entries(decisions || {})) {
      if (!cardsById.has(id)) { unknown++; continue; }
      if (DECODE.includes(d) && d) clean[id] = d;
    }
    const n = Object.keys(clean).length;
    if (!n) { toast('Nothing to import: no matching swipes found'); return false; }
    const existing = decidedCount();
    if (existing && JSON.stringify(clean) !== JSON.stringify(state.decisions)) {
      if (!confirm(`Replace the ${existing} swipes on this device with ${n} swipes from ${label}?`)) return false;
    }
    state.decisions = clean;
    // Put swiped cards first (in their old order), so the deck carries on where it left off.
    const done = state.order.filter((id) => id in clean);
    state.order = done.concat(state.order.filter((id) => !(id in clean)));
    state.history = done;
    store.save();
    elCache.clear();
    $('#stage').innerHTML = '';
    $('#menu').hidden = true;
    show(isDone() ? 'results' : 'swipe');
    toast(`Imported ${n} swipes${unknown ? ` (${unknown} no longer in the deck)` : ''}`);
    return true;
  }

  function importFromFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const j = JSON.parse(reader.result);
        if (j.app !== 'portugal-venues' || !j.decisions) throw new Error('not a venue swipes file');
        applyImport(j.decisions, 'the file');
      } catch (e) {
        toast(`Couldn't import: ${e.message}`);
      }
    };
    reader.readAsText(file);
  }

  function importFromHash() {
    const m = location.hash.match(/^#r=([\w.-]+)/);
    if (!m) return false;
    history.replaceState(null, '', location.pathname + location.search);
    try {
      return applyImport(decodeDecisions(m[1]), 'the shared link');
    } catch (e) {
      toast(e.message);
      return false;
    }
  }

  // ---------- lightbox ----------
  function openLightbox(c) {
    const lb = $('#lightbox');
    const body = $('.lb-body', lb);
    if (c.type === 'image') {
      body.innerHTML = `<img src="${esc(c.src)}" alt="${esc(c.caption)}" referrerpolicy="no-referrer">`;
    } else if (embedUrl(c)) {
      body.innerHTML = `<div class="lb-video"><iframe src="${esc(embedUrl(c, true))}" title="Wedding film" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen></iframe></div>`;
    } else {
      body.innerHTML = `<a class="btn primary" style="display:inline-flex;align-items:center" href="${esc(c.src)}" target="_blank" rel="noopener">Open video ↗</a>`;
    }
    $('.lb-caption', lb).innerHTML = `${esc(c.caption)}${c.caption ? ' · ' : ''}${esc(c.credit)}${c.source ? ` · <a href="${esc(c.source)}" target="_blank" rel="noopener">source</a>` : ''}`;
    lb.hidden = false;
  }
  function closeLightbox() {
    const lb = $('#lightbox');
    lb.hidden = true;
    $('.lb-body', lb).innerHTML = '';
  }

  // ---------- misc UI ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
  }

  function restart() {
    if (!confirm('Start over? This clears every swipe and reshuffles the deck.')) return;
    store.clear();
    elCache.clear();
    $('#stage').innerHTML = '';
    state = freshState();
    store.save();
    $('#menu').hidden = true;
    showIntro();
  }

  function showIntro() {
    const n = data.venues.filter((v) => data.cards.some((c) => c.venue === v.slug)).length;
    $('#intro-venues').textContent = String(n);
    $('#intro-count').textContent = `${data.cards.length} cards · progress saves on this phone`;
    show('intro');
  }

  function bind() {
    const stage = $('#stage');
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener('click', (e) => {
      const el = e.target.closest('.card');
      if (!el || el !== topEl()) return;
      if (e.target.closest('.play')) playVideo(el, cardsById.get(el.dataset.id));
      else if (e.target.closest('.skip')) decide('skip');
    });

    $('#like-btn').addEventListener('click', () => decide('like'));
    $('#pass-btn').addEventListener('click', () => decide('pass'));
    $('#undo-btn').addEventListener('click', undo);
    $('#start-btn').addEventListener('click', () => show('swipe'));
    $('#menu-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; });
    $('#menu').addEventListener('click', (e) => {
      const a = e.target.closest('button')?.dataset.action;
      $('#menu').hidden = true;
      if (a === 'restart') restart();
    });
    document.addEventListener('click', (e) => { if (!e.target.closest('#menu, #menu-btn')) $('#menu').hidden = true; });

    $('.sortbar').addEventListener('click', (e) => {
      const b = e.target.closest('[data-sort]');
      if (!b) return;
      sortMode = b.dataset.sort;
      renderResults();
    });
    $('#venue-list').addEventListener('click', (e) => {
      const t = e.target.closest('.thumb');
      if (t) openLightbox(cardsById.get(t.dataset.card));
    });
    $('#copy-btn').addEventListener('click', copyResults);
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-action]')?.dataset.action;
      if (a === 'share') shareLink();
      else if (a === 'export') exportFile();
      else if (a === 'import') $('#import-input').click();
    });
    $('#import-input').addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) importFromFile(f);
      e.target.value = '';
    });
    window.addEventListener('hashchange', importFromHash);
    $('#restart-btn').addEventListener('click', restart);

    $('#lightbox').addEventListener('click', (e) => {
      if (e.target.closest('.lb-close') || e.target === e.currentTarget || e.target.classList.contains('lb-body')) closeLightbox();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeLightbox(); $('#menu').hidden = true; return; }
      if ($('#swipe').hidden || !$('#lightbox').hidden || e.metaKey || e.altKey) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); decide('like'); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); decide('pass'); }
      else if (e.key === 'Backspace' || e.key === 'u' || (e.key === 'z' && e.ctrlKey)) { e.preventDefault(); undo(); }
    });
  }

  // ---------- boot ----------
  async function boot() {
    try {
      const r = await fetch('cards.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
    } catch (e) {
      document.body.innerHTML = `<p style="padding:2rem;font-family:serif">Couldn't load the cards (${esc(e.message)}). Check your connection and reload.</p>`;
      return;
    }
    cardsById = new Map(data.cards.map((c) => [c.id, c]));
    venuesBySlug = new Map(data.venues.map((v) => [v.slug, v]));
    state = reconcile(store.load());
    store.save();
    bind();
    window.__venueSwipe = { shareUrl, exportData }; // for debugging in the console
    if (importFromHash()) return;
    if (isDone()) show('results');
    else if (decidedCount() > 0) show('swipe');
    else showIntro();
  }

  boot();
})();
