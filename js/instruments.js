// instruments.js
// Instrument presets. Each preset maps a display name to a default clef.
// Everything in this app is concert pitch — there is no transposition logic,
// so a preset only needs a name + the clef it conventionally reads.
//
// Loaded as a classic script (so the app runs from file:// without a server);
// it publishes its API on the shared `window.MN` namespace.
(function () {
'use strict';
const MN = (window.MN = window.MN || {});

const INSTRUMENTS = [
  // Woodwinds
  { name: 'Flute',        clef: 'treble', group: 'Woodwinds' },
  { name: 'Oboe',         clef: 'treble', group: 'Woodwinds' },
  { name: 'Clarinet',     clef: 'treble', group: 'Woodwinds' },
  { name: 'Bassoon',      clef: 'bass',   group: 'Woodwinds' },
  { name: 'Saxophone',    clef: 'treble', group: 'Woodwinds' },
  { name: 'Piccolo',      clef: 'treble', group: 'Woodwinds' },
  // Brass
  { name: 'Trumpet',      clef: 'treble', group: 'Brass' },
  { name: 'Horn',         clef: 'treble', group: 'Brass' },
  { name: 'Trombone',     clef: 'bass',   group: 'Brass' },
  { name: 'Tuba',         clef: 'bass',   group: 'Brass' },
  // Strings
  { name: 'Violin',       clef: 'treble', group: 'Strings' },
  { name: 'Viola',        clef: 'alto',   group: 'Strings' },
  { name: 'Cello',        clef: 'bass',   group: 'Strings' },
  { name: 'Double Bass',  clef: 'bass',   group: 'Strings' },
  { name: 'Harp',         clef: 'treble', group: 'Strings' },
  // Keyboard / Voice
  { name: 'Piano',        clef: 'treble', group: 'Keyboard' },
  { name: 'Piano (LH)',   clef: 'bass',   group: 'Keyboard' },
  { name: 'Organ',        clef: 'treble', group: 'Keyboard' },
  { name: 'Voice',        clef: 'treble', group: 'Voice' },
  { name: 'Soprano',      clef: 'treble', group: 'Voice' },
  { name: 'Alto',         clef: 'treble', group: 'Voice' },
  { name: 'Tenor',        clef: 'treble', group: 'Voice' },
  { name: 'Bass (Voice)', clef: 'bass',   group: 'Voice' },
];

// Look up a preset by its (unique) name.
function getInstrument(name) {
  return INSTRUMENTS.find((i) => i.name === name) || null;
}

// The clefs the UI lets you assign directly to a staff.
const CLEFS = ['treble', 'bass', 'alto', 'tenor'];

MN.instruments = { INSTRUMENTS, getInstrument, CLEFS };
})();
