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
| `js/model.js` | Serializable score model + pure pitch/duration math + (de)serialize + playback-timeline builder (`buildPlayback`). `MN.model` |
| `js/audio.js` | Web Audio: entry "ping" + scheduled whole-score playback driving a moving playhead. `MN.audio` |
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
  **Partially filled bars** show DISPLAY-ONLY trailing rests (not stored in the
  model): `buildMeasure` appends filler StaveNotes after the real notes
  (`fillerRests`, greedy largest-first, beat-aware), and `realCount` marks how
  many leading staveNotes are real so the cursor/`hitTest` stay on real content.
  (When every staff's measure in a column is empty, those voices are formatted
  independently — VexFlow drops all but one when multiple lone centered whole
  rests share a tick context.)
- **Accidentals are explicit**: the renderer draws exactly the `acc` on each
  pitch; the key signature is **display-only on the page** (it does not alter
  un-marked notes). **Audio sounds the real pitch**, though: the entry "ping"
  applies the effective key signature plus within-bar accidental carry via
  `model.soundingPitches()` (precedence: explicit acc on the note → most recent
  explicit acc on the same letter+octave earlier in the bar → key-signature
  alteration → natural). See `editor._playEntered`.
- **Measure capacity**: `editor.insertPitch`/`insertRest` block an entry that
  would push the bar's real content past its time-signature capacity (mild
  `onNotice` message, e.g. "No room in Staff 2, Bar 5"). When an entry fills a
  bar exactly, the cursor auto-advances to the next bar (`_advanceIfFull`),
  appending a fresh bar to every staff if it was the last (same undo step).
  Pre-existing over-full bars still render — only new entries are blocked.
- **Ties** are drawn only within a single system (`tieChains` in `drawSystem`).
- **Playback** (the toolbar ▶ Play / ■ Stop button, `Space`, and `Ctrl/Cmd`-click
  for "from cursor"): `model.buildPlayback(score, startBeat)` is a **pure**
  function that flattens the score into `{ audioNotes:[{atSec,durSec,freqs}],
  steps:[{atSec,marks}], endSec }`. Measure start times come from each bar's
  time-signature **capacity** (so all staves stay aligned at barlines), a quarter
  lasts `60/tempo`s, audio uses `soundingPitches` (real pitch), rests advance time
  silently, and ties **sustain** (extend the previous onset instead of
  re-articulating, when the pitch set matches). `audio.startPlayback(plan, {onStep,
  onEnd})` schedules every onset on the Web Audio clock and runs a `requestAnimation
  Frame` loop against that same clock: `onStep(marks)` fires at each moment with the
  notes then sounding, `onEnd` once at the natural end. The **moving playhead** is a
  transient `editorState.playing` array (`{staffIndex,measureIndex,noteIndex}`) that
  `render.js` colours green (`PLAY_ACCENT`, distinct from the blue edit `ACCENT`).
  It is **never** routed through `commit` — `main.js` keeps it in `playingMarks` and
  re-renders via a lightweight `renderScoreOnly()` (no side-panel rebuild, **no
  autosave churn**). Any editor mutation/navigation (`onChange`) stops playback;
  so do the Stop button, `Space`, and the end of the score. Dynamics do **not** yet
  affect playback volume (deliberately skipped).
- **Measure navigation**: `Shift`+`←`/`→` jump by whole bar
  (`editor.moveMeasureRight` / `moveMeasureLeft`, MuseScore semantics: Shift+Left
  snaps to the current bar's start, then to the previous bar's). Like the plain
  arrows these are **pure navigation** — they sync palette/last-pitch via
  `_afterNav()` and do **not** create undo history.
- **Removing measures**: `editor.removeMeasure()` drops the **last** bar
  ("– Remove last measure"); `editor.removeMeasureAt(index)` drops a specific bar
  (the cursor's, via "– Remove current measure") from **every** staff so they stay
  equal length. Both are undoable (`commit`) and never let the score fall below one
  measure.
- Geometry for click→pitch and the cursor is captured during render into
  `layout.staveBoxes`; `render.hitTest(layout, pageIndex, x, y)` maps SVG coords
  to `{staffIndex, measureIndex, slot, pitch, nearestNoteIndex}`.
- **Layout**: `render.js` sizes each measure by its content's minimum width
  (`measureContentWidth` → VexFlow `preCalculateMinTotalWidth`; measured without
  `auto_stem`, which under-reports), packs measures into systems greedily by
  available width, then justifies each system to fill the page width (wider bars
  get proportionally more space). The page coordinate system IS points
  (612×792 = US Letter), reused 1:1 for the PDF.

### Known limitations (candidate improvements)

- Ties still only render within a single system (no cross-system / cross-page
  tie continuation).
- The page key signature remains display-only — it does not auto-apply
  accidentals to the drawn noteheads (audio does sound them; see above).

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
  exportDataUri(), isPlaying, playing, play(fromCursor), stop() }`. Drive the app
  through it and assert on `window.MusicApp.editor.score`.
- Regression suites live in `test/`: `verify.mjs` + `verify2.mjs` (entry/capacity/
  layout/save/PDF) and `verify3.mjs` (playback plan + start/advance/stop lifecycle,
  Shift+arrow measure nav, remove-current-measure across staves + undo). Run each
  with `node test/verifyN.mjs`.

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
