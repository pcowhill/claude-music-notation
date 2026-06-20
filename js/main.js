// main.js
// App bootstrap + all UI wiring. Owns the Editor instance, builds the toolbar
// palettes and side-panel controls, routes keyboard/mouse input into the editor,
// renders on every change, and drives autosave + the project manager + PDF export.

(function () {
'use strict';
const MN = window.MN;
const {
  createScore, DURATIONS, ACCIDENTALS_BASIC, DYNAMICS, NOTEHEADS, KEY_SIGNATURES,
  TIME_NUMERATORS, TIME_DENOMINATORS, effectiveTimeSignature, effectiveKeySignature,
  durationBeats, measureCapacityBeats, pitchToLabel, buildPlayback, cursorStartBeat,
} = MN.model;
const { INSTRUMENTS } = MN.instruments;
const Editor = MN.Editor;
const { renderScore, hitTest } = MN.render;
const { exportPDF, buildPDF } = MN.pdf;
const { resumeAudio, startPlayback, stopPlayback } = MN.audio;
const {
  listProjects, loadProject, saveProject, deleteProject, renameProject,
  duplicateProject, setLastOpened, getLastOpened,
} = MN.storage;

const $ = (sel) => document.querySelector(sel);
const scoreEl = $('#score');

let editor = null;
let layout = null;
let lastStaffCount = -1;
let saveTimer = null;
// Playback state. `playbackActive` toggles the Play/Stop button; `playingMarks`
// is the transient "playing" highlight passed into the render editorState (never
// committed — no undo entries, no autosave churn).
let playbackActive = false;
let playingMarks = null;

// ---- Small DOM helpers -----------------------------------------------------
function setValIfBlur(el, val) {
  if (el && document.activeElement !== el && String(el.value) !== String(val)) el.value = val;
}
function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden', 'fade');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.classList.add('fade'); setTimeout(() => hide(t), 320); }, 1700);
}
// Mild, auto-clearing message for soft-blocked actions (e.g. a full bar). Shows
// briefly in the status bar and as a toast, then the next render restores status.
function notice(msg) {
  const el = $('#status-pos');
  if (el) el.textContent = msg;
  toast(msg);
}

// ---- Duration icons (inline SVG so they print/scale crisply) --------------
function noteIcon(code) {
  const filled = code !== 'w' && code !== 'h';
  const hasStem = code !== 'w';
  const flags = { '8': 1, '16': 2, '32': 3 }[code] || 0;
  let s = `<svg width="16" height="26" viewBox="0 0 16 26" aria-hidden="true">`;
  s += `<ellipse cx="6" cy="19" rx="4.5" ry="3.2" transform="rotate(-22 6 19)" `
     + `fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.3"/>`;
  if (hasStem) s += `<line x1="10.1" y1="18.2" x2="10.1" y2="3.5" stroke="currentColor" stroke-width="1.3"/>`;
  for (let i = 0; i < flags; i++) {
    const y = 3.8 + i * 4.2;
    s += `<path d="M10.1 ${y} q4.6 1.8 3.8 6.4" fill="none" stroke="currentColor" stroke-width="1.5"/>`;
  }
  return s + `</svg>`;
}

// ---- Build toolbar palettes ------------------------------------------------
function buildPalettes() {
  const dur = $('#dur-group');
  dur.innerHTML = '';
  DURATIONS.forEach((d, i) => {
    const b = document.createElement('button');
    b.className = 'palette-btn';
    b.dataset.duration = d.code;
    b.title = `${d.label} (${i + 1})`;
    b.innerHTML = noteIcon(d.code);
    b.addEventListener('click', () => { editor.setDuration(d.code); scoreEl.focus(); });
    dur.appendChild(b);
  });

  const acc = $('#acc-group');
  acc.innerHTML = '';
  ACCIDENTALS_BASIC.forEach((a) => {
    const b = document.createElement('button');
    b.className = 'palette-btn';
    b.dataset.acc = a.code;
    b.title = a.title;
    b.textContent = a.label;
    b.addEventListener('click', () => { editor.setAccidental(a.code); scoreEl.focus(); });
    acc.appendChild(b);
  });

  const dyn = $('#dyn-group');
  dyn.innerHTML = '';
  DYNAMICS.forEach((d) => {
    const b = document.createElement('button');
    b.className = 'palette-btn';
    b.dataset.dyn = d;
    b.title = `Dynamic ${d}`;
    b.textContent = d;
    b.addEventListener('click', () => { editor.setDynamic(d); scoreEl.focus(); });
    dyn.appendChild(b);
  });
}

// ---- Build side-panel selects ---------------------------------------------
function fillInstrumentSelect(sel) {
  sel.innerHTML = '';
  const groups = {};
  INSTRUMENTS.forEach((i) => { (groups[i.group] = groups[i.group] || []).push(i); });
  Object.keys(groups).forEach((g) => {
    const og = document.createElement('optgroup');
    og.label = g;
    groups[g].forEach((i) => {
      const o = document.createElement('option');
      o.value = i.name; o.textContent = i.name;
      og.appendChild(o);
    });
    sel.appendChild(og);
  });
}
function fillSelect(sel, values, labels) {
  sel.innerHTML = '';
  values.forEach((v, i) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = labels ? labels[i] : v;
    sel.appendChild(o);
  });
}
function fillKeySelect(sel) {
  sel.innerHTML = '';
  KEY_SIGNATURES.forEach((k) => {
    const o = document.createElement('option');
    o.value = k.value; o.textContent = k.label;
    sel.appendChild(o);
  });
}

