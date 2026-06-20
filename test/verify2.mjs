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

// Build a 2-staff score: staff0 partial (1 quarter), staff1 empty, staff0 bar2 full
await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.replaceScore(window.MN.model.createScore());
  ed.addStaff('Cello');
  ed.setCursor(0,0,0); ed.input.duration='q'; ed.input.isRest=false;
  ed.enterLetter('C'); // staff0 bar0: 1 quarter, staff1 bar0 empty
  window.MusicApp.render();
});
await page.waitForTimeout(150);
await page.screenshot({ path: 'test/verify-mixed.png', fullPage: true });

// Save -> reload -> reopen
const reopen = await page.evaluate(async () => {
  const ed = window.MusicApp.editor;
  const id = ed.score.id;
  const beats = ed.score.staves[0].measures[0].notes.length;
  await window.MN.storage.saveProject(ed.score);
  window.MN.storage.setLastOpened(ed.score.id);
  return { id, beats };
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('svg.score-svg');
const after = await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  return { notes0: ed.score.staves[0].measures[0].notes.length, staves: ed.score.staves.length };
});
assert(after.notes0 === 1 && after.staves === 2, 'save/reload preserved partial bar + 2 staves');

// PDF export (vector) works without throwing
const pdf = await page.evaluate(async () => {
  try { const uri = await window.MusicApp.exportDataUri(); return uri.slice(0,30); }
  catch(e){ return 'ERR:'+e.message; }
});
assert(pdf.startsWith('data:application/pdf'), 'PDF export produced a data URI');

// Undo of an auto-advance+auto-add is a single step
const undo = await page.evaluate(() => {
  const ed = window.MusicApp.editor;
  ed.replaceScore(window.MN.model.createScore()); // 4/4, 4 bars
  const last = ed.score.staves[0].measures.length - 1;
  ed.setCursor(0, last, 0);
  ed.input.duration='w'; ed.input.isRest=false;
  ed.enterLetter('C'); // fills last bar, auto-adds a new one
  const afterAdd = ed.score.staves[0].measures.length;
  ed.undo();
  const afterUndo = ed.score.staves[0].measures.length;
  return { afterAdd, afterUndo };
});
assert(undo.afterAdd === 5 && undo.afterUndo === 4, 'single undo reverts entry + auto-added bar');

console.log('\nconsole errors:', errors);
if (errors.length) process.exitCode = 1;
await b.close();
