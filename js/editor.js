// editor.js
// The editing brain: holds the live score, the insertion cursor, the current
// palette/input settings, and the undo/redo history. EVERY mutation goes through
// commit(), which snapshots state first, so undo/redo covers all edits (note
// entry, deletion, accidentals, dynamics, time/key changes, structural edits).
//
// Cursor model: cursor.noteIndex is an insertion bar in [0, notes.length]. The
// bar sits to the LEFT of notes[noteIndex]. The "target" note (the one edits
// like accidental/duration/tie/delete act on, and which is highlighted) is the
// note immediately to the LEFT of the bar — i.e. the most recently entered note.

(function () {
'use strict';
const MN = (window.MN = window.MN || {});
const {
  createNote, createRest, createMeasure, createStaff, cloneScore,
  defaultPitchForClef, nearestPitchWithLetter, transposeDiatonic, sortPitches,
  durationBeats, measureCapacityBeats, effectiveTimeSignature, soundingPitches,
} = MN.model;
const { getInstrument } = MN.instruments;
const { playChord, resumeAudio } = MN.audio;

const HISTORY_LIMIT = 250;
const COALESCE_MS = 1200;

class Editor {
  constructor(score, onChange, onNotice) {
    this.score = score;
    this.onChange = onChange || (() => {});
    // Mild, non-blocking message hook (e.g. "No room in Staff 2, Bar 5").
    this.onNotice = onNotice || (() => {});
    this.undoStack = [];
    this.redoStack = [];
    this.cursor = { staffIndex: 0, measureIndex: 0, noteIndex: 0 };
    this.input = { duration: 'q', dots: 0, isRest: false, tieNext: false };
    this.lastPitch = null;
    this._lastCoalesceKey = null;
    this._lastCommitTime = 0;
  }

  // ---- Convenience accessors ----------------------------------------------
  curStaff() { return this.score.staves[this.cursor.staffIndex]; }
  curMeasure() {
    const s = this.curStaff();
    return s.measures[Math.min(this.cursor.measureIndex, s.measures.length - 1)];
  }

  // Index of the note being edited (left of the insertion bar).
  targetNoteIndex() {
    const m = this.curMeasure();
    if (m.notes.length === 0) return -1;
    const i = this.cursor.noteIndex;
    return i > 0 ? Math.min(i - 1, m.notes.length - 1) : 0;
  }
  targetNote() {
    const idx = this.targetNoteIndex();
    return idx >= 0 ? this.curMeasure().notes[idx] : null;
  }

  // State the renderer needs.
  editorState() {
    const idx = this.targetNoteIndex();
    return {
      cursor: { ...this.cursor },
      target: idx >= 0
        ? { staffIndex: this.cursor.staffIndex, measureIndex: this.cursor.measureIndex, noteIndex: idx }
        : null,
      showCursor: true,
    };
  }

  // ---- History ------------------------------------------------------------
  _snapshot() { return { score: cloneScore(this.score), cursor: { ...this.cursor } }; }

  // Run a mutation, recording an undo snapshot first. Consecutive mutations
  // sharing a coalesceKey within COALESCE_MS collapse into one undo step (so
  // typing a title isn't 30 undo steps).
  commit(mutator, coalesceKey = null) {
    const now = Date.now();
    const coalesce = coalesceKey && this._lastCoalesceKey === coalesceKey
      && (now - this._lastCommitTime) < COALESCE_MS && this.undoStack.length > 0;
    if (!coalesce) {
      this.undoStack.push(this._snapshot());
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }
    mutator();
    this._lastCoalesceKey = coalesceKey;
    this._lastCommitTime = now;
    this.score.updatedAt = now;
    this._emit();
  }

  _emit() { this.onChange(); }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this._snapshot());
    const prev = this.undoStack.pop();
    this.score = prev.score;
    this.cursor = prev.cursor;
    this._clampCursor();
    this._lastCoalesceKey = null;
    this._emit();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._snapshot());
    const next = this.redoStack.pop();
    this.score = next.score;
    this.cursor = next.cursor;
    this._clampCursor();
    this._lastCoalesceKey = null;
    this._emit();
  }

  _clampCursor() {
    const c = this.cursor;
    c.staffIndex = Math.max(0, Math.min(c.staffIndex, this.score.staves.length - 1));
    const staff = this.score.staves[c.staffIndex];
    c.measureIndex = Math.max(0, Math.min(c.measureIndex, staff.measures.length - 1));
    const m = staff.measures[c.measureIndex];
    c.noteIndex = Math.max(0, Math.min(c.noteIndex, m.notes.length));
  }

  // Swap in a different project (e.g. opening from the project manager). Clears
  // history and resets the cursor/palette so undo can't cross project boundaries.
  replaceScore(score) {
    this.score = score;
    this.undoStack = [];
    this.redoStack = [];
    this.cursor = { staffIndex: 0, measureIndex: 0, noteIndex: 0 };
    this.input = { duration: 'q', dots: 0, isRest: false, tieNext: false };
    this.lastPitch = null;
    this._lastCoalesceKey = null;
    this._emit();
  }

  // ---- Capacity / auto-advance / audio helpers ----------------------------

  // Real (model) content of a measure, in quarter-note beats.
  _measureUsedBeats(measure) {
    return measure.notes.reduce((sum, n) => sum + durationBeats(n.duration, n.dots), 0);
  }
  // Would adding `addBeats` keep the bar within its time-signature capacity?
  _fits(measure, ts, addBeats) {
    return this._measureUsedBeats(measure) + addBeats <= measureCapacityBeats(ts) + 1e-6;
  }
  _noRoom() {
    this.onNotice(`No room in Staff ${this.cursor.staffIndex + 1}, Bar ${this.cursor.measureIndex + 1}`);
  }
  // Play the SOUNDING pitch(es) of a note (apply key signature + within-bar
  // accidental carry). `measureIndex`/`noteIndex` locate the note in the score.
  _playEntered(pitches, measureIndex, noteIndex) {
    if (!pitches.length) return;
    playChord(soundingPitches(this.curStaff(), measureIndex, noteIndex, pitches));
  }
  // If the cursor's measure is now exactly full, advance to the next bar's start;
  // when at the end of the piece, append a fresh bar to every staff first. Runs
  // inside a commit so the auto-added bar is part of the same undo step.
  _advanceIfFull() {
    const ts = effectiveTimeSignature(this.score, this.cursor.measureIndex);
    if (this._measureUsedBeats(this.curMeasure()) < measureCapacityBeats(ts) - 1e-6) return;
    if (this.cursor.measureIndex >= this.curStaff().measures.length - 1) {
      this.score.staves.forEach((s) => s.measures.push(createMeasure()));
    }
    this.cursor.measureIndex++;
    this.cursor.noteIndex = 0;
  }

  // ---- Note entry ---------------------------------------------------------

  // Insert a pitched note (or a rest if rest-mode is on) at the cursor.
  insertPitch(pitch) {
    resumeAudio();
    const makeRest = this.input.isRest;
    const ts = effectiveTimeSignature(this.score, this.cursor.measureIndex);
    const addBeats = durationBeats(this.input.duration, this.input.dots);
    if (!this._fits(this.curMeasure(), ts, addBeats)) { this._noRoom(); return; }
    const playMeasure = this.cursor.measureIndex;
    let playNoteIndex = this.cursor.noteIndex;
    this.commit(() => {
      const note = makeRest
        ? createRest(this.input.duration, this.input.dots)
        : createNote({
            pitches: [{ ...pitch }], duration: this.input.duration,
            dots: this.input.dots, tie: this.input.tieNext,
          });
      this.curMeasure().notes.splice(this.cursor.noteIndex, 0, note);
      playNoteIndex = this.cursor.noteIndex;
      this.cursor.noteIndex++;
      this.input.tieNext = false;
      if (!makeRest) this.lastPitch = { ...pitch };
      this._advanceIfFull();
    });
    if (!makeRest) this._playEntered([pitch], playMeasure, playNoteIndex);
  }

  // A–G keyboard entry: pressing a letter always enters a pitch (clears rest mode).
  enterLetter(letter) {
    if (this.input.isRest) this.input.isRest = false;
    const ref = this.lastPitch || this._cursorReferencePitch();
    this.insertPitch(nearestPitchWithLetter(letter, ref));
  }

  // Explicitly enter a rest of the current duration regardless of rest toggle.
  insertRest() {
    resumeAudio();
    const ts = effectiveTimeSignature(this.score, this.cursor.measureIndex);
    const addBeats = durationBeats(this.input.duration, this.input.dots);
    if (!this._fits(this.curMeasure(), ts, addBeats)) { this._noRoom(); return; }
    this.commit(() => {
      this.curMeasure().notes.splice(this.cursor.noteIndex, 0,
        createRest(this.input.duration, this.input.dots));
      this.cursor.noteIndex++;
      this.input.tieNext = false;
      this._advanceIfFull();
    });
  }

  // Click-to-enter: position the cursor and drop a note at the clicked pitch.
  placeAt(staffIndex, measureIndex, slot, pitch) {
    this.cursor = { staffIndex, measureIndex, noteIndex: slot };
    this._clampCursor();
    this.insertPitch(pitch);
  }

  // Click an existing note to select it (make it the target).
  selectAt(staffIndex, measureIndex, noteIndex) {
    this.cursor = { staffIndex, measureIndex, noteIndex: noteIndex + 1 };
    this._clampCursor();
    this._syncLastPitch();
    this._syncInputFromTarget();
    this._emit();
  }

  // When a note becomes the target via navigation/selection, mirror its
  // duration/dots/rest state into the palette so the toolbar reflects it.
  _syncInputFromTarget() {
    const n = this.targetNote();
    if (!n) return;
    this.input.duration = n.duration;
    this.input.dots = n.dots;
    this.input.isRest = n.pitches.length === 0;
  }

  // Add a pitch to the target note as a chord tone (single voice).
  addChordPitch(pitch) {
    resumeAudio();
    const idx = this.targetNoteIndex();
    if (idx < 0) { this.insertPitch(pitch); return; }
    const note = this.curMeasure().notes[idx];
    if (note.pitches.length === 0) {
      this.commit(() => { note.pitches = [{ ...pitch }]; });
      this._playEntered([pitch], this.cursor.measureIndex, idx);
      this.lastPitch = { ...pitch };
      return;
    }
    if (note.pitches.some((p) => p.letter === pitch.letter && p.octave === pitch.octave)) return;
    this.commit(() => { note.pitches.push({ ...pitch }); });
    this.lastPitch = { ...pitch };
    this._playEntered(note.pitches, this.cursor.measureIndex, idx);
  }

  addChordLetter(letter) {
    const note = this.targetNote();
    const ref = note && note.pitches.length
      ? note.pitches[note.pitches.length - 1]
      : (this.lastPitch || this._cursorReferencePitch());
    this.addChordPitch(nearestPitchWithLetter(letter, ref));
  }

  // Move the target note's pitch(es) by diatonic steps (±1 step, ±7 octave).
  nudgePitch(delta) {
    const idx = this.targetNoteIndex();
    if (idx < 0) return;
    const note = this.curMeasure().notes[idx];
    if (note.pitches.length === 0) return; // rests have no pitch
    this.commit(() => {
      note.pitches = sortPitches(note.pitches.map((p) => transposeDiatonic(p, delta)));
    });
    this.lastPitch = { ...note.pitches[note.pitches.length - 1] };
    this._playEntered(note.pitches, this.cursor.measureIndex, idx);
  }

  _cursorReferencePitch() {
    return defaultPitchForClef(this.curStaff().clef);
  }

  // ---- Palette-driven edits (apply to target note + set input defaults) ----

  setDuration(code) {
    this.input.duration = code;
    const idx = this.targetNoteIndex();
    if (idx >= 0) {
      const note = this.curMeasure().notes[idx];
      this.commit(() => { note.duration = code; });
    } else { this._emit(); }
  }

  toggleDot() {
    this.input.dots = this.input.dots > 0 ? 0 : 1;
    const idx = this.targetNoteIndex();
    if (idx >= 0) {
      const note = this.curMeasure().notes[idx];
      const dots = this.input.dots;
      this.commit(() => { note.dots = dots; });
    } else { this._emit(); }
  }

  toggleRest() {
    this.input.isRest = !this.input.isRest;
    const idx = this.targetNoteIndex();
    if (idx >= 0) {
      const note = this.curMeasure().notes[idx];
      if (this.input.isRest && note.pitches.length > 0) {
        this.commit(() => { note.pitches = []; });
        return;
      }
      if (!this.input.isRest && note.pitches.length === 0) {
        const p = this.lastPitch || this._cursorReferencePitch();
        this.commit(() => { note.pitches = [{ ...p }]; });
        this._playEntered([p], this.cursor.measureIndex, idx);
        return;
      }
    }
    this._emit();
  }

  // Apply an accidental to every pitch of the target note (toggles off if all
  // pitches already carry it).
  setAccidental(acc) {
    const idx = this.targetNoteIndex();
    if (idx < 0) { this._emit(); return; }
    const note = this.curMeasure().notes[idx];
    if (note.pitches.length === 0) { this._emit(); return; }
    const allSame = note.pitches.every((p) => p.acc === acc);
    this.commit(() => { note.pitches.forEach((p) => { p.acc = allSame ? '' : acc; }); });
    this._playEntered(note.pitches, this.cursor.measureIndex, idx);
  }

  // Tie: toggle on the target note if it has a predecessor to tie back to;
  // otherwise arm tieNext so the next entered note is tied to the previous one.
  toggleTie() {
    const idx = this.targetNoteIndex();
    const hasPrev = idx > 0 || (idx >= 0 && this.cursor.measureIndex > 0);
    if (idx >= 0 && hasPrev) {
      const note = this.curMeasure().notes[idx];
      this.commit(() => { note.tie = !note.tie; });
      return;
    }
    this.input.tieNext = !this.input.tieNext;
    this._emit();
  }

  setDynamic(dyn) {
    const idx = this.targetNoteIndex();
    if (idx < 0) { this._emit(); return; }
    const note = this.curMeasure().notes[idx];
    this.commit(() => { note.dynamic = note.dynamic === dyn ? '' : dyn; });
  }

  setNotehead(code) {
    const idx = this.targetNoteIndex();
    if (idx < 0) { this._emit(); return; }
    const note = this.curMeasure().notes[idx];
    if (note.pitches.length === 0) { this._emit(); return; }
    this.commit(() => { note.notehead = note.notehead === code ? 'normal' : code; });
  }

  setLyric(text) {
    const idx = this.targetNoteIndex();
    if (idx < 0) return;
    const note = this.curMeasure().notes[idx];
    this.commit(() => { note.lyric = text; }, 'lyric');
  }

  setChordSymbol(text) {
    const idx = this.targetNoteIndex();
    if (idx < 0) return;
    const note = this.curMeasure().notes[idx];
    this.commit(() => { note.chordSymbol = text; }, 'chordsym');
  }

  // ---- Deletion -----------------------------------------------------------
  deleteTarget() {
    const m = this.curMeasure();
    if (m.notes.length === 0) { this._emit(); return; }
    const idx = this.cursor.noteIndex > 0 ? this.cursor.noteIndex - 1 : 0;
    this.commit(() => {
      m.notes.splice(idx, 1);
      if (this.cursor.noteIndex > 0) this.cursor.noteIndex--;
      if (this.cursor.noteIndex > m.notes.length) this.cursor.noteIndex = m.notes.length;
    });
  }

  // ---- Cursor navigation --------------------------------------------------
  moveLeft() {
    const c = this.cursor;
    if (c.noteIndex > 0) c.noteIndex--;
    else if (c.measureIndex > 0) { c.measureIndex--; c.noteIndex = this.curMeasure().notes.length; }
    this._syncLastPitch();
    this._syncInputFromTarget();
    this._emit();
  }
  moveRight() {
    const c = this.cursor;
    const m = this.curMeasure();
    if (c.noteIndex < m.notes.length) c.noteIndex++;
    else if (c.measureIndex < this.curStaff().measures.length - 1) { c.measureIndex++; c.noteIndex = 0; }
    this._syncLastPitch();
    this._syncInputFromTarget();
    this._emit();
  }
  nextStaff(dir = 1) {
    const n = this.score.staves.length;
    this.cursor.staffIndex = (this.cursor.staffIndex + dir + n) % n;
    this._clampCursor();
    this._syncLastPitch();
    this._syncInputFromTarget();
    this._emit();
  }
  setCursor(staffIndex, measureIndex, noteIndex) {
    this.cursor = { staffIndex, measureIndex, noteIndex };
    this._clampCursor();
    this._syncLastPitch();
    this._syncInputFromTarget();
    this._emit();
  }
  _syncLastPitch() {
    const n = this.targetNote();
    if (n && n.pitches.length) this.lastPitch = { ...n.pitches[n.pitches.length - 1] };
  }

  // ---- Structural edits ---------------------------------------------------
  addStaff(instrument = 'Flute') {
    const preset = getInstrument(instrument) || { clef: 'treble', name: instrument };
    const measureCount = this.score.staves[0] ? this.score.staves[0].measures.length : 4;
    this.commit(() => {
      this.score.staves.push(createStaff({
        instrument, clef: preset.clef, name: preset.name || instrument, measureCount,
      }));
    });
  }
  removeStaff(index) {
    if (this.score.staves.length <= 1) return;
    this.commit(() => {
      this.score.staves.splice(index, 1);
      if (this.cursor.staffIndex >= this.score.staves.length) {
        this.cursor.staffIndex = this.score.staves.length - 1;
      }
      this._clampCursor();
    });
  }
  addMeasure() {
    this.commit(() => { this.score.staves.forEach((s) => s.measures.push(createMeasure())); });
  }
  // Append `n` empty measures to every staff in a single undo step.
  addMeasures(n) {
    const count = Math.max(0, Math.floor(n));
    if (!count) return;
    this.commit(() => {
      for (let i = 0; i < count; i++) this.score.staves.forEach((s) => s.measures.push(createMeasure()));
    });
  }
  removeMeasure() {
    if (!this.score.staves[0] || this.score.staves[0].measures.length <= 1) return;
    this.commit(() => {
      this.score.staves.forEach((s) => s.measures.pop());
      this._clampCursor();
    });
  }

  setInstrument(staffIndex, name) {
    const preset = getInstrument(name);
    this.commit(() => {
      const staff = this.score.staves[staffIndex];
      staff.instrument = name;
      if (preset) { staff.clef = preset.clef; staff.name = preset.name; }
    });
  }
  setStaffName(staffIndex, name) {
    this.commit(() => { this.score.staves[staffIndex].name = name; }, 'staffname' + staffIndex);
  }
  setClef(staffIndex, clef) {
    this.commit(() => { this.score.staves[staffIndex].clef = clef; });
  }
  setKeySignature(staffIndex, key) {
    this.commit(() => { this.score.staves[staffIndex].keySignature = key; });
  }
  setTimeSignature(num, den) {
    this.commit(() => { this.score.timeSignature = { num, den }; });
  }

  // Mid-score changes (Tier 2): apply from a measure onward.
  setMeasureTimeSignature(measureIndex, num, den) {
    this.commit(() => {
      this.score.staves.forEach((s) => {
        if (s.measures[measureIndex]) s.measures[measureIndex].timeSignature = { num, den };
      });
    });
  }
  setMeasureKeySignature(staffIndex, measureIndex, key) {
    this.commit(() => {
      const m = this.score.staves[staffIndex].measures[measureIndex];
      if (m) m.keySignature = key;
    });
  }

  // ---- Score metadata -----------------------------------------------------
  setTitle(v) { this.commit(() => { this.score.title = v; }, 'title'); }
  setComposer(v) { this.commit(() => { this.score.composer = v; }, 'composer'); }
  setName(v) { this.commit(() => { this.score.name = v; }, 'name'); }
  setTempo(v) { this.commit(() => { this.score.tempo = v; }, 'tempo'); }
}

MN.Editor = Editor;
})();