function buildSelectors() {
  fillInstrumentSelect($('#add-instr'));
  fillSelect($('#f-time-num'), TIME_NUMERATORS);
  fillSelect($('#f-time-den'), TIME_DENOMINATORS);
  fillSelect($('#f-midtime-num'), TIME_NUMERATORS);
  fillSelect($('#f-midtime-den'), TIME_DENOMINATORS);
  fillKeySelect($('#f-midkey'));
  fillSelect($('#f-notehead'), NOTEHEADS.map((n) => n.code), NOTEHEADS.map((n) => n.label));
}

// ---- Staff list (rebuilt only when staff count changes) -------------------
function buildStaffList() {
  const wrap = $('#staff-list');
  wrap.innerHTML = '';
  editor.score.staves.forEach((staff, idx) => {
    const row = document.createElement('div');
    row.className = 'staff-row' + (idx === editor.cursor.staffIndex ? ' current' : '');

    const head = document.createElement('div');
    head.className = 'staff-row-head';
    const name = document.createElement('input');
    name.type = 'text'; name.className = 's-name'; name.value = staff.name;
    name.addEventListener('change', () => editor.setStaffName(idx, name.value));
    name.addEventListener('focus', () => editor.setCursor(idx, editor.cursor.measureIndex, 0));
    const del = document.createElement('button');
    del.className = 'staff-del'; del.textContent = '×'; del.title = 'Remove staff';
    del.addEventListener('click', () => {
      if (editor.score.staves.length <= 1) { toast('At least one staff is required.'); return; }
      editor.removeStaff(idx);
    });
    head.appendChild(name); head.appendChild(del);

    const grid = document.createElement('div');
    grid.className = 'grid2';
    const instr = document.createElement('select');
    instr.className = 's-instr'; fillInstrumentSelect(instr); instr.value = staff.instrument;
    instr.addEventListener('change', () => editor.setInstrument(idx, instr.value));
    const clef = document.createElement('select');
    clef.className = 's-clef';
    fillSelect(clef, ['treble', 'bass', 'alto', 'tenor'], ['Treble', 'Bass', 'Alto', 'Tenor']);
    clef.value = staff.clef;
    clef.addEventListener('change', () => editor.setClef(idx, clef.value));
    const key = document.createElement('select');
    key.className = 's-key'; fillKeySelect(key); key.value = staff.keySignature;
    key.addEventListener('change', () => editor.setKeySignature(idx, key.value));

    const lInstr = labelWrap('Instrument', instr);
    const lClef = labelWrap('Clef', clef);
    const lKey = labelWrap('Key', key);
    grid.appendChild(lInstr); grid.appendChild(lClef);
    row.appendChild(head); row.appendChild(grid); row.appendChild(lKey);
    wrap.appendChild(row);
  });
}
function labelWrap(text, el) {
  const l = document.createElement('label');
  l.textContent = text; l.appendChild(el);
  return l;
}
function updateStaffList() {
  if (editor.score.staves.length !== lastStaffCount) {
    buildStaffList();
    lastStaffCount = editor.score.staves.length;
    return;
  }
  const rows = $('#staff-list').children;
  editor.score.staves.forEach((staff, idx) => {
    const row = rows[idx];
    if (!row) return;
    row.classList.toggle('current', idx === editor.cursor.staffIndex);
    setValIfBlur(row.querySelector('.s-name'), staff.name);
    setValIfBlur(row.querySelector('.s-instr'), staff.instrument);
    setValIfBlur(row.querySelector('.s-clef'), staff.clef);
    setValIfBlur(row.querySelector('.s-key'), staff.keySignature);
  });
}

