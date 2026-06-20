// verify3.mjs — regression coverage for the three additions:
//   1) whole-score playback (plan math + start/advance/stop lifecycle)
//   2) Shift+←/→ jump-by-measure navigation
//   3) remove-current-measure across all staves (undoable)
import pw from '/opt/node22/lib/node_modules/playwright/index.js';
const { chromium } = pw;
const b = await chromium.launch({ args: ['--ignore-certificate-errors'] });
const ctx = await b.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', e => errors.push('PAGEERR ' + e.message));
await page.goto('file:///home/user/claude-music-notation/index.html', { waitUntil: 'networkidle' });
await page.waitForSelector('svg.score-svg');

function assert(c, m){ if(!c){ console.log('FAIL:', m); process.exitCode = 1;} else console.log('ok:', m); }
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ======================= 1) Playback plan math =======================
// Four quarters in 4/4 at tempo 120 (secPerBeat = 0.5).
const plan = await page.evaluate(() => {
  const M = window.MN.model;
  const sc = M.createScore(); // 4/4, 4 bars, tempo 120
  sc.tempo = 120;
  sc.staves[0].measures[0].notes = ['C','D','E','F'].map((l) =>
    M.createNote({ pitches:[{letter:l, octave:4, acc:''}], duration:'q' }));
  const p = M.buildPlayback(sc, 0);
  return { n: p.audioNotes.length, at: p.audioNotes.map(a=>a.atSec), dur: p.audioNotes.map(a=>a.durSec),
           steps: p.steps.length, endSec: p.endSec };
});
assert(plan.n === 4, 'plan: four quarter notes -> four audio onsets');
assert(plan.at.every((t,i)=>near(t, i*0.5)) , 'plan: onsets at 0, 0.5, 1.0, 1.5s');
assert(plan.dur.every(d=>near(d,0.5)), 'plan: each quarter lasts 0.5s at tempo 120');
assert(plan.steps === 4, 'plan: four playhead steps');
assert(near(plan.endSec, 8), 'plan: endSec = 16 beats * 0.5s = 8s');

// Tie sustain: two same-pitch quarters, the 2nd tied -> one onset of 1.0s, two steps.
const tied = await page.evaluate(() => {
  const M = window.MN.model;
  const sc = M.createScore(); sc.tempo = 120;
  sc.staves[0].measures[0].notes = [
    M.createNote({ pitches:[{letter:'C',octave:4,acc:''}], duration:'q' }),
    M.createNote({ pitches:[{letter:'C',octave:4,acc:''}], duration:'q', tie:true }),
  ];
  const p = M.buildPlayback(sc, 0);
  return { n: p.audioNotes.length, dur0: p.audioNotes[0].durSec, steps: p.steps.length };
});
assert(tied.n === 1, 'plan: tie sustains into one audio onset (no re-articulation)');
assert(near(tied.dur0, 1.0), 'plan: tied onset lasts both notes (1.0s)');
assert(tied.steps === 2, 'plan: playhead still steps over the tied note');

// Rests advance time silently: a quarter + quarter rest -> one onset, two steps.
const rested = await page.evaluate(() => {
  const M = window.MN.model;
  const sc = M.createScore(); sc.tempo = 120;
  sc.staves[0].measures[0].notes = [
    M.createNote({ pitches:[{letter:'C',octave:4,acc:''}], duration:'q' }),
    M.createRest('q'),
  ];
  const p = M.buildPlayback(sc, 0);
  return { n: p.audioNotes.length, steps: p.steps.length };
});
assert(rested.n === 1 && rested.steps === 2, 'plan: rest produces a step but no sound');

// Play from cursor: startBeat = 2 skips the first two quarters.
const fromCur = await page.evaluate(() => {
  const M = window.MN.model;
  const sc = M.createScore(); sc.tempo = 120;
  sc.staves[0].measures[0].notes = ['C','D','E','F'].map((l) =>
    M.createNote({ pitches:[{letter:l, octave:4, acc:''}], duration:'q' }));
  const p = M.buildPlayback(sc, 2); // start at beat 2 (3rd note)
  return { n: p.audioNotes.length, at0: p.audioNotes[0].atSec, endSec: p.endSec };
});
assert(fromCur.n === 2, 'plan(from cursor): only notes at/after the start beat sound');
assert(near(fromCur.at0, 0), 'plan(from cursor): first surviving onset is rebased to 0s');
assert(near(fromCur.endSec, 7), 'plan(from cursor): endSec = (16-2)*0.5 = 7s');

