// storage.js
// Local, multi-project persistence backed by IndexedDB (via the idb-keyval UMD
// global loaded from CDN). Each project's full score object is stored under its
// own id in a dedicated object store, so listing/loading/deleting are trivial.

(function () {
'use strict';
const MN = (window.MN = window.MN || {});
const { serialize, deserialize, cloneScore, uid } = MN.model;

// idb-keyval is loaded as a global <script>; grab it defensively.
const idb = window.idbKeyval;
const store = idb ? idb.createStore('music-notation-db', 'projects') : null;

function ensure() {
  if (!idb || !store) throw new Error('IndexedDB (idb-keyval) is not available.');
}

// Return lightweight metadata for every saved project, newest first.
async function listProjects() {
  ensure();
  const entries = await idb.entries(store);
  return entries
    .map(([id, score]) => ({
      id,
      name: score.name || 'Untitled',
      title: score.title || '',
      composer: score.composer || '',
      updatedAt: score.updatedAt || 0,
      createdAt: score.createdAt || 0,
      staffCount: Array.isArray(score.staves) ? score.staves.length : 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

async function loadProject(id) {
  ensure();
  const raw = await idb.get(id, store);
  return raw ? deserialize(raw) : null;
}

// Persist a score. Stamps updatedAt so the project list stays ordered.
async function saveProject(score) {
  ensure();
  score.updatedAt = Date.now();
  await idb.set(score.id, serialize(score), store);
  return score.updatedAt;
}

async function deleteProject(id) {
  ensure();
  await idb.del(id, store);
}

async function renameProject(id, name) {
  ensure();
  const raw = await idb.get(id, store);
  if (!raw) return;
  raw.name = name;
  raw.updatedAt = Date.now();
  await idb.set(id, raw, store);
}

// Deep-copy an existing project under a fresh id and name.
async function duplicateProject(id) {
  ensure();
  const raw = await idb.get(id, store);
  if (!raw) return null;
  const copy = cloneScore(deserialize(raw));
  copy.id = uid();
  copy.name = `${raw.name || 'Untitled'} (copy)`;
  copy.createdAt = Date.now();
  copy.updatedAt = Date.now();
  await idb.set(copy.id, serialize(copy), store);
  return copy;
}

// Remember which project was open so we can restore the session on reload.
const LAST_KEY = 'music-notation:lastOpenId';
function setLastOpened(id) {
  try { localStorage.setItem(LAST_KEY, id); } catch (e) { /* ignore */ }
}
function getLastOpened() {
  try { return localStorage.getItem(LAST_KEY); } catch (e) { return null; }
}

MN.storage = {
  listProjects, loadProject, saveProject, deleteProject, renameProject,
  duplicateProject, setLastOpened, getLastOpened,
};
})();