// ---- Render + UI sync ------------------------------------------------------
// onChange runs after every editor mutation/navigation. Any such change ends
// playback (the user is editing or navigating), then re-renders the full UI.
function onChange() {
  if (playbackActive) resetPlaybackState(); // render() below clears the highlight
  render();
}

// Editor state + the transient playback highlight (not part of the model).
function editorStateForRender() {
  const es = editor.editorState();
  es.playing = playingMarks;
  return es;
}

function render() {
  layout = renderScore(scoreEl, editor.score, editorStateForRender());
  updateToolbarState();
  updateSidePanel();
  updateStatus();
  scheduleAutosave();
}

// Lightweight re-render for the moving playhead: only the score SVG, no side
// panel rebuild and no autosave scheduling (playback must not churn saves).
function renderScoreOnly() {
  layout = renderScore(scoreEl, editor.score, editorStateForRender());
}

// ---- Playback --------------------------------------------------------------
function updatePlayButton() {
  const b = $('#btn-play');
  if (!b) return;
  b.textContent = playbackActive ? '■ Stop' : '▶ Play';
  b.classList.toggle('active', playbackActive);
  b.title = playbackActive
    ? 'Stop playback (Space)'
    : 'Play from start  ·  Ctrl/Cmd-click: play from cursor  ·  Space: play/stop';
}

// Start whole-score playback. `fromCursor` plays from the cursor to the end;
// otherwise from the beginning. Audio + the moving playhead are driven by the
// scheduler in audio.js; the highlight is fed in via editorState (never committed).
function startPlaybackUI(fromCursor) {
  if (playbackActive) return;
  const startBeat = fromCursor ? cursorStartBeat(editor.score, editor.cursor) : 0;
  const plan = buildPlayback(editor.score, startBeat);
  if (!plan.steps.length) { toast('Nothing to play'); return; }
  playbackActive = true;
  playingMarks = null;
  updatePlayButton();
  const started = startPlayback(plan, {
    onStep: (marks) => { playingMarks = marks; renderScoreOnly(); },
    onEnd: () => { stopPlaybackUI(); },
  });
  if (!started) stopPlaybackUI();
}

// Halt audio + clear playback flags/highlight and refresh the button. No render.
function resetPlaybackState() {
  stopPlayback();
  playbackActive = false;
  playingMarks = null;
  updatePlayButton();
}

// Stop playback and refresh the score so the playhead highlight disappears.
// Used by the Stop button, Space, the natural end-of-score, and on edit/nav.
function stopPlaybackUI() {
  const wasActive = playbackActive || playingMarks !== null;
  resetPlaybackState();
  if (wasActive) renderScoreOnly();
}

function targetUniformAcc() {
  const n = editor.targetNote();
  if (!n || !n.pitches.length) return null;
  const a = n.pitches[0].acc;
  return n.pitches.every((p) => p.acc === a) ? a : null;
}

function updateToolbarState() {
  const inp = editor.input;
  document.querySelectorAll('#dur-group .palette-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.duration === inp.duration);
  });
  $('#btn-dot').classList.toggle('active', inp.dots > 0);
  $('#btn-rest').classList.toggle('active', inp.isRest);
  const target = editor.targetNote();
  $('#btn-tie').classList.toggle('active', inp.tieNext || (target && target.tie));

  const acc = targetUniformAcc();
  document.querySelectorAll('#acc-group .palette-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.acc === acc);
  });
  const dyn = target ? target.dynamic : '';
  document.querySelectorAll('#dyn-group .palette-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.dyn === dyn && dyn);
  });

  $('#btn-undo').disabled = !editor.canUndo;
  $('#btn-redo').disabled = !editor.canRedo;
}

