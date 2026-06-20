# CLAUDE.md — orientation for working on Clef

Clef is a **pure client-side sheet-music notation editor** (think MuseScore-lite)
that runs by opening `index.html` directly — no backend, no build step, no
bundler. Read this before changing anything.

## How to run

- Just open `index.html` in a browser (works from `file://` — you can
  double-click it). Internet is needed once so the CDN libraries load.
- Or serve it: `npx http-server -p 8080 -c-1` then visit
  `http://localhost:8080/index.html`.

## ⚠️ Critical constraint: NO ES modules

The app **must run from `file://`**. Chrome blocks native ES-module `import`
over `file://` (CORS: "Cross origin requests are only supported for protocol
schemes: http, https, …"), which breaks the app with console errors when a
user double-clicks `index.html`.

Therefore every file in `js/` is a **classic script** that shares a single
global namespace, `window.MN`, using the IIFE module pattern:

```js
(function () {
'use strict';
const MN = (window.MN = window.MN || {});
const { someDep } = MN.model;        // read dependencies from the namespace
// ... module body ...
MN.thismodule = { /* public API */ };  // publish
})();
```

`index.html` loads them as ordered classic `<script>` tags (dependency order):
`instruments → model → audio → storage → render → editor → pdf → main`.

**Do NOT convert these back to `import`/`export`.** If you add a file, follow the
same IIFE-on-`window.MN` pattern and add it to the ordered scripts in
`index.html`.

## Architecture

All editing flows through a command/state-history layer so **undo/redo covers
every edit**. The render layer is a **pure function of model state** — never
mutate the model from render.

| File | Responsibility |
|---|---|
| `js/instruments.js` | Instrument presets (name + default clef). `MN.instruments` |
| `js/model.js` | Serializable score model + pure pitch/duration math + (de)serialize. `MN.model` |
| `js/audio.js` | Web Audio note/chord "ping" on entry. `MN.audio` |
| `js/storage.js` | IndexedDB project save/load/list/delete (idb-keyval). `MN.storage` |
| `js/render.js` | VexFlow rendering, layout/pagination, geometry capture + `hitTest`. `MN.render` |
| `js/editor.js` | `MN.Editor` class: cursor, note entry, palette state, undo/redo |
| `js/pdf.js` | SVG → **vector** PDF (jsPDF + svg2pdf.js). `MN.pdf` |
| `js/main.js` | App bootstrap + all DOM/UI wiring (IIFE, no public API) |

### Data model (see top of `model.js`)

```js
score   = { id, name, title, composer, tempo, timeSignature, staves[] }
staff   = { id, instrument, name, clef, keySignature, measures[] }
measure = { timeSignature?, keySignature?, notes[] }   // signatures inherited unless set
note    = { pitches[], duration, dots, tie, dynamic, notehead, lyric, chordSymbol }
pitch   = { letter:'A'..'G', octave, acc:'' | '#' | 'b' | 'n' | '##' | 'bb' | '+' | 'd' }
// A rest is a note with an empty pitches[] array.
```

### Key behaviors / gotchas

- **Undo/redo**: `editor.commit(mutator, coalesceKey?)` snapshots state first
  (full structuredClone). `replaceScore()` clears history (project switch).
- **Cursor**: `cursor.noteIndex` is an insertion bar in `[0, notes.length]`,
  drawn to the LEFT of `notes[noteIndex]`. The "target" note (what accidental/
  duration/tie/delete act on, highlighted blue) is the note immediately LEFT of
  the bar. See `editor.targetNoteIndex()`.
- **Empty measures** render a single whole rest (`render.js` `buildMeasure`).
- **Accidentals are explicit**: the renderer draws exactly the `acc` on each
  pitch; the key signature is currently **display-only** (it does not alter
  un-marked notes, and audio plays the literal pitch). 
- **Ties** are drawn only within a single system (`tieChains` in `drawSystem`).
- Geometry for click→pitch and the cursor is captured during render into
  `layout.staveBoxes`; `render.hitTest(layout, pageIndex, x, y)` maps SVG coords
  to `{staffIndex, measureIndex, slot, pitch, nearestNoteIndex}`.
- **Layout**: `render.js` packs a fixed number of measures per system with
  (mostly) equal widths. The page coordinate system IS points (612×792 = US
  Letter), reused 1:1 for the PDF.

### Known limitations (candidate improvements)

- Dense measures don't widen: notes can overflow past the barline (layout uses
  fixed measure widths rather than content-driven minimum widths).
- No measure-capacity logic: you can over/under-fill a bar; trailing rests
  aren't auto-filled; the cursor doesn't auto-advance when a bar fills.
- Audio ignores the key signature (plays the literal written pitch).
- Side-panel staff count text pluralizes as "staffes".

## Verifying changes (headless Chromium)

A browser is the only real test. Playwright + Chromium are installed.

- Playwright lives in the global modules dir (find it with `npm root -g`, e.g.
  `/opt/node22/lib/node_modules/playwright`). It's CommonJS — import the default.
- **You must ignore TLS errors**, otherwise the CDN libs fail to load in
  headless Chromium (the sandbox intercepts TLS; `curl` works but the bundled
  browser doesn't trust the cert):
  launch with `args: ['--ignore-certificate-errors']` and context
  `{ ignoreHTTPSErrors: true }`.
- Test against `file:///home/user/claude-music-notation/index.html` to exercise
  the real "double-click" path (not just http).
- There's a debug hook: `window.MusicApp = { editor, layout, render(),
  exportDataUri() }`. Drive the app through it and assert on
  `window.MusicApp.editor.score`.

Minimal harness:

```js
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const b = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', e => errors.push(e.message));
await page.goto('file:///home/user/claude-music-notation/index.html', { waitUntil: 'networkidle' });
await page.waitForSelector('svg.score-svg');
// ... drive via window.MusicApp.editor, assert, screenshot ...
console.log('console errors:', errors);
await b.close();
```

**Acceptance bar for any change**: app still loads from `file://` with **zero
console errors**, and the core workflow (new project → multi-staff entry → save
→ reload → reopen → export PDF) still works. Take a screenshot and eyeball the
notation.

## Style

Vanilla JS, no framework, no build. Match the surrounding code: concise
comments explaining *why*, consistent naming, keep render derived from model,
route all mutations through `editor.commit`.
