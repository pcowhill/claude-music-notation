// audio.js
// A tiny Web Audio synth. It plays a short "ping" when the user enters a pitch
// or chord (so they can hear what they placed) AND schedules whole-score
// playback from a plan built by MN.model.buildPlayback. No external audio
// library — just an oscillator + gain envelope per voice.

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

// ---- Whole-score playback -------------------------------------------------
// Schedules an entire plan (from MN.model.buildPlayback) on the Web Audio clock
// and drives a visual playhead via requestAnimationFrame against that same
// clock, so the highlight tracks the sound. Only one player runs at a time.

let player = null; // { teardown() } while playing, else null

// One sustained tone: short attack, hold, gentle release. Longer than the entry
// "ping" so held notes ring for (about) their full written duration.
function scheduleTone(freq, when, durSec, dest) {
  const c = ctx;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  const dur = Math.max(durSec, 0.08);
  const end = when + dur;
  const rel = Math.min(0.12, dur * 0.3);
  const peak = 0.16;
  gain.gain.setValueAtTime(0.0001, when);
  gain.gain.exponentialRampToValueAtTime(peak, when + 0.008);
  gain.gain.setValueAtTime(peak, Math.max(when + 0.012, end - rel));
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain);
  gain.connect(dest);
  osc.start(when);
  osc.stop(end + 0.03);
  return { osc, gain };
}

function isPlaying() { return !!player; }

// Begin playing `plan`. onStep(marks) fires at each playhead moment; onEnd()
// fires exactly once when playback finishes on its own (not on stopPlayback).
// Returns true if playback started.
function startPlayback(plan, { onStep, onEnd } = {}) {
  const c = getContext();
  if (!c) { if (onEnd) onEnd(); return false; }
  resumeAudio();
  stopPlayback(); // never run two players at once
  const startAt = c.currentTime + 0.08; // small lead so the first onset isn't clipped
  const master = c.createGain();
  master.gain.value = 0.8;
  master.connect(c.destination);
  const nodes = [];
  plan.audioNotes.forEach((n) => {
    n.freqs.forEach((f) => nodes.push(scheduleTone(f, startAt + n.atSec, n.durSec, master)));
  });

  const steps = plan.steps || [];
  let si = 0;
  let rafId = 0;
  let done = false;

  function teardown() {
    if (done) return;
    done = true;
    cancelAnimationFrame(rafId);
    nodes.forEach(({ osc, gain }) => {
      try { osc.stop(); } catch (e) { /* may not have started yet */ }
      try { osc.disconnect(); } catch (e) { /* ignore */ }
      try { gain.disconnect(); } catch (e) { /* ignore */ }
    });
    try { master.disconnect(); } catch (e) { /* ignore */ }
  }

  function tick() {
    if (done) return;
    const elapsed = c.currentTime - startAt;
    while (si < steps.length && steps[si].atSec <= elapsed + 0.012) {
      if (onStep) onStep(steps[si].marks);
      si++;
    }
    if (elapsed >= plan.endSec) {
      player = null;
      teardown();
      if (onEnd) onEnd();
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  player = { teardown };
  rafId = requestAnimationFrame(tick);
  return true;
}

// Stop the current player immediately (cuts sound; fires no onEnd). Safe when
// already idle.
function stopPlayback() {
  if (!player) return;
  const p = player;
  player = null;
  p.teardown();
}

MN.audio = { resumeAudio, playPitch, playChord, startPlayback, stopPlayback, isPlaying };
})();