// Sounding pitch is applied in the plan (D major: written C sounds C#/+1 semitone).
const sndFreq = await page.evaluate(() => {
  const M = window.MN.model;
  const sc = M.createScore(); sc.tempo = 120;
  sc.staves[0].keySignature = 'D';
  sc.staves[0].measures[0].notes = [ M.createNote({ pitches:[{letter:'C',octave:5,acc:''}], duration:'q' }) ];
  const p = M.buildPlayback(sc, 0);
  const cNat = M.pitchToFrequency({letter:'C',octave:5,acc:''});
  const cSharp = M.pitchToFrequency({letter:'C',octave:5,acc:'#'});
  return { played: p.audioNotes[0].freqs[0], cNat, cSharp };
});
assert(near(sndFreq.played, sndFreq.cSharp, 1e-3) && !near(sndFreq.played, sndFreq.cNat, 1e-3),
  'plan: audio sounds the real pitch (C in D major -> C#)');

// ======================= 1b) Playback lifecycle =======================
// Short, fast score; start via the real button click (a user gesture so the
// AudioContext resumes), confirm the playhead advances + a green note draws,
// then that it stops on its own at the end of the score.
await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.replaceScore(window.MN.model.createScore());
  ed.setTempo(600);
  ed.setCursor(0,0,0); ed.input.duration='q'; ed.input.isRest=false;
  ['C','D','E','F'].forEach((l) => ed.enterLetter(l));
  window.MusicApp.render();
});
await page.click('#btn-play');
let advanced = false, green = 0;
for (let i = 0; i < 60 && !advanced; i++) {
  await page.waitForTimeout(20);
  const s = await page.evaluate(() => ({ p: window.MusicApp.playing, g: document.querySelectorAll('[fill="#16a34a"]').length }));
  advanced = s.p !== null; green = Math.max(green, s.g);
}
assert(advanced, 'playback: playhead advanced (a step fired)');
assert(green >= 1, 'playback: a sounding note is highlighted with the play colour');
const playingNow = await page.evaluate(() => window.MusicApp.isPlaying);
assert(playingNow === true, 'playback: Play toggled into the playing state');
// Wait for the natural end of the score (4 bars @ tempo 600 = 1.6s of audio).
let stopped = false;
for (let i = 0; i < 150 && !stopped; i++) {
  await page.waitForTimeout(20);
  stopped = await page.evaluate(() => !window.MusicApp.isPlaying);
}
assert(stopped, 'playback: stops cleanly at the end of the score');
const cleared = await page.evaluate(() => ({ marks: window.MusicApp.playing, g: document.querySelectorAll('[fill="#16a34a"]').length }));
assert(cleared.marks === null && cleared.g === 0, 'playback: playhead highlight cleared after end');

// Manual stop via the button.
await page.click('#btn-play');
await page.waitForTimeout(60);
await page.click('#btn-play'); // toggle stop
const afterStop = await page.evaluate(() => window.MusicApp.isPlaying);
assert(afterStop === false, 'playback: clicking Stop halts playback');

// Editing/navigating stops playback (and creates no undo entry for playback).
const editStops = await page.evaluate(async () => {
  const ed = window.MusicApp.editor;
  const undosBefore = ed.undoStack.length;
  window.MusicApp.play(false);
  const started = window.MusicApp.isPlaying;
  ed.moveRight(); // pure navigation -> must end playback
  return { started, playingAfter: window.MusicApp.isPlaying, undosBefore, undosAfter: ed.undoStack.length };
});
assert(editStops.started === true, 'playback: started for the edit-stops test');
assert(editStops.playingAfter === false, 'playback: navigation ends playback');
assert(editStops.undosBefore === editStops.undosAfter, 'playback: start/stop created no undo history');

// ======================= 2) Shift+arrow measure navigation =======================
const navUnit = await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.replaceScore(window.MN.model.createScore()); // 4 bars
  // Put two quarters in bar 1 so the cursor can sit mid-measure.
  ed.setCursor(0,1,0); ed.input.duration='q'; ed.input.isRest=false;
  ed.enterLetter('C'); ed.enterLetter('D'); // bar 1 now has 2 notes; cursor advanced
  ed.setCursor(0,1,1); // middle of bar 1
  const out = [];
  ed.moveMeasureLeft(); out.push([ed.cursor.measureIndex, ed.cursor.noteIndex]); // -> start of bar 1
  ed.moveMeasureLeft(); out.push([ed.cursor.measureIndex, ed.cursor.noteIndex]); // -> start of bar 0
  ed.moveMeasureLeft(); out.push([ed.cursor.measureIndex, ed.cursor.noteIndex]); // edge: stay at bar 0 start
  ed.moveMeasureRight(); out.push([ed.cursor.measureIndex, ed.cursor.noteIndex]); // -> start of bar 1
  ed.setCursor(0, ed.curStaff().measures.length - 1, 0);
  ed.moveMeasureRight(); out.push([ed.cursor.measureIndex, ed.cursor.noteIndex]); // edge: stay at last bar start
  return out;
});
assert(navUnit[0][0] === 1 && navUnit[0][1] === 0, 'Shift+Left from mid-bar -> start of current bar');
assert(navUnit[1][0] === 0 && navUnit[1][1] === 0, 'Shift+Left at bar start -> start of previous bar');
assert(navUnit[2][0] === 0 && navUnit[2][1] === 0, 'Shift+Left in first bar stays put (no error)');
assert(navUnit[3][0] === 1 && navUnit[3][1] === 0, 'Shift+Right -> start of next bar');
assert(navUnit[4][0] === 3 && navUnit[4][1] === 0, 'Shift+Right in last bar stays at its start (no error)');

