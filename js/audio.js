// audio.js
// A tiny Web Audio synth that plays a short "ping" when the user enters a pitch
// or chord, so they can hear what they placed. No external audio library — just
// an oscillator + gain envelope per voice. No full-score playback.

(function () {
'use strict';
const MN = (window.MN = window.MN || {});
const { pitchToFrequency } = MN.model;

let ctx = null;

// The AudioContext must be created/resumed from a user gesture, so we lazily
// build it on first use (note entry always follows a click or keypress).
function getContext() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  return ctx;
}

// Some browsers start the context suspended until a gesture resumes it.
function resumeAudio() {
  const c = getContext();
  if (c && c.state === 'suspended') c.resume();
}

function pingFrequency(freq, when, gainNode) {
  const c = ctx;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;

  // Short percussive envelope: quick attack, gentle exponential decay.
  const peak = 0.18;
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.45);

  osc.connect(g);
  g.connect(gainNode);
  osc.start(when);
  osc.stop(when + 0.5);
}

// Play one pitch object as a ping.
function playPitch(pitch) {
  const c = getContext();
  if (!c || !pitch) return;
  resumeAudio();
  const master = c.createGain();
  master.gain.value = 0.9;
  master.connect(c.destination);
  pingFrequency(pitchToFrequency(pitch), c.currentTime, master);
}

// Play several pitches together (a chord). Slightly lower master gain so stacked
// notes don't clip.
function playChord(pitches) {
  const c = getContext();
  if (!c || !pitches || pitches.length === 0) return;
  resumeAudio();
  const master = c.createGain();
  master.gain.value = pitches.length > 1 ? 0.6 : 0.9;
  master.connect(c.destination);
  const now = c.currentTime;
  pitches.forEach((p) => pingFrequency(pitchToFrequency(p), now, master));
}

MN.audio = { resumeAudio, playPitch, playChord };
})();
