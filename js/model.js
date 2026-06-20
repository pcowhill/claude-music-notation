// model.js
// The serializable score data model plus pure helpers (pitch math, duration
// math, time/key-signature resolution). Nothing here touches the DOM, VexFlow,
// or storage — it is plain data and pure functions so it can be snapshotted for
// undo/redo and serialized to IndexedDB directly.
//
// Shape:
//   score   = { schema, id, name, title, composer, tempo, timeSignature, staves[] }
//   staff   = { id, instrument, name, clef, keySignature, measures[] }
//   measure = { timeSignature?, keySignature?, notes[] }   (signatures inherited unless set)
//   note    = { pitches[], duration, dots, tie, dynamic, notehead?, lyric?, chordSymbol? }
//   pitch   = { letter:'A'..'G', octave:Number, acc:'' | '#' | 'b' | 'n' | '##' | 'bb' | '+' | 'd' }
//   A rest is simply a note with an empty pitches[] array.
//
// Loaded as a classic script; publishes its API on window.MN.model.
(function () {
'use strict';
const MN = (window.MN = window.MN || {});

const SCHEMA_VERSION = 1;

// ---- Palette / option constants -------------------------------------------

const DURATIONS = [
  { code: 'w',  label: 'Whole',   beats: 4 },
  { code: 'h',  label: 'Half',    beats: 2 },
  { code: 'q',  label: 'Quarter', beats: 1 },
  { code: '8',  label: 'Eighth',  beats: 0.5 },
  { code: '16', label: '16th',    beats: 0.25 },
  { code: '32', label: '32nd',    beats: 0.125 },
];

// Basic accidentals (Tier 1) + microtonal additions (Tier 2). Codes are the
// exact strings VexFlow's Accidental glyph table understands.
const ACCIDENTALS_BASIC = [
  { code: 'bb', label: '𝄫', title: 'Double flat' },
  { code: 'b',  label: '♭', title: 'Flat' },
  { code: 'n',  label: '♮', title: 'Natural' },
  { code: '#',  label: '♯', title: 'Sharp' },
  { code: '##', label: '𝄪', title: 'Double sharp' },
];
const ACCIDENTALS_MICRO = [
  { code: 'd',  label: 'd',  title: 'Quarter-tone flat' },
  { code: '+',  label: '+',  title: 'Quarter-tone sharp' },
];

const DYNAMICS = ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'cresc.', 'dim.'];

const NOTEHEADS = [
  { code: 'normal',   label: 'Normal' },
  { code: 'x',        label: 'Cross (x)' },
  { code: 'd',        label: 'Diamond' },
  { code: 't',        label: 'Triangle' },
  { code: 's',        label: 'Slash' },
];

// Common key signatures expressed as VexFlow key specs.
const KEY_SIGNATURES = [
  { value: 'C',  label: 'C major / A minor (0)' },
  { value: 'G',  label: 'G major / E minor (1♯)' },
  { value: 'D',  label: 'D major / B minor (2♯)' },
  { value: 'A',  label: 'A major / F♯ minor (3♯)' },
  { value: 'E',  label: 'E major / C♯ minor (4♯)' },
  { value: 'B',  label: 'B major / G♯ minor (5♯)' },
  { value: 'F#', label: 'F♯ major / D♯ minor (6♯)' },
  { value: 'F',  label: 'F major / D minor (1♭)' },
  { value: 'Bb', label: 'B♭ major / G minor (2♭)' },
  { value: 'Eb', label: 'E♭ major / C minor (3♭)' },
  { value: 'Ab', label: 'A♭ major / F minor (4♭)' },
  { value: 'Db', label: 'D♭ major / B♭ minor (5♭)' },
  { value: 'Gb', label: 'G♭ major / E♭ minor (6♭)' },
];

const TIME_NUMERATORS = [2, 3, 4, 5, 6, 7, 9, 12];
const TIME_DENOMINATORS = [2, 4, 8, 16];

// ---- ID helper ------------------------------------------------------------

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ---- Factory functions ----------------------------------------------------

function createNote({ pitches = [], duration = 'q', dots = 0, tie = false,
                             dynamic = '', notehead = 'normal' } = {}) {
  return { pitches, duration, dots, tie, dynamic, notehead, lyric: '', chordSymbol: '' };
}

function createRest(duration = 'q', dots = 0) {
  return createNote({ pitches: [], duration, dots });
}

function createMeasure() {
  return { notes: [] };
}

function createStaff({ instrument = 'Flute', clef = 'treble',
                              keySignature = 'C', name = null, measureCount = 4 } = {}) {
  const measures = [];
  for (let i = 0; i < measureCount; i++) measures.push(createMeasure());
  return {
    id: uid(),
    instrument,
    name: name || instrument,
    clef,
    keySignature,
    measures,
  };
}

function createScore({ name = 'Untitled Score', title = 'Untitled Score',
                              composer = '' } = {}) {
  return {
    schema: SCHEMA_VERSION,
    id: uid(),
    name,
    title,
    composer,
    tempo: 120,
    timeSignature: { num: 4, den: 4 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    staves: [createStaff({ instrument: 'Flute', clef: 'treble' })],
  };
}

// ---- Serialization --------------------------------------------------------

function cloneScore(score) {
  // structuredClone is ideal for snapshots; fall back to JSON for old engines.
  if (typeof structuredClone === 'function') return structuredClone(score);
  return JSON.parse(JSON.stringify(score));
}

function serialize(score) {
  return cloneScore(score);
}

// Validate / migrate an arbitrary loaded object into a well-formed score so a
// corrupt or older save can never crash the editor.
function deserialize(obj) {
  if (!obj || typeof obj !== 'object') return createScore();
  const score = createScore();
  score.id = obj.id || score.id;
  score.schema = SCHEMA_VERSION;
  score.name = typeof obj.name === 'string' ? obj.name : score.name;
  score.title = typeof obj.title === 'string' ? obj.title : score.title;
  score.composer = typeof obj.composer === 'string' ? obj.composer : '';
  score.tempo = Number.isFinite(obj.tempo) ? obj.tempo : 120;
  score.createdAt = obj.createdAt || Date.now();
  score.updatedAt = obj.updatedAt || Date.now();
  score.timeSignature = normalizeTime(obj.timeSignature) || { num: 4, den: 4 };
  const staves = Array.isArray(obj.staves) ? obj.staves : [];
  score.staves = staves.length ? staves.map(normalizeStaff) : [createStaff()];
  // Guarantee every staff has the same number of measures.
  const maxM = Math.max(1, ...score.staves.map((s) => s.measures.length));
  score.staves.forEach((s) => {
    while (s.measures.length < maxM) s.measures.push(createMeasure());
  });
  return score;
}

function normalizeTime(t) {
  if (!t || !Number.isFinite(t.num) || !Number.isFinite(t.den)) return null;
  return { num: t.num, den: t.den };
}

function normalizeStaff(s) {
  const staff = createStaff({
    instrument: s && s.instrument ? s.instrument : 'Flute',
    clef: s && s.clef ? s.clef : 'treble',
    keySignature: s && s.keySignature ? s.keySignature : 'C',
    name: s && s.name ? s.name : null,
    measureCount: 0,
  });
  staff.id = (s && s.id) || staff.id;
  const measures = s && Array.isArray(s.measures) ? s.measures : [];
  staff.measures = measures.map(normalizeMeasure);
  if (staff.measures.length === 0) staff.measures.push(createMeasure());
  return staff;
}

function normalizeMeasure(m) {
  const measure = createMeasure();
  if (m && normalizeTime(m.timeSignature)) measure.timeSignature = normalizeTime(m.timeSignature);
  if (m && typeof m.keySignature === 'string') measure.keySignature = m.keySignature;
  const notes = m && Array.isArray(m.notes) ? m.notes : [];
  measure.notes = notes.map(normalizeNote);
  return measure;
}

function normalizeNote(n) {
  const note = createNote({
    duration: n && n.duration ? n.duration : 'q',
    dots: n && Number.isFinite(n.dots) ? n.dots : 0,
    tie: !!(n && n.tie),
    dynamic: n && typeof n.dynamic === 'string' ? n.dynamic : '',
    notehead: n && n.notehead ? n.notehead : 'normal',
  });
  note.lyric = n && typeof n.lyric === 'string' ? n.lyric : '';
  note.chordSymbol = n && typeof n.chordSymbol === 'string' ? n.chordSymbol : '';
  const pitches = n && Array.isArray(n.pitches) ? n.pitches : [];
  note.pitches = pitches.map(normalizePitch).filter(Boolean);
  return note;
}

function normalizePitch(p) {
  if (!p) return null;
  const letter = String(p.letter || 'C').toUpperCase().slice(0, 1);
  if (!'ABCDEFG'.includes(letter)) return null;
  const octave = Number.isFinite(p.octave) ? p.octave : 4;
  const acc = typeof p.acc === 'string' ? p.acc : '';
  return { letter, octave, acc };
}

// ---- Time / key signature resolution --------------------------------------
// Signatures are stored per-measure only when they *change*; otherwise the most
// recent prior value (or the score/staff default) is inherited.

function effectiveTimeSignature(score, measureIndex) {
  // Time signatures apply to all staves equally, so staff 0 is authoritative.
  const staff = score.staves[0];
  if (staff) {
    for (let i = Math.min(measureIndex, staff.measures.length - 1); i >= 0; i--) {
      const ts = staff.measures[i] && staff.measures[i].timeSignature;
      if (ts) return ts;
    }
  }
  return score.timeSignature;
}

function effectiveKeySignature(staff, measureIndex) {
  for (let i = Math.min(measureIndex, staff.measures.length - 1); i >= 0; i--) {
    const ks = staff.measures[i] && staff.measures[i].keySignature;
    if (ks) return ks;
  }
  return staff.keySignature;
}

// ---- Key-signature → sounding accidentals (audio only) --------------------
// The page keeps key signatures display-only (the renderer draws exactly the
// accidental on each pitch), but audio should sound the real pitch, so these
// helpers resolve what a written pitch actually sounds like.

// Order in which sharps / flats are added to a key signature.
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
// Signed count of accidentals for each VexFlow key spec (+sharps / −flats).
const KEY_ACCIDENTAL_COUNT = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7,
  F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
};

// Map a key spec (e.g. 'D') to the letters it alters, e.g. { F:'#', C:'#' }.
function keySignatureAccidentals(keySpec) {
  const map = {};
  const n = KEY_ACCIDENTAL_COUNT[keySpec] || 0;
  if (n > 0) for (let i = 0; i < n; i++) map[SHARP_ORDER[i]] = '#';
  else if (n < 0) for (let i = 0; i < -n; i++) map[FLAT_ORDER[i]] = 'b';
  return map;
}

// Resolve the SOUNDING accidental for a written pitch. Precedence:
//   explicit acc on the note  >  most recent explicit acc on the same
//   letter+octave earlier in the bar  >  key-signature alteration  >  natural.
function soundingAccidental(pitch, priorPitches, keyAcc) {
  if (pitch.acc && pitch.acc !== '') return pitch.acc;
  for (let i = priorPitches.length - 1; i >= 0; i--) {
    const p = priorPitches[i];
    if (p.letter === pitch.letter && p.octave === pitch.octave && p.acc && p.acc !== '') return p.acc;
  }
  if (keyAcc[pitch.letter]) return keyAcc[pitch.letter];
  return 'n';
}

// Return copies of `pitches` with their accidental replaced by the sounding one
// (for audio only — does not affect what is drawn). `noteIndex` is the index,
// within staff.measures[measureIndex], of the note the pitches belong to.
function soundingPitches(staff, measureIndex, noteIndex, pitches) {
  const measure = staff.measures[measureIndex];
  const keyAcc = keySignatureAccidentals(effectiveKeySignature(staff, measureIndex));
  const prior = [];
  if (measure) {
    for (let i = 0; i < noteIndex && i < measure.notes.length; i++) {
      for (const p of measure.notes[i].pitches) prior.push(p);
    }
  }
  return pitches.map((p) => ({ ...p, acc: soundingAccidental(p, prior, keyAcc) }));
}

// ---- Duration helpers -----------------------------------------------------

function durationBeats(duration, dots = 0) {
  const base = (DURATIONS.find((d) => d.code === duration) || { beats: 1 }).beats;
  let total = base;
  let add = base;
  for (let i = 0; i < dots; i++) { add /= 2; total += add; }
  return total;
}

// Capacity of a measure in quarter-note beats, from its effective time sig.
function measureCapacityBeats(timeSignature) {
  return timeSignature.num * (4 / timeSignature.den);
}

// ---- Pitch math -----------------------------------------------------------

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_INDEX = { C: 0, D: 1, E: 2, F: 3, G: 4, A: 5, B: 6 };
const LETTER_SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACC_SEMITONE = { '': 0, n: 0, '#': 1, b: -1, '##': 2, bb: -2, '+': 0.5, d: -0.5 };

// A "diatonic number": octave*7 + letterIndex. Ignores accidentals; describes a
// staff position. Used for stepping by line/space and click-to-pitch mapping.
function pitchToDiatonic(pitch) {
  return pitch.octave * 7 + LETTER_INDEX[pitch.letter];
}

function diatonicToPitch(diatonic, acc = '') {
  const octave = Math.floor(diatonic / 7);
  const idx = ((diatonic % 7) + 7) % 7;
  return { letter: LETTERS[idx], octave, acc };
}

// MIDI-ish number (may be fractional for quarter tones) for audio + sorting.
function pitchToMidi(pitch) {
  return (pitch.octave + 1) * 12 + LETTER_SEMITONE[pitch.letter] + (ACC_SEMITONE[pitch.acc] || 0);
}

function pitchToFrequency(pitch) {
  return 440 * Math.pow(2, (pitchToMidi(pitch) - 69) / 12);
}

// Move a pitch by a number of diatonic steps (positive = up). Accidental is
// reset to natural at the new staff position, matching typical step entry.
function transposeDiatonic(pitch, steps) {
  return diatonicToPitch(pitchToDiatonic(pitch) + steps, '');
}

// VexFlow key string WITHOUT the accidental, e.g. {letter:'C',octave:4} -> 'c/4'.
// The renderer adds accidentals as explicit Accidental modifiers (so exactly the
// accidental the user placed is drawn), which is why the key is kept plain.
function pitchToVexKey(pitch) {
  return `${pitch.letter.toLowerCase()}/${pitch.octave}`;
}

function pitchToLabel(pitch) {
  const accLabel = { '': '', n: '♮', '#': '♯', b: '♭', '##': '𝄪', bb: '𝄫', '+': '+', d: 'd' };
  return `${pitch.letter}${accLabel[pitch.acc] || ''}${pitch.octave}`;
}

// The pitch sitting on the *top* line of a staff for a given clef. Used to map
// a clicked y-coordinate (or arrow-step entry) to a concrete pitch.
const TOP_LINE_PITCH = {
  treble: { letter: 'F', octave: 5 },
  bass:   { letter: 'A', octave: 3 },
  alto:   { letter: 'G', octave: 4 },
  tenor:  { letter: 'E', octave: 4 },
};

function topLineDiatonic(clef) {
  const p = TOP_LINE_PITCH[clef] || TOP_LINE_PITCH.treble;
  return pitchToDiatonic(p);
}

// A sensible default pitch to start entry on when a staff/measure is empty.
function defaultPitchForClef(clef) {
  const map = {
    treble: { letter: 'B', octave: 4, acc: '' },
    bass:   { letter: 'D', octave: 3, acc: '' },
    alto:   { letter: 'C', octave: 4, acc: '' },
    tenor:  { letter: 'A', octave: 3, acc: '' },
  };
  return { ...(map[clef] || map.treble) };
}

// Given a desired letter and a reference pitch, pick the octave that places the
// letter closest to the reference (used for A–G keyboard entry).
function nearestPitchWithLetter(letter, reference) {
  const refDia = pitchToDiatonic(reference);
  const targetIdx = LETTER_INDEX[letter];
  // Candidate diatonic numbers across nearby octaves.
  let best = null;
  for (let oct = reference.octave - 1; oct <= reference.octave + 1; oct++) {
    const dia = oct * 7 + targetIdx;
    if (best === null || Math.abs(dia - refDia) < Math.abs(best - refDia)) best = dia;
  }
  return diatonicToPitch(best, '');
}

function sortPitches(pitches) {
  return [...pitches].sort((a, b) => pitchToMidi(a) - pitchToMidi(b));
}

// ---- Whole-score playback timeline ----------------------------------------
// Pure helpers that flatten the score into a tempo-resolved plan the audio
// scheduler can play and the renderer can use to drive a moving playhead.
// Measure start times come from each bar's time-signature capacity (not how
// full it is), so every staff stays aligned at the barlines even when a bar is
// under/over-filled. A quarter note lasts 60/tempo seconds.

// Absolute beat where each measure begins, plus the score's total length.
function measureStartBeats(score) {
  const total = score.staves[0] ? score.staves[0].measures.length : 0;
  const starts = [];
  let acc = 0;
  for (let m = 0; m < total; m++) {
    starts.push(acc);
    acc += measureCapacityBeats(effectiveTimeSignature(score, m));
  }
  return { starts, totalBeats: acc };
}

// Absolute beat position of the cursor (used for "play from cursor").
function cursorStartBeat(score, cursor) {
  const { starts } = measureStartBeats(score);
  let beat = starts[cursor.measureIndex] || 0;
  const staff = score.staves[cursor.staffIndex] || score.staves[0];
  const measure = staff && staff.measures[cursor.measureIndex];
  if (measure) {
    for (let i = 0; i < cursor.noteIndex && i < measure.notes.length; i++) {
      beat += durationBeats(measure.notes[i].duration, measure.notes[i].dots);
    }
  }
  return beat;
}

// Build a playback plan (optionally starting partway through at `startBeat`):
//   audioNotes : [{ atSec, durSec, freqs[] }]  onsets to sound (rests omitted)
//   steps      : [{ atSec, marks[] }]          playhead moments incl. rests,
//                  marks = { staffIndex, measureIndex, noteIndex }
//   endSec     : when playback finishes (end of the last bar)
// Audio sounds the REAL pitch via soundingPitches (key signature + within-bar
// accidental carry), exactly like the entry "ping". Ties are honored by
// sustaining: a tied note extends the previous onset instead of re-articulating
// (only when it is the same pitch set; otherwise it re-articulates).
function buildPlayback(score, startBeat = 0) {
  const secPerBeat = 60 / (score.tempo || 120);
  const { starts, totalBeats } = measureStartBeats(score);
  const audioNotes = [];
  const stepMap = new Map(); // rel-beat (ms key) -> { atSec, marks[] }

  score.staves.forEach((staff, staffIndex) => {
    let prevAudio = null; // last articulated onset in this staff (for tie sustain)
    staff.measures.forEach((measure, measureIndex) => {
      let beatPos = measureIndex < starts.length ? starts[measureIndex] : totalBeats;
      measure.notes.forEach((note, noteIndex) => {
        const beats = durationBeats(note.duration, note.dots);
        if (beatPos >= startBeat - 1e-9) {
          const rel = beatPos - startBeat;
          const key = Math.round(rel * 1000);
          let step = stepMap.get(key);
          if (!step) { step = { atSec: rel * secPerBeat, marks: [] }; stepMap.set(key, step); }
          step.marks.push({ staffIndex, measureIndex, noteIndex });
          if (note.pitches.length) {
            const freqs = soundingPitches(staff, measureIndex, noteIndex, note.pitches)
              .map(pitchToFrequency);
            const fk = freqs.join(',');
            if (note.tie && prevAudio && prevAudio.fk === fk) {
              prevAudio.durSec += beats * secPerBeat; // sustain the tie
            } else {
              prevAudio = { atSec: rel * secPerBeat, durSec: beats * secPerBeat, freqs, fk };
              audioNotes.push(prevAudio);
            }
          } else {
            prevAudio = null; // a rest breaks the tie chain
          }
        } else {
          prevAudio = null; // onset before the start point: not played
        }
        beatPos += beats;
      });
    });
  });

  const steps = [...stepMap.values()].sort((a, b) => a.atSec - b.atSec);
  audioNotes.forEach((ev) => { delete ev.fk; }); // internal key, not part of the API
  const endSec = Math.max(0, totalBeats - startBeat) * secPerBeat;
  return { audioNotes, steps, endSec };
}

MN.model = {
  SCHEMA_VERSION, DURATIONS, ACCIDENTALS_BASIC, ACCIDENTALS_MICRO, DYNAMICS,
  NOTEHEADS, KEY_SIGNATURES, TIME_NUMERATORS, TIME_DENOMINATORS,
  uid, createNote, createRest, createMeasure, createStaff, createScore,
  cloneScore, serialize, deserialize,
  effectiveTimeSignature, effectiveKeySignature,
  keySignatureAccidentals, soundingAccidental, soundingPitches,
  durationBeats, measureCapacityBeats,
  pitchToDiatonic, diatonicToPitch, pitchToMidi, pitchToFrequency, transposeDiatonic,
  pitchToVexKey, pitchToLabel, topLineDiatonic, defaultPitchForClef,
  nearestPitchWithLetter, sortPitches,
  measureStartBeats, cursorStartBeat, buildPlayback,
};
})();
