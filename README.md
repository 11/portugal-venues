# Portugal Venues: blind swipe

A Tinder-style deck for choosing our wedding venue near Lisbon (about 150 guests).
Swipe right or left on photos and films of 12 venues **without seeing which venue is which**.
After the last card, the venues are revealed and ranked by how much we liked them.

**Live:** https://11.github.io/portugal-venues/

- One shared deck on one phone; progress saves in the browser, so closing the tab is safe.
- Results rank venues by like ratio (liked ÷ that venue's cards), with ties broken by number of likes.
  You can re-sort by lowest estimated cost or capacity, and copy a plain-text summary.
- Plain HTML/CSS/JS, no build tooling beyond one small Node script. Media is linked, never rehosted.

## How it fits together

```
data/venues.json              # research for each venue (source of truth; don't change the figures)
venues/<slug>/images.md       # photo links for one venue
venues/<slug>/videos.md       # YouTube/Vimeo links for one venue
scripts/build-cards.mjs       # venues/*/*.md + data/venues.json → site/cards.json
scripts/check-links.mjs       # finds dead, hotlink-blocked or low-res links
site/                         # the app (index.html, app.js, styles.css, generated cards.json)
.github/workflows/pages.yml   # on push to main: build cards.json, deploy site/ to GitHub Pages
```

## Add or remove a venue

1. Add an entry to `data/venues.json` with a unique `slug` (copy an existing entry for the fields).
2. Create `venues/<slug>/images.md` and `venues/<slug>/videos.md` (format below).
3. Run `node scripts/build-cards.mjs` to check it parses, then commit and push. The site redeploys.

To remove a venue, delete its entry from `data/venues.json` and its folder, then push.

If the venue's name has a short form people might use in captions (like "Queluz" for Queluz National Palace),
add it to `ALIASES` in `scripts/build-cards.mjs` so it's hidden on the cards.

## Add media

Keep the format strict; the build script parses it.

`venues/<slug>/images.md`

```markdown
# Venue Name — Images

- url: https://example.com/full-size-photo.jpg
  caption: Garden terrace set for dinner at dusk
  source: https://page-where-you-found-it.com/post
  credit: Photographer or site name
```

`venues/<slug>/videos.md`

```markdown
# Venue Name — Videos

- url: https://www.youtube.com/watch?v=XXXXXXXXXXX
  caption: Full wedding film, ceremony in the gardens
  source: https://www.youtube.com/watch?v=XXXXXXXXXXX
  credit: Videographer name
```

- Images: use the full-size file (at least 1600px on the long side), not a thumbnail.
- Videos: YouTube or Vimeo. For anything else, write `caption: (opens externally)` and it opens in a new tab.
- Venue names in captions and credits are hidden automatically on the cards. They show again on the results page.

Then:

```bash
node scripts/check-links.mjs           # report broken / small / hotlink-blocked links
node scripts/check-links.mjs --prune   # same, and delete the failing items from the .md files
node scripts/build-cards.mjs           # regenerate site/cards.json
```

## Run locally

```bash
node scripts/build-cards.mjs
npx serve site
```

Then open the URL it prints. Arrow keys swipe on desktop; `u` or Backspace undoes.
