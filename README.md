# Clef — a browser-based sheet-music notation editor

A complete, client-side music notation / composition app (in the spirit of
MuseScore / Sibelius / Finale) that runs entirely in the browser. **No backend,
no build step, no bundler** — just open `index.html`.

Notation is rendered with [VexFlow](https://www.vexflow.com/); PDF export is true
**vector** (VexFlow SVG → PDF via `jsPDF` + `svg2pdf.js`); projects persist
locally in IndexedDB (`idb-keyval`); note-entry feedback uses the Web Audio API.

## Running it

Just open `index.html` in a modern browser (Chrome, Edge, Firefox, Safari).
You can double-click the file — it works straight from `file://`. An internet
connection is needed the first time so the libraries can load from their CDNs.

> Tip: you can also serve the folder (`npx http-server`) if you prefer, but it
> isn't required.

## Features

### Score & staves
- Multi-instrument scores: add/remove staves, rendered as a vertically aligned
  system with a bracket and aligned barlines.
- Instrument presets (Flute, Oboe, Clarinet, … Violin, Cello, Piano, Voice, …)
  that auto-set the staff's clef and display name. Everything is concert pitch.
- Per-staff key signatures and a score time signature, chosen from the UI.
- Title, composer, and tempo, shown on the score and in the PDF.
- Measure numbers shown on every bar.

### Note entry
- A visible **blinking insertion cursor** sits in the current measure.
- **Palette**: durations (whole → 32nd) with a dot toggle, a rest toggle,
  accidentals (𝄫 ♭ ♮ ♯ 𝄪), a tie toggle, and dynamics (pp…ff, cresc., dim.).
- **Pitch entry** by clicking a staff line/space, or by pressing letter keys
  **A–G**; **↑/↓** nudge the selected pitch by a step (Ctrl for an octave);
  **←/→** move the cursor.
- **Chords** (single voice): Shift+click or Shift+A–G stacks a pitch on the
  current note.
- Dynamics attach to notes and render below the staff.
- A short synthesized **ping** plays the pitch/chord you just entered.

### Editing
- Full **undo/redo** for every edit (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z), built on a
  command/state-history layer that snapshots the model on each mutation.
- Delete/Backspace removes the selected note or rest.

### Projects (local, multiple)
- Save/load multiple **named** projects to IndexedDB.
- Project manager: list, create, open, rename, duplicate, delete.
- **Auto-save** (debounced) plus an explicit Save — close the tab and come back.

### Export
- **Vector PDF** export, US Letter, paginated for long scores. Title, composer,
  measure numbers, dynamics, lyrics and chord symbols all appear in the export.

### Tier-2 extras
- Lyrics under notes, chord symbols above the staff.
- Mid-score time/key signature changes (apply from a chosen measure onward).
- Custom noteheads (cross, diamond, triangle, slash).
- Quarter-tone (microtonal) accidentals.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `A`–`G` | Enter a note of that letter |
| `1`…`6` | Duration: whole, half, quarter, 8th, 16th, 32nd |
| `.` | Toggle dotted |
| `R` | Rest |
| `↑` `↓` | Move pitch by a step (`Ctrl` = octave) |
| `←` `→` | Move the insertion cursor |
| `Tab` | Next staff |
| `Shift`+click / `Shift`+`A`–`G` | Add a chord tone |
| `[` `]` `\` | Flat, sharp, natural |
| `T` | Tie to previous |
| `Del` / `Backspace` | Delete selected |
| `Ctrl`+`Z` / `Ctrl`+`Y` | Undo / redo |
| `Ctrl`+`S` | Save |

Press **?** in the app for the in-app legend.

## Project structure

```
index.html          markup + CDN library tags + ordered module scripts
css/styles.css       all styling (toolbar, side panel, paper, overlays)
js/instruments.js    instrument presets (name + clef)
js/model.js          score data model, serialization, pitch/duration math
js/audio.js          Web Audio note ping
js/storage.js        IndexedDB project save/load/list/delete
js/render.js         VexFlow rendering, layout/pagination, hit-testing
js/editor.js         insertion cursor, note entry, undo/redo history
js/pdf.js            SVG → vector PDF export
js/main.js           app bootstrap + UI wiring
```

The JS files are plain classic scripts that share a small `window.MN` namespace
(module pattern via IIFEs). This keeps a clean separation of concerns while
letting the app run directly from `file://`, where native ES-module imports are
blocked by the browser's CORS policy.

### Data model

```js
score   = { id, name, title, composer, tempo, timeSignature, staves[] }
staff   = { id, instrument, name, clef, keySignature, measures[] }
measure = { timeSignature?, keySignature?, notes[] }   // signatures inherited unless set
note    = { pitches[], duration, dots, tie, dynamic, notehead, lyric, chordSymbol }
pitch   = { letter:'A'..'G', octave, acc:'' | '#' | 'b' | 'n' | '##' | 'bb' | '+' | 'd' }
// A rest is a note with an empty pitches[] array.
```

## Libraries (via CDN)

- VexFlow 4.2.3 — notation rendering
- jsPDF 2.5.1 + svg2pdf.js 2.2.3 — vector PDF export
- idb-keyval 6.2.1 — IndexedDB persistence