function updateSidePanel() {
  const sc = editor.score;
  setValIfBlur($('#f-name'), sc.name);
  setValIfBlur($('#f-title'), sc.title);
  setValIfBlur($('#f-composer'), sc.composer);
  setValIfBlur($('#f-tempo'), sc.tempo);
  const ts = effectiveTimeSignature(sc, 0);
  setValIfBlur($('#f-time-num'), ts.num);
  setValIfBlur($('#f-time-den'), ts.den);

  $('#staff-count').textContent = `${sc.staves.length} ${sc.staves.length === 1 ? 'staff' : 'staves'}`;
  $('#measure-count').textContent = `${sc.staves[0].measures.length} bars`;
  updateStaffList();

  // Tier-2 controls reflect the selected note / cursor measure.
  const target = editor.targetNote();
  setValIfBlur($('#f-notehead'), target ? target.notehead : 'normal');
  setValIfBlur($('#f-lyric'), target ? target.lyric : '');
  setValIfBlur($('#f-chordsym'), target ? target.chordSymbol : '');
  const curStaff = sc.staves[editor.cursor.staffIndex];
  setValIfBlur($('#f-midkey'), effectiveKeySignature(curStaff, editor.cursor.measureIndex));
  const mts = effectiveTimeSignature(sc, editor.cursor.measureIndex);
  setValIfBlur($('#f-midtime-num'), mts.num);
  setValIfBlur($('#f-midtime-den'), mts.den);
}

function updateStatus() {
  const c = editor.cursor;
  const m = editor.curMeasure();
  let beat = 1;
  for (let i = 0; i < c.noteIndex && i < m.notes.length; i++) beat += durationBeats(m.notes[i].duration, m.notes[i].dots);
  const target = editor.targetNote();
  const pitchLbl = target && target.pitches.length
    ? target.pitches.map(pitchToLabel).join(' ')
    : (target ? 'rest' : '—');
  const capacity = measureCapacityBeats(effectiveTimeSignature(editor.score, c.measureIndex));
  $('#status-pos').textContent =
    `Staff ${c.staffIndex + 1} · Bar ${c.measureIndex + 1} · Beat ${(+beat.toFixed(2))}/${capacity} · ${pitchLbl}`;
  const durName = (DURATIONS.find((d) => d.code === editor.input.duration) || {}).label || '';
  $('#status-input').textContent = `Input: ${durName}${editor.input.dots ? ' dotted' : ''}${editor.input.isRest ? ' rest' : ''}`;
}