// Wiring: the actual Shift+Arrow keys reach the editor.
await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.setCursor(0,1,1); window.MusicApp.render();
});
await page.focus('#score');
await page.keyboard.press('Shift+ArrowLeft');
const keyNav = await page.evaluate(() => [window.MusicApp.editor.cursor.measureIndex, window.MusicApp.editor.cursor.noteIndex]);
assert(keyNav[0] === 1 && keyNav[1] === 0, 'Shift+ArrowLeft key wired -> start of current bar');

// ======================= 3) Remove current measure (all staves, undoable) =======================
const rem = await page.evaluate(() => {
  const M = window.MN.model;
  const ed = window.MusicApp.editor;
  ed.replaceScore(M.createScore());
  ed.addStaff('Cello');                 // 2 staves
  ed.removeMeasureAt(0);                 // trim to 3 bars deterministically
  while (ed.score.staves[0].measures.length > 3) ed.removeMeasureAt(0);
  // Tag each bar of each staff with a unique pitch letter so we can identify them.
  const tags = [['C','D','E'], ['F','G','A']];
  ed.score.staves.forEach((s, si) => s.measures.forEach((m, mi) => {
    m.notes = [ M.createNote({ pitches:[{letter:tags[si][mi], octave:4, acc:''}], duration:'q' }) ];
  }));
  ed.setCursor(1, 1, 0); // cursor in bar 1 (the middle bar), staff 1
  const before = ed.score.staves.map(s => s.measures.map(m => (m.notes[0] && m.notes[0].pitches[0]) ? m.notes[0].pitches[0].letter : '_'));
  ed.removeMeasureAt(ed.cursor.measureIndex); // remove the cursor's bar from EVERY staff
  const after = ed.score.staves.map(s => s.measures.map(m => (m.notes[0] && m.notes[0].pitches[0]) ? m.notes[0].pitches[0].letter : '_'));
  const lens = ed.score.staves.map(s => s.measures.length);
  ed.undo();
  const undone = ed.score.staves.map(s => s.measures.map(m => (m.notes[0] && m.notes[0].pitches[0]) ? m.notes[0].pitches[0].letter : '_'));
  return { before, after, lens, undone };
});
assert(JSON.stringify(rem.before) === JSON.stringify([['C','D','E'],['F','G','A']]), 'remove: starting 2x3 grid tagged correctly');
assert(rem.lens[0] === 2 && rem.lens[1] === 2, 'remove: every staff drops to 2 bars (stays equal length)');
assert(JSON.stringify(rem.after) === JSON.stringify([['C','E'],['F','A']]), 'remove: the cursor bar (D/G) is deleted across all staves');
assert(JSON.stringify(rem.undone) === JSON.stringify([['C','D','E'],['F','G','A']]), 'remove: undo restores the deleted bar on every staff');

// Never drop below one measure.
const floor = await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.replaceScore(window.MN.model.createScore());
  while (ed.score.staves[0].measures.length > 1) ed.removeMeasureAt(0);
  const atOne = ed.score.staves[0].measures.length;
  ed.removeMeasureAt(0); // should be a no-op
  return { atOne, after: ed.score.staves[0].measures.length };
});
assert(floor.atOne === 1 && floor.after === 1, 'remove: never drops below one measure');

// The side-panel button removes the cursor's bar too.
const btn = await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.replaceScore(window.MN.model.createScore()); // 4 bars
  ed.setCursor(0, 2, 0);
  return ed.score.staves[0].measures.length;
});
await page.click('#btn-del-current');
const btnAfter = await page.evaluate(() => window.MusicApp.editor.score.staves[0].measures.length);
assert(btn === 4 && btnAfter === 3, 'remove: "Remove current measure" button deletes one bar');

await page.screenshot({ path: 'test/verify-features.png', fullPage: true });
console.log('\nconsole errors:', errors);
if (errors.length) process.exitCode = 1;
await b.close();
