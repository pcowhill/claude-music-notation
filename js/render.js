// render.js
// Renders the score model to SVG via VexFlow. The render is a pure function of
// (score, editorState): it lays measures into systems, systems into US-Letter
// pages, and draws staves/notes/beams/ties/dynamics/measure-numbers/title. It
// also captures geometry (stave boxes + note x-positions) so the editor can map
// clicks to pitches/positions and place the blinking insertion cursor.
//
// The same layout+draw code serves both the on-screen view and the PDF export
// (pdf.js calls renderPagesToHosts with offscreen hosts), so what you see is
// what you print.

(function () {
'use strict';
const MN = (window.MN = window.MN || {});
const {
  effectiveTimeSignature, effectiveKeySignature, sortPitches, pitchToVexKey,
  topLineDiatonic, diatonicToPitch, durationBeats, measureCapacityBeats,
} = MN.model;

const VF = () => window.Vex.Flow;

// All geometry is in points (1pt == 1 user unit in the SVG viewBox). US Letter.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = { left: 50, right: 50, top: 54, bottom: 54 };
const TITLE_BLOCK_H = 78;     // reserved at the top of page 1 for title/composer
const STAFF_SLOT = 104;       // vertical space allotted to one staff (room for dynamics/lyrics)
const SYSTEM_GAP = 42;        // gap between systems
const STAFF_TOP_PAD = 22;     // space above a staff's top line (for ledger/measure #)
const MIN_CONTENT_W = 92;     // floor on a measure's content width (keeps sparse bars readable)
const NOTE_PAD = 26;          // padding added to a measure's measured min note width
const FIRST_MEASURE_EXTRA = 52; // extra width given to a system's first measure (clef/key)
const ACCENT = '#2563eb';

// Center / right-aligned line of text. Falls back to an estimate if the SVG
// context can't measure (keeps PDF export robust).
function textWidth(ctx, text, size) {
  try {
    const m = ctx.measureText(text);
    if (m && Number.isFinite(m.width) && m.width > 0) return m.width;
  } catch (e) { /* fall through */ }
  return text.length * size * 0.5;
}

// ---- Layout ---------------------------------------------------------------

// Minimum note-area width a measure needs, taken as the widest requirement
// across all staves (so multi-staff barlines stay aligned). Uses VexFlow's
// formatter pre-pass; falls back to the floor if VexFlow can't measure.
function measureContentWidth(score, globalM) {
  const Flow = VF();
  const ts = effectiveTimeSignature(score, globalM);
  let w = 0;
  for (let s = 0; s < score.staves.length; s++) {
    const staff = score.staves[s];
    const built = buildMeasure(staff.measures[globalM], staff.clef, ts, true);
    const voice = new Flow.Voice({ num_beats: ts.num, beat_value: ts.den }).setMode(Flow.Voice.Mode.SOFT);
    voice.addTickables(built.staveNotes);
    let vw;
    try {
      const f = new Flow.Formatter();
      f.joinVoices([voice]);
      vw = f.preCalculateMinTotalWidth([voice]);
    } catch (e) { vw = MIN_CONTENT_W; }
    if (vw > w) w = vw;
  }
  return Math.max(MIN_CONTENT_W, w + NOTE_PAD);
}

// Decide how measures pack into systems and systems into pages. Each measure is
// sized by its content's minimum width; measures are packed greedily by
// available width, then each system is justified to fill the page (wider bars
// get proportionally more space). Returns a plain object describing every page.
function computeLayout(score) {
  const contentW = PAGE_W - MARGIN.left - MARGIN.right;
  const numStaves = score.staves.length;
  const totalMeasures = score.staves[0] ? score.staves[0].measures.length : 0;
  const systemHeight = numStaves * STAFF_SLOT + SYSTEM_GAP;

  // 1) Content-driven minimum width for every measure.
  const minW = [];
  for (let m = 0; m < totalMeasures; m++) minW.push(measureContentWidth(score, m));

  // 2) Greedily pack measures into systems. The first measure of each system
  // reserves extra room for the clef/key signature.
  const rawSystems = [];
  let i = 0;
  while (i < totalMeasures) {
    let sum = FIRST_MEASURE_EXTRA;
    let count = 0;
    while (i + count < totalMeasures) {
      const add = minW[i + count];
      if (count > 0 && sum + add > contentW) break;
      sum += add;
      count++;
    }
    if (count === 0) count = 1; // a single oversized measure still gets its own system
    rawSystems.push({ start: i, count });
    i += count;
  }
  if (rawSystems.length === 0) rawSystems.push({ start: 0, count: 0 });

  // 3) Justify each system to fill the content width, distributing space in
  // proportion to each measure's minimum content width.
  rawSystems.forEach((sys) => {
    if (sys.count === 0) { sys.widths = [contentW]; sys.xs = [MARGIN.left]; return; }
    const mins = [];
    for (let j = 0; j < sys.count; j++) mins.push(minW[sys.start + j]);
    const totalMin = mins.reduce((a, b) => a + b, 0) + FIRST_MEASURE_EXTRA;
    const scale = contentW / totalMin;
    const widths = [];
    for (let j = 0; j < sys.count; j++) {
      const extra = j === 0 ? FIRST_MEASURE_EXTRA : 0;
      widths.push((mins[j] + extra) * scale);
    }
    const xs = [];
    let x = MARGIN.left;
    for (let j = 0; j < widths.length; j++) { xs.push(x); x += widths[j]; }
    sys.widths = widths;
    sys.xs = xs;
  });

  // 4) Paginate systems by available vertical space (page 1 reserves a title block).
  const pages = [];
  let cur = { systems: [] };
  let y = MARGIN.top + TITLE_BLOCK_H;
  rawSystems.forEach((sys) => {
    if (y + systemHeight > PAGE_H - MARGIN.bottom && cur.systems.length > 0) {
      pages.push(cur);
      cur = { systems: [] };
      y = MARGIN.top;
    }
    sys.yTop = y;
    cur.systems.push(sys);
    y += systemHeight;
  });
  pages.push(cur);

  return { pages, numStaves, systemHeight };
}

function staffY(systemYTop, staffIndex) {
  return systemYTop + staffIndex * STAFF_SLOT + STAFF_TOP_PAD;
}

// ---- Note building --------------------------------------------------------

const REST_KEY = { treble: 'b/4', bass: 'd/3', alto: 'c/4', tenor: 'a/3' };
const NOTEHEAD_SUFFIX = { x: 'x', d: 'd', t: 't', s: 's' };

function applyDots(staveNote, dots) {
  for (let i = 0; i < dots; i++) VF().Dot.buildAndAttach([staveNote], { all: true });
}

// Build one VexFlow StaveNote from a model note (rest if no pitches). Wrapped so
// an exotic option (e.g. a custom notehead) can never crash the whole render.
function buildStaveNote(note, clef, measuring) {
  const Flow = VF();
  if (!note.pitches || note.pitches.length === 0) {
    const sn = new Flow.StaveNote({ keys: [REST_KEY[clef] || 'b/4'], duration: note.duration + 'r', clef });
    applyDots(sn, note.dots);
    return sn;
  }
  const sorted = sortPitches(note.pitches);
  const useHead = note.notehead && note.notehead !== 'normal' && NOTEHEAD_SUFFIX[note.notehead];
  const keys = sorted.map((p) => pitchToVexKey(p) + (useHead ? '/' + NOTEHEAD_SUFFIX[note.notehead] : ''));
  // For width measurement we omit auto_stem: VexFlow's preCalculateMinTotalWidth
  // under-reports widths for auto-stemmed notes, so the plain form yields a safe
  // (slightly conservative) minimum for the layout pass.
  const opts = measuring ? {} : { auto_stem: true };
  let sn;
  try {
    sn = new Flow.StaveNote({ keys, duration: note.duration, clef, ...opts });
  } catch (e) {
    // Fall back to plain noteheads if a custom head code was rejected.
    sn = new Flow.StaveNote({ keys: sorted.map(pitchToVexKey), duration: note.duration, clef, ...opts });
  }
  sorted.forEach((p, i) => {
    if (p.acc && p.acc !== '') {
      try { sn.addModifier(new Flow.Accidental(p.acc), i); } catch (e) { /* skip bad acc */ }
    }
  });
  applyDots(sn, note.dots);
  return sn;
}

// Candidate rest values (largest first) for filling a partial measure, in units
// of a 32nd note (1 quarter-note beat = 8 units).
const FILL_CANDIDATES = [
  { duration: 'w',  dots: 0, u: 32 },
  { duration: 'h',  dots: 1, u: 24 },
  { duration: 'h',  dots: 0, u: 16 },
  { duration: 'q',  dots: 1, u: 12 },
  { duration: 'q',  dots: 0, u: 8 },
  { duration: '8',  dots: 1, u: 6 },
  { duration: '8',  dots: 0, u: 4 },
  { duration: '16', dots: 1, u: 3 },
  { duration: '16', dots: 0, u: 2 },
  { duration: '32', dots: 0, u: 1 },
];

// Break a remaining duration (in quarter-note beats, beginning at `startBeat`)
// into display rests, greedily largest-first but not crossing a quarter-note
// boundary unless already aligned to one. Pure; display-only.
function fillerRests(remainingBeats, startBeat) {
  const U = 8;
  let pos = Math.round(startBeat * U);
  let rem = Math.round(remainingBeats * U);
  const out = [];
  let guard = 0;
  while (rem > 0 && guard++ < 256) {
    const toBeat = (U - (pos % U)) % U; // units until the next quarter boundary (0 if on one)
    const cand = FILL_CANDIDATES.find((c) => c.u <= rem && (toBeat === 0 || c.u <= toBeat));
    if (!cand) break;
    out.push({ duration: cand.duration, dots: cand.dots });
    pos += cand.u;
    rem -= cand.u;
  }
  return out;
}

// Build the StaveNotes for a measure. Empty measures render as a single whole
// rest. Partially filled measures get DISPLAY-ONLY trailing rests appended after
// the real notes (never stored in the model). `realCount` tells callers how many
// leading staveNotes correspond to real model notes.
function buildMeasure(measure, clef, ts, measuring) {
  const Flow = VF();
  if (!measure.notes || measure.notes.length === 0) {
    const rest = new Flow.StaveNote({ keys: [REST_KEY[clef] || 'b/4'], duration: 'wr', clef });
    return { staveNotes: [rest], modelNotes: [null], isEmpty: true, realCount: 0 };
  }
  const staveNotes = measure.notes.map((n) => buildStaveNote(n, clef, measuring));
  const modelNotes = measure.notes.slice();
  const realCount = measure.notes.length;

  if (ts) {
    const used = measure.notes.reduce((s, n) => s + durationBeats(n.duration, n.dots), 0);
    const remaining = measureCapacityBeats(ts) - used;
    if (remaining > 1e-6) {
      fillerRests(remaining, used).forEach((fr) => {
        const sn = new Flow.StaveNote({ keys: [REST_KEY[clef] || 'b/4'], duration: fr.duration + 'r', clef });
        applyDots(sn, fr.dots);
        staveNotes.push(sn);
        modelNotes.push(null);
      });
    }
  }
  return { staveNotes, modelNotes, isEmpty: false, realCount };
}

function beamGroupsForTime(ts) {
  const Flow = VF();
  if (ts.den === 8 && ts.num % 3 === 0) return [new Flow.Fraction(3, 8)];
  return [new Flow.Fraction(1, 4)];
}

// ---- Drawing helpers ------------------------------------------------------

// Note: font families are kept to jsPDF's built-ins ('times'/'helvetica') so the
// SVG <text> we emit converts cleanly to vector text in the PDF export.
function drawHeader(ctx, score) {
  const cx = PAGE_W / 2;
  ctx.save();
  if (score.title) {
    ctx.setFont('times', 22, 'bold');
    ctx.setFillStyle('#111827');
    const w = textWidth(ctx, score.title, 22);
    ctx.fillText(score.title, cx - w / 2, MARGIN.top + 22);
  }
  if (score.composer) {
    ctx.setFont('times', 12.5, 'normal', 'italic');
    ctx.setFillStyle('#374151');
    const w = textWidth(ctx, score.composer, 12.5);
    ctx.fillText(score.composer, PAGE_W - MARGIN.right - w, MARGIN.top + 52);
  }
  if (score.tempo) {
    ctx.setFont('times', 11, 'bold');
    ctx.setFillStyle('#374151');
    ctx.fillText(`♩ = ${score.tempo}`, MARGIN.left, MARGIN.top + 52);
  }
  ctx.restore();
}

function drawFooter(ctx, pageIndex, pageCount) {
  ctx.save();
  ctx.setFont('helvetica', 9, 'normal');
  ctx.setFillStyle('#9ca3af');
  const label = `${pageIndex + 1} / ${pageCount}`;
  const w = textWidth(ctx, label, 9);
  ctx.fillText(label, PAGE_W / 2 - w / 2, PAGE_H - 26);
  ctx.restore();
}

function drawMeasureNumber(ctx, num, x, topLineY) {
  ctx.save();
  ctx.setFont('helvetica', 9, 'normal');
  ctx.setFillStyle('#9ca3af');
  ctx.fillText(String(num), x + 1, topLineY - 6);
  ctx.restore();
}

function drawDynamic(ctx, text, x, bottomLineY) {
  ctx.save();
  ctx.setFont('times', 13, 'bold', 'italic');
  ctx.setFillStyle('#111827');
  ctx.fillText(text, x - 4, bottomLineY + 26);
  ctx.restore();
}

function drawLyric(ctx, text, x, bottomLineY) {
  ctx.save();
  ctx.setFont('times', 11, 'normal');
  ctx.setFillStyle('#1f2430');
  const w = textWidth(ctx, text, 11);
  ctx.fillText(text, x - w / 2, bottomLineY + 42);
  ctx.restore();
}

function drawChordSymbol(ctx, text, x, topLineY) {
  ctx.save();
  ctx.setFont('helvetica', 11.5, 'bold');
  ctx.setFillStyle('#1f2430');
  ctx.fillText(text, x - 3, topLineY - 16);
  ctx.restore();
}

// ---- System drawing -------------------------------------------------------

function drawSystem(ctx, score, system, pageIndex, isFirstSystemOfPiece, layout, editorState, out) {
  const Flow = VF();
  const numStaves = score.staves.length;
  const totalMeasures = score.staves[0].measures.length;
  // staves2d[staffIndex][col] -> { stave, globalM, clef }
  const staves2d = [];

  for (let s = 0; s < numStaves; s++) {
    const staff = score.staves[s];
    const row = [];
    for (let col = 0; col < system.count; col++) {
      const globalM = system.start + col;
      const measure = staff.measures[globalM];
      const x = system.xs[col];
      const w = system.widths[col];
      const y = staffY(system.yTop, s);
      const stave = new Flow.Stave(x, y, w);
      const ts = effectiveTimeSignature(score, globalM);
      const key = effectiveKeySignature(staff, globalM);

      if (col === 0) {
        stave.addClef(staff.clef);
        if (key && key !== 'C') stave.addKeySignature(key);
        // Time signature shows at the very start, or wherever it explicitly changes.
        if (isFirstSystemOfPiece || measure.timeSignature) stave.addTimeSignature(`${ts.num}/${ts.den}`);
      } else {
        // Mid-score signature changes (Tier 2): show them where they occur.
        if (measure.keySignature) stave.addKeySignature(measure.keySignature);
        if (measure.timeSignature) stave.addTimeSignature(`${ts.num}/${ts.den}`);
      }
      // Final barline on the very last measure of the piece.
      if (globalM === totalMeasures - 1) stave.setEndBarType(Flow.Barline.type.END);

      stave.setContext(ctx).draw();
      row.push({ stave, globalM, clef: staff.clef, x, w, staffIndex: s, key });
    }
    staves2d.push(row);
  }

  // Connect multi-staff systems with a bracket + left/right system lines.
  if (numStaves > 1 && system.count > 0) {
    const top = staves2d[0][0].stave;
    const bottom = staves2d[numStaves - 1][0].stave;
    new Flow.StaveConnector(top, bottom).setType(Flow.StaveConnector.type.BRACKET).setContext(ctx).draw();
    new Flow.StaveConnector(top, bottom).setType(Flow.StaveConnector.type.SINGLE_LEFT).setContext(ctx).draw();
    const topR = staves2d[0][system.count - 1].stave;
    const botR = staves2d[numStaves - 1][system.count - 1].stave;
    new Flow.StaveConnector(topR, botR).setType(Flow.StaveConnector.type.SINGLE_RIGHT).setContext(ctx).draw();
  }

  // Per staff, accumulate ordered notes for ties drawn after the whole system.
  const tieChains = score.staves.map(() => []);

  for (let col = 0; col < system.count; col++) {
    const globalM = system.start + col;
    const ts = effectiveTimeSignature(score, globalM);
    const built = [];
    const voices = [];

    for (let s = 0; s < numStaves; s++) {
      const cell = staves2d[s][col];
      const measure = score.staves[s].measures[globalM];
      const b = buildMeasure(measure, cell.clef, ts);
      const voice = new Flow.Voice({ num_beats: ts.num, beat_value: ts.den }).setMode(Flow.Voice.Mode.SOFT);
      voice.addTickables(b.staveNotes);

      // Highlight the editor's target note in accent colour.
      if (editorState.target && editorState.target.staffIndex === s
          && editorState.target.measureIndex === globalM && !b.isEmpty) {
        const tn = b.staveNotes[editorState.target.noteIndex];
        if (tn) tn.setStyle({ fillStyle: ACCENT, strokeStyle: ACCENT });
      }

      built.push({ b, cell, staffIndex: s });
      voices.push(voice);
    }

    // Format all of this column's voices together against the most-constrained
    // stave so notes align vertically and clear the clef/key area. When every
    // staff's measure is empty (a lone centered whole rest), VexFlow's formatter
    // drops all but one rest if they share a tick context, so format those
    // independently — there is nothing to align anyway.
    const allEmpty = built.every((x) => x.b.isEmpty);
    if (allEmpty) {
      for (let s = 0; s < numStaves; s++) {
        new Flow.Formatter().joinVoices([voices[s]]).formatToStave([voices[s]], staves2d[s][col].stave);
      }
    } else {
      let ref = staves2d[0][col].stave;
      let refStart = -Infinity;
      for (let s = 0; s < numStaves; s++) {
        const st = staves2d[s][col].stave.getNoteStartX();
        if (st > refStart) { refStart = st; ref = staves2d[s][col].stave; }
      }
      new Flow.Formatter().joinVoices(voices).formatToStave(voices, ref);
    }

    // Draw voices + beams, capture geometry, draw dynamics.
    for (let s = 0; s < numStaves; s++) {
      const cell = staves2d[s][col];
      const b = built[s].b;
      const voice = voices[s];
      const beams = b.isEmpty ? [] : Flow.Beam.generateBeams(b.staveNotes, {
        groups: beamGroupsForTime(ts), maintain_stem_directions: false,
      });
      voice.draw(ctx, cell.stave);
      beams.forEach((bm) => bm.setContext(ctx).draw());

      // Stave geometry box for hit-testing.
      const topLineY = cell.stave.getYForLine(0);
      const bottomLineY = cell.stave.getYForLine(4);
      const lineSpacing = cell.stave.getSpacingBetweenLines();
      const slots = [];
      if (!b.isEmpty) {
        // Only real (model) notes get slots; trailing display rests are skipped
        // so the cursor and click-to-place stay anchored to real content.
        b.staveNotes.forEach((sn, idx) => {
          if (idx < b.realCount) slots.push({ noteIndex: idx, x: sn.getAbsoluteX() });
        });
      }
      out.staveBoxes.push({
        pageIndex, staffIndex: s, globalMeasureIndex: globalM,
        x: cell.x, endX: cell.x + cell.w, noteStartX: cell.stave.getNoteStartX(),
        topLineY, bottomLineY, lineSpacing, clef: cell.clef,
        topLineDiatonic: topLineDiatonic(cell.clef), slots, isEmpty: b.isEmpty,
      });

      // Measure number above the top staff (measure 1 is conventionally implied).
      if (s === 0 && globalM > 0) drawMeasureNumber(ctx, globalM + 1, cell.x, topLineY);

      // Dynamics / lyrics / chord symbols, aligned to their note.
      if (!b.isEmpty) {
        b.modelNotes.forEach((mn, idx) => {
          if (!mn) return;
          const nx = b.staveNotes[idx].getAbsoluteX();
          if (mn.dynamic) drawDynamic(ctx, mn.dynamic, nx, bottomLineY);
          if (mn.lyric) drawLyric(ctx, mn.lyric, nx, bottomLineY);
          if (mn.chordSymbol) drawChordSymbol(ctx, mn.chordSymbol, nx, topLineY);
          tieChains[s].push({ modelNote: mn, staveNote: b.staveNotes[idx] });
        });
      }

      // Cursor position, if the cursor lives in this staff/measure.
      const cur = editorState.cursor;
      if (editorState.showCursor !== false && cur && cur.staffIndex === s && cur.measureIndex === globalM) {
        let cx;
        if (b.isEmpty || slots.length === 0) {
          cx = cell.stave.getNoteStartX() + 4;
        } else if (cur.noteIndex < slots.length) {
          cx = slots[cur.noteIndex].x - 7;
        } else {
          cx = slots[slots.length - 1].x + 16;
        }
        out.cursor = {
          pageIndex, x: cx, y: topLineY - 14,
          w: 2.4, h: lineSpacing * 4 + 28,
        };
      }
    }
  }

  // Ties: connect any note flagged tie=true to its predecessor within this system.
  tieChains.forEach((chain) => {
    for (let k = 1; k < chain.length; k++) {
      if (chain[k].modelNote && chain[k].modelNote.tie) {
        const first = chain[k - 1].staveNote;
        const last = chain[k].staveNote;
        if (!first || !last) continue;
        try {
          new Flow.StaveTie({
            first_note: first, last_note: last,
            first_indices: [0], last_indices: [0],
          }).setContext(ctx).draw();
        } catch (e) { /* ignore unjoinable tie */ }
      }
    }
  });
}

// ---- Page drawing ---------------------------------------------------------

function drawPage(ctx, score, page, pageIndex, pageCount, layout, editorState, out) {
  if (pageIndex === 0) drawHeader(ctx, score);
  page.systems.forEach((system, sysIdx) => {
    const isFirst = pageIndex === 0 && sysIdx === 0;
    drawSystem(ctx, score, system, pageIndex, isFirst, layout, editorState, out);
  });
  drawFooter(ctx, pageIndex, pageCount);
}

// Append the blinking insertion-cursor rectangle as a real SVG element so CSS
// can animate it without a re-render.
function appendCursor(svg, cursor) {
  const NS = 'http://www.w3.org/2000/svg';
  const rect = document.createElementNS(NS, 'rect');
  rect.setAttribute('x', cursor.x);
  rect.setAttribute('y', cursor.y);
  rect.setAttribute('width', cursor.w);
  rect.setAttribute('height', cursor.h);
  rect.setAttribute('rx', '1');
  rect.setAttribute('class', 'cursor-bar');
  svg.appendChild(rect);
}

// ---- Public API -----------------------------------------------------------

// Draw the score into a list of host elements (one per page). Creates hosts as
// needed inside `container`. Returns the layout + captured geometry.
function renderScore(container, score, editorState) {
  const Flow = VF();
  const layout = computeLayout(score);
  const out = { staveBoxes: [], cursor: null, pageCount: layout.pages.length };

  container.innerHTML = '';
  layout.pages.forEach((page, pageIndex) => {
    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    const host = document.createElement('div');
    host.className = 'page-host';
    pageEl.appendChild(host);
    container.appendChild(pageEl);

    const renderer = new Flow.Renderer(host, Flow.Renderer.Backends.SVG);
    renderer.resize(PAGE_W, PAGE_H);
    const ctx = renderer.getContext();
    drawPage(ctx, score, page, pageIndex, layout.pages.length, layout, editorState, out);

    const svg = host.querySelector('svg');
    svg.setAttribute('viewBox', `0 0 ${PAGE_W} ${PAGE_H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.classList.add('score-svg');
    svg.dataset.pageIndex = String(pageIndex);
    if (out.cursor && out.cursor.pageIndex === pageIndex) appendCursor(svg, out.cursor);
  });

  return { ...layout, ...out };
}

// Render every page into its own detached SVG sized to US Letter, for PDF
// export. Returns an array of SVG elements (caller owns/destroys them).
function renderPagesForPDF(score) {
  const Flow = VF();
  const layout = computeLayout(score);
  const editorState = { cursor: null, target: null, showCursor: false };
  const svgs = [];
  layout.pages.forEach((page, pageIndex) => {
    const host = document.createElement('div');
    host.style.position = 'absolute';
    host.style.left = '-99999px';
    host.style.top = '0';
    document.body.appendChild(host);
    const renderer = new Flow.Renderer(host, Flow.Renderer.Backends.SVG);
    renderer.resize(PAGE_W, PAGE_H);
    const ctx = renderer.getContext();
    const out = { staveBoxes: [], cursor: null };
    drawPage(ctx, score, page, pageIndex, layout.pages.length, layout, editorState, out);
    const svg = host.querySelector('svg');
    svg.setAttribute('viewBox', `0 0 ${PAGE_W} ${PAGE_H}`);
    svg.setAttribute('width', PAGE_W);
    svg.setAttribute('height', PAGE_H);
    svgs.push({ svg, host });
  });
  return svgs;
}

// Map a click within a page (in SVG/viewBox coordinates) to a musical location.
// Returns { staffIndex, measureIndex, slot, pitch, nearestNoteIndex, nearestDist }.
function hitTest(layout, pageIndex, x, y) {
  const boxes = layout.staveBoxes.filter(
    (b) => b.pageIndex === pageIndex && x >= b.x - 3 && x <= b.endX + 3
  );
  if (boxes.length === 0) return null;

  // Choose the staff whose vertical centre is closest to the click.
  let best = null;
  let bestDist = Infinity;
  for (const b of boxes) {
    const center = b.topLineY + 2 * b.lineSpacing;
    const d = Math.abs(y - center);
    if (d < bestDist) { bestDist = d; best = b; }
  }
  if (!best) return null;

  // Pitch from the vertical position (half a line spacing per diatonic step).
  const stepsFromTop = Math.round((y - best.topLineY) / (best.lineSpacing / 2));
  const pitch = diatonicToPitch(best.topLineDiatonic - stepsFromTop, '');

  // Insertion slot = number of existing notes to the left of the click.
  let slot = 0;
  let nearestNoteIndex = null;
  let nearestDist = Infinity;
  for (const s of best.slots) {
    if (x > s.x) slot = s.noteIndex + 1;
    const d = Math.abs(x - s.x);
    if (d < nearestDist) { nearestDist = d; nearestNoteIndex = s.noteIndex; }
  }
  return {
    staffIndex: best.staffIndex,
    measureIndex: best.globalMeasureIndex,
    slot, pitch, nearestNoteIndex, nearestDist,
  };
}

MN.render = { renderScore, renderPagesForPDF, hitTest, PAGE_W, PAGE_H };
})();