// ---- Autosave --------------------------------------------------------------
function setSaveStatus(state, text) {
  const el = $('#status-save');
  el.classList.remove('saving', 'saved');
  if (state) el.classList.add(state);
  el.textContent = text;
}
function scheduleAutosave() {
  setSaveStatus('saving', 'Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 800);
}
async function saveNow() {
  clearTimeout(saveTimer);
  try {
    await saveProject(editor.score);
    const t = new Date();
    setSaveStatus('saved', `Saved ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
  } catch (e) {
    console.error(e);
    setSaveStatus(null, 'Save failed');
  }
}

// ---- Project management ----------------------------------------------------
function openScore(score) {
  editor.replaceScore(score);
  setLastOpened(score.id);
  lastStaffCount = -1; // force staff list rebuild
  render();
  scoreEl.focus();
}
async function newProject(name) {
  const sc = createScore({ name: name || 'Untitled Score', title: name || 'Untitled Score' });
  try { await saveProject(sc); } catch (e) { console.error(e); }
  openScore(sc);
  toast('Created new project');
}

async function refreshProjectList() {
  const list = $('#project-list');
  let items = [];
  try { items = await listProjects(); } catch (e) { list.innerHTML = '<div class="muted">Storage unavailable.</div>'; return; }
  list.innerHTML = '';
  if (items.length === 0) { list.innerHTML = '<div class="muted">No saved projects yet.</div>'; return; }
  items.forEach((it) => {
    const row = document.createElement('div');
    row.className = 'proj-item' + (editor && it.id === editor.score.id ? ' current' : '');
    const info = document.createElement('div');
    info.className = 'proj-info';
    const updated = it.updatedAt ? new Date(it.updatedAt).toLocaleString() : '';
    info.innerHTML = `<div class="proj-name"></div><div class="proj-meta"></div>`;
    info.querySelector('.proj-name').textContent = it.name;
    info.querySelector('.proj-meta').textContent =
      `${it.staffCount} staff · updated ${updated}`;
    const actions = document.createElement('div');
    actions.className = 'proj-actions';
    actions.appendChild(mkBtn('Open', 'primary', async () => {
      const sc = await loadProject(it.id);
      if (sc) { openScore(sc); hide($('#project-modal')); }
    }));
    actions.appendChild(mkBtn('Rename', '', async () => {
      const n = prompt('Rename project', it.name);
      if (n && n.trim()) {
        await renameProject(it.id, n.trim());
        if (editor.score.id === it.id) { editor.score.name = n.trim(); render(); }
        refreshProjectList();
      }
    }));
    actions.appendChild(mkBtn('Duplicate', '', async () => {
      await duplicateProject(it.id);
      refreshProjectList();
      toast('Duplicated');
    }));
    actions.appendChild(mkBtn('Delete', 'danger', async () => {
      if (!confirm(`Delete "${it.name}"? This cannot be undone.`)) return;
      await deleteProject(it.id);
      if (editor.score.id === it.id) {
        const remaining = await listProjects();
        if (remaining.length) { const sc = await loadProject(remaining[0].id); openScore(sc); }
        else { await newProject('Untitled Score'); }
      }
      refreshProjectList();
    }));
    row.appendChild(info); row.appendChild(actions);
    list.appendChild(row);
  });
}
function mkBtn(text, cls, fn) {
  const b = document.createElement('button');
  b.className = 'btn-sm' + (cls ? ' ' + cls : '');
  b.textContent = text;
  b.addEventListener('click', fn);
  return b;
}

// ---- Wiring ---------------------------------------------------------------
function wireToolbar() {
  $('#btn-new').addEventListener('click', () => newProject('Untitled Score'));
  $('#btn-save').addEventListener('click', () => { saveNow(); toast('Saved'); });
  $('#btn-undo').addEventListener('click', () => editor.undo());
  $('#btn-redo').addEventListener('click', () => editor.redo());
  $('#btn-dot').addEventListener('click', () => { editor.toggleDot(); scoreEl.focus(); });
  $('#btn-rest').addEventListener('click', () => { editor.toggleRest(); scoreEl.focus(); });
  $('#btn-tie').addEventListener('click', () => { editor.toggleTie(); scoreEl.focus(); });
  $('#btn-help').addEventListener('click', () => $('#help').classList.toggle('hidden'));
  $('#btn-projects').addEventListener('click', () => { show($('#project-modal')); refreshProjectList(); });
  $('#btn-export').addEventListener('click', onExportPDF);
  // Play from start; Ctrl/Cmd-click plays from the cursor. Clicking while
  // playing stops. Not an edit — never touches the editor / undo history.
  $('#btn-play').addEventListener('click', (e) => {
    if (playbackActive) stopPlaybackUI();
    else startPlaybackUI(e.ctrlKey || e.metaKey);
    scoreEl.focus();
  });
}

async function onExportPDF() {
  const btn = $('#btn-export');
  btn.disabled = true; const prev = btn.textContent; btn.textContent = 'Exporting…';
  try {
    const pages = await exportPDF(editor.score);
    toast(`Exported PDF (${pages} page${pages > 1 ? 's' : ''})`);
  } catch (e) {
    console.error(e);
    toast('PDF export failed — see console.');
  } finally {
    btn.disabled = false; btn.textContent = prev;
  }
}

function wireSidePanel() {
  $('#f-name').addEventListener('input', (e) => editor.setName(e.target.value));
  $('#f-title').addEventListener('input', (e) => editor.setTitle(e.target.value));
  $('#f-composer').addEventListener('input', (e) => editor.setComposer(e.target.value));
  $('#f-tempo').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v)) editor.setTempo(v);
  });
  const applyTime = () => editor.setTimeSignature(+$('#f-time-num').value, +$('#f-time-den').value);
  $('#f-time-num').addEventListener('change', applyTime);
  $('#f-time-den').addEventListener('change', applyTime);

  $('#btn-add-staff').addEventListener('click', () => editor.addStaff($('#add-instr').value));
  $('#btn-add-measure').addEventListener('click', () => editor.addMeasure());
  $('#btn-del-measure').addEventListener('click', () => editor.removeMeasure());
  $('#btn-del-current').addEventListener('click', () => {
    if (editor.score.staves[0].measures.length <= 1) { toast('At least one measure is required.'); return; }
    const bar = editor.cursor.measureIndex + 1;
    editor.removeMeasureAt(editor.cursor.measureIndex);
    toast(`Removed bar ${bar}`);
    scoreEl.focus();
  });

  // Append N measures at once (Enter in the field or click the button).
  const addN = () => {
    const n = parseInt($('#f-add-count').value, 10);
    if (Number.isFinite(n) && n > 0) {
      editor.addMeasures(n);
      toast(`Added ${n} measure${n > 1 ? 's' : ''}`);
    }
    scoreEl.focus();
  };
  $('#btn-add-measures').addEventListener('click', addN);
  $('#f-add-count').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addN(); }
  });

  // Tier-2 controls
  $('#f-notehead').addEventListener('change', (e) => editor.setNotehead(e.target.value));
  $('#f-lyric').addEventListener('input', (e) => editor.setLyric(e.target.value));
  $('#f-chordsym').addEventListener('input', (e) => editor.setChordSymbol(e.target.value));
  document.querySelectorAll('[data-microacc]').forEach((b) => {
    b.addEventListener('click', () => editor.setAccidental(b.dataset.microacc));
  });
  $('#f-midkey').addEventListener('change', (e) =>
    editor.setMeasureKeySignature(editor.cursor.staffIndex, editor.cursor.measureIndex, e.target.value));
  $('#btn-midtime').addEventListener('click', () =>
    editor.setMeasureTimeSignature(editor.cursor.measureIndex, +$('#f-midtime-num').value, +$('#f-midtime-den').value));
}

function wireOverlays() {
  document.querySelectorAll('[data-close]').forEach((b) => {
    b.addEventListener('click', () => hide($('#' + b.dataset.close)));
  });
  document.querySelectorAll('.overlay').forEach((ov) => {
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) hide(ov); });
  });
  $('#btn-create-proj').addEventListener('click', () => {
    const n = $('#new-proj-name').value.trim();
    newProject(n || 'Untitled Score');
    $('#new-proj-name').value = '';
    hide($('#project-modal'));
  });
}

function wireKeyboard() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    const inField = tag === 'input' || tag === 'textarea' || tag === 'select';
    const ctrl = e.ctrlKey || e.metaKey;

    if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); toast('Saved'); return; }
    if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); editor.undo(); return; }
    if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault(); editor.redo(); return;
    }
    if (e.key === 'Escape') { document.querySelectorAll('.overlay').forEach(hide); return; }
    if (inField) return;

    const k = e.key;
    // Space toggles whole-score playback (from the start). Playback is not an
    // edit, so it never goes through the editor / undo history.
    if (k === ' ' || k === 'Spacebar') {
      e.preventDefault();
      if (playbackActive) stopPlaybackUI();
      else startPlaybackUI(false);
      return;
    }
    if (/^[a-gA-G]$/.test(k)) {
      e.preventDefault();
      resumeAudio();
      if (e.shiftKey) editor.addChordLetter(k.toUpperCase());
      else editor.enterLetter(k.toUpperCase());
      return;
    }
    const durMap = { 1: 'w', 2: 'h', 3: 'q', 4: '8', 5: '16', 6: '32' };
    if (durMap[k]) { e.preventDefault(); editor.setDuration(durMap[k]); return; }
    if (k === '.') { e.preventDefault(); editor.toggleDot(); return; }
    if (k === 'r' || k === 'R') { e.preventDefault(); editor.toggleRest(); return; }
    if (k === 't' || k === 'T') { e.preventDefault(); editor.toggleTie(); return; }
    if (k === 'ArrowUp') { e.preventDefault(); editor.nudgePitch(ctrl ? 7 : 1); return; }
    if (k === 'ArrowDown') { e.preventDefault(); editor.nudgePitch(ctrl ? -7 : -1); return; }
    if (k === 'ArrowLeft') { e.preventDefault(); e.shiftKey ? editor.moveMeasureLeft() : editor.moveLeft(); return; }
    if (k === 'ArrowRight') { e.preventDefault(); e.shiftKey ? editor.moveMeasureRight() : editor.moveRight(); return; }
    if (k === 'Tab') { e.preventDefault(); editor.nextStaff(e.shiftKey ? -1 : 1); return; }
    if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); editor.deleteTarget(); return; }
    if (k === ']') { e.preventDefault(); editor.setAccidental('#'); return; }
    if (k === '[') { e.preventDefault(); editor.setAccidental('b'); return; }
    if (k === '\\') { e.preventDefault(); editor.setAccidental('n'); return; }
    if (k === '?') { e.preventDefault(); $('#help').classList.toggle('hidden'); return; }
  });
}

function svgPoint(svg, clientX, clientY) {
  const p = svg.createSVGPoint();
  p.x = clientX; p.y = clientY;
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, y: 0 };
  const r = p.matrixTransform(m.inverse());
  return { x: r.x, y: r.y };
}

function wireScoreClicks() {
  scoreEl.addEventListener('mousedown', (e) => {
    const svg = e.target.closest('svg.score-svg');
    if (!svg || !layout) return;
    e.preventDefault();
    scoreEl.focus();
    resumeAudio();
    const pageIndex = parseInt(svg.dataset.pageIndex, 10) || 0;
    const pt = svgPoint(svg, e.clientX, e.clientY);
    const hit = hitTest(layout, pageIndex, pt.x, pt.y);
    if (!hit) return;
    if (e.shiftKey) {
      if (hit.nearestNoteIndex != null && hit.nearestDist < 14) {
        editor.selectAt(hit.staffIndex, hit.measureIndex, hit.nearestNoteIndex);
      }
      editor.addChordPitch(hit.pitch);
    } else if (hit.nearestNoteIndex != null && hit.nearestDist < 8) {
      editor.selectAt(hit.staffIndex, hit.measureIndex, hit.nearestNoteIndex);
    } else {
      editor.placeAt(hit.staffIndex, hit.measureIndex, hit.slot, hit.pitch);
    }
  });
}

// ---- Bootstrap ------------------------------------------------------------
function fatal(msg) {
  document.body.innerHTML =
    `<div style="padding:40px;font-family:sans-serif;color:#b00;">
       <h2>Could not start the editor</h2><p>${msg}</p>
       <p>Check your internet connection (libraries load from CDN) and reload.</p>
     </div>`;
}

async function init() {
  if (!window.Vex || !window.Vex.Flow) { fatal('VexFlow failed to load from CDN.'); return; }

  buildSelectors();

  // Pick the initial project: last opened, else newest saved, else a fresh one.
  let score = null;
  try {
    const lastId = getLastOpened();
    if (lastId) score = await loadProject(lastId);
    if (!score) {
      const items = await listProjects();
      if (items.length) score = await loadProject(items[0].id);
    }
  } catch (e) { console.warn('Could not load saved projects:', e); }
  if (!score) {
    score = createScore();
    try { await saveProject(score); } catch (e) { console.warn('Initial save failed:', e); }
  }

  editor = new Editor(score, onChange, notice);
  setLastOpened(score.id);

  buildPalettes();
  wireToolbar();
  wireSidePanel();
  wireOverlays();
  wireKeyboard();
  wireScoreClicks();

  render();
  setSaveStatus('saved', 'Ready');
  scoreEl.focus();

  // Lightweight debug/automation hook (handy in the console + for tests).
  window.MusicApp = {
    get editor() { return editor; },
    get layout() { return layout; },
    get isPlaying() { return playbackActive; },
    get playing() { return playingMarks; },
    play(fromCursor = false) { startPlaybackUI(!!fromCursor); },
    stop() { stopPlaybackUI(); },
    render,
    async exportDataUri() { const { pdf } = await buildPDF(editor.score); return pdf.output('datauristring'); },
  };
}

window.addEventListener('DOMContentLoaded', init);
})();
