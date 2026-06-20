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

// Fresh project to avoid loading a stale autosave
await page.evaluate(async () => { await window.MusicApp && true; });
await page.evaluate(() => { const ed = window.MusicApp.editor; ed.replaceScore(window.MN.model.createScore()); window.MusicApp.render(); });
await page.waitForTimeout(100);

// --- Item 5: capacity enforcement + Item 6: auto-advance (3/4, six 8ths) ---
const adv = await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.setTimeSignature(3, 4);
  ed.setCursor(0,0,0);
  ed.input.duration = '8'; ed.input.dots = 0; ed.input.isRest = false;
  for (let i=0;i<6;i++) ed.enterLetter('C'); // six eighths = 3 beats = full 3/4
  return { measureIndex: ed.cursor.measureIndex, noteIndex: ed.cursor.noteIndex,
           bar0notes: ed.score.staves[0].measures[0].notes.length,
           totalMeasures: ed.score.staves[0].measures.length };
});
assert(adv.measureIndex === 1, 'cursor auto-advanced to bar 2 after six 8ths in 3/4 (got '+adv.measureIndex+')');
assert(adv.noteIndex === 0, 'cursor at start of next bar');
assert(adv.bar0notes === 6, 'bar 1 has six 8th notes');

// --- Item 5: block overfill (try a 7th eighth into bar 1 which is full) ---
const blocked = await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.setCursor(0,0,6); // end of full bar 1
  const before = ed.score.staves[0].measures[0].notes.length;
  ed.input.duration = '8';
  ed.enterLetter('D');
  return { before, after: ed.score.staves[0].measures[0].notes.length };
});
assert(blocked.before === 6 && blocked.after === 6, 'overfill blocked (bar stays at 6 notes)');

// --- Item 6: last-measure auto-add new bar ---
const lastBar = await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.replaceScore(window.MN.model.createScore()); // 4/4, 4 bars
  // fill the LAST bar (index 3) exactly with a whole note
  const last = ed.score.staves[0].measures.length - 1;
  ed.setCursor(0, last, 0);
  ed.input.duration = 'w'; ed.input.dots = 0; ed.input.isRest = false;
  const total0 = ed.score.staves[0].measures.length;
  ed.enterLetter('C');
  return { total0, total1: ed.score.staves[0].measures.length,
           measureIndex: ed.cursor.measureIndex };
});
assert(lastBar.total1 === lastBar.total0 + 1, 'auto-added a bar when filling last measure');
assert(lastBar.measureIndex === lastBar.total0, 'cursor moved into the new last bar');

// --- Item 2: addMeasures ---
const addM = await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.replaceScore(window.MN.model.createScore());
  const before = ed.score.staves[0].measures.length;
  ed.addMeasures(62);
  return { before, after: ed.score.staves[0].measures.length,
           allEqual: ed.score.staves.every(s => s.measures.length === ed.score.staves[0].measures.length) };
});
assert(addM.after === addM.before + 62, 'addMeasures(62) appended 62 bars');

// --- Item 3: sounding pitch (D major: F sounds F#, within-bar carry) ---
const snd = await page.evaluate(() => {
  const M = window.MN.model;
  const staff = M.createStaff({ clef:'treble', keySignature:'D' });
  // note 0: explicit F natural; note 1: F (should carry the natural); note 2: C (key -> C#)
  staff.measures[0].notes = [
    M.createNote({ pitches:[{letter:'F',octave:5,acc:'n'}], duration:'q' }),
    M.createNote({ pitches:[{letter:'F',octave:5,acc:''}], duration:'q' }),
    M.createNote({ pitches:[{letter:'C',octave:5,acc:''}], duration:'q' }),
    M.createNote({ pitches:[{letter:'F',octave:5,acc:''}], duration:'q' }),
  ];
  const s = (i) => M.soundingPitches(staff, 0, i, staff.measures[0].notes[i].pitches)[0].acc;
  return { keyAcc: M.keySignatureAccidentals('D'), n0:s(0), n1:s(1), n2:s(2) };
});
assert(snd.keyAcc.F === '#' && snd.keyAcc.C === '#', 'D major key map has F# and C#');
assert(snd.n0 === 'n', 'explicit F natural sounds natural');
assert(snd.n1 === 'n', 'within-bar carry: 2nd F sounds natural');
assert(snd.n2 === '#', 'C in D major sounds C# from key signature');

// --- Item 4 + bug: 2 empty staves both show rests ---
await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.replaceScore(window.MN.model.createScore());
  ed.addStaff('Cello');
  window.MusicApp.render();
});
await page.waitForTimeout(150);
const rests = await page.evaluate(() => {
  const svg = document.querySelector('svg.score-svg');
  const groups = [...svg.querySelectorAll('g[class*="stavenote"]')].map(g=>{const bb=g.getBBox();return Math.round(bb.y);});
  return groups;
});
// 2 staves * 4 bars but layout packs; just check >=2 distinct y bands (both staves drew rests)
const bands = new Set(rests);
assert(bands.size >= 2, '2-staff empty measures: both staves render rests (distinct y bands: '+bands.size+')');

// --- Item 4: partial bar shows trailing rests (1 quarter in 4/4 -> rests appended) ---
const trailing = await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.replaceScore(window.MN.model.createScore()); // 4/4
  ed.setCursor(0,0,0);
  ed.input.duration='q'; ed.input.isRest=false;
  ed.enterLetter('C');
  window.MusicApp.render();
  const svg = document.querySelector('svg.score-svg');
  // count stavenote groups in first bar region of staff 0
  const groups = [...svg.querySelectorAll('g[class*="stavenote"]')];
  return { count: groups.length, bar0notes: ed.score.staves[0].measures[0].notes.length };
});
assert(trailing.bar0notes === 1, 'model still stores only the 1 real quarter note (no filler in model)');
assert(trailing.count > 1, 'rendered note + trailing display rests (groups: '+trailing.count+')');

// --- Item 7: 16 sixteenths do not overflow the barline ---
const overflow = await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.replaceScore(window.MN.model.createScore());
  ed.setCursor(0,0,0);
  ed.input.duration='16'; ed.input.isRest=false;
  for (let i=0;i<16;i++) ed.enterLetter('C');
  window.MusicApp.render();
  const lay = window.MusicApp.layout;
  const box = lay.staveBoxes.find(b => b.staffIndex===0 && b.globalMeasureIndex===0);
  const svg = document.querySelector('svg.score-svg');
  // last notehead x within bar 0
  const groups = [...svg.querySelectorAll('g[class*="stavenote"]')];
  let maxX = 0; groups.forEach(g=>{const bb=g.getBBox(); if(bb.y<250) maxX=Math.max(maxX, bb.x+bb.width);});
  return { endX: box.endX, maxNoteX: Math.round(maxX), bar0notes: ed.score.staves[0].measures[0].notes.length };
});
assert(overflow.bar0notes === 16, '16 sixteenths entered (full 4/4 bar)');
assert(overflow.maxNoteX <= overflow.endX + 4, 'notes stay within barline (maxNoteX '+overflow.maxNoteX+' <= endX '+overflow.endX+')');

await page.screenshot({ path: 'test/verify-final.png', fullPage: true });
console.log('\nconsole errors:', errors);
if (errors.length) process.exitCode = 1;
await b.close();
