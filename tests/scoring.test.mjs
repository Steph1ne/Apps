// Run with: node --test tests/
// No npm dependency: uses Node's built-in test runner and vm module against the
// real inline <script> from r7k9m-perso.html, so these tests exercise the actual
// production code rather than a re-implementation of the formulas.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(__dirname, '..', 'r7k9m-perso.html'), 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) throw new Error('Could not find inline <script> in r7k9m-perso.html');
const APP_CODE = scriptMatch[1];
const STORAGE_KEY = 'relations_v4';

function makeStubElement() {
  return {
    innerHTML: '', textContent: '', value: '', style: {}, className: '',
    classList: { add(){}, remove(){}, contains(){return false;}, toggle(){} },
    addEventListener(){}, appendChild(){}, removeChild(){},
    querySelectorAll(){return [];}, querySelector(){return null;},
    setAttribute(){}, getAttribute(){return '';}, focus(){}, click(){},
  };
}

// Fresh sandbox per test so state mutations never leak between tests.
// `seedState`, if given, is written to the stubbed localStorage before the
// script runs, so the app's own normalizeStateShape(loadData()) picks it up
// exactly like it would from a real browser localStorage entry.
function loadApp(seedState) {
  const store = {};
  if (seedState) store[STORAGE_KEY] = JSON.stringify(seedState);
  const localStorage = {
    getItem: k => Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    key: i => Object.keys(store)[i] || null,
    get length() { return Object.keys(store).length; },
  };
  const document = {
    getElementById: () => makeStubElement(),
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => makeStubElement(),
    body: makeStubElement(),
    addEventListener(){},
  };
  const sandbox = {
    document, localStorage, console,
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL(){} },
    Blob: class { constructor(parts){ this.parts = parts; } },
    confirm: () => true, alert(){}, setTimeout(){},
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(APP_CODE, ctx, { filename: 'r7k9m-perso.inline.js' });
  return ctx;
}

test('esc() neutralizes HTML special characters', () => {
  const app = loadApp();
  assert.equal(app.esc('<b>Alice</b> "quote" & \'apostrophe\''),
    '&lt;b&gt;Alice&lt;/b&gt; &quot;quote&quot; &amp; &#39;apostrophe&#39;');
});

test('normalizeStateShape backfills a minimal/legacy save and purges tie comparisons', () => {
  const app = loadApp();
  const legacy = {
    people: [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }],
    comparisons: { 'p1|p2': { envie: 'tie', prob: 'p1' } },
  };
  const s = app.normalizeStateShape(legacy);
  // Objects/arrays created inside the vm sandbox are a different JS realm, so
  // spread them into plain Node-realm values before deepEqual (cross-realm
  // deepEqual reports "not reference-equal" even when structurally identical).
  assert.deepEqual({ ...s.weights }, { envie: 40, prob: 30, momentum: 20, logistique: 10 });
  assert.ok(Array.isArray(s.experiences) && s.experiences.length > 0);
  assert.equal(s.profiles['p1'].relationType, 'mixte');
  assert.equal(s.profiles['p1'].tags.length, 0);
  assert.equal(Object.keys(s.comparisons).length, 0); // tie comparison purged
});

test('recordComparison + recomputeScores produce correct win ratios', () => {
  const app = loadApp({ people: [
    { id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }, { id: 'p3', name: 'Carla' },
  ] });
  app.recordComparison('p1', 'p2', 'p1', 'p2'); // Alice wins envie, Bob wins prob
  app.recordComparison('p1', 'p3', 'p1', 'p1'); // Alice wins both vs Carla
  assert.equal(app.getWR('p1', 'envie'), 1);  // won both envie duels
  assert.equal(app.getWR('p2', 'prob'), 1);   // won its one prob duel
  assert.equal(app.getWR('p3', 'envie'), 0);  // lost its one envie duel
});

test('quadrantOf classifies interest/potential correctly', () => {
  const app = loadApp();
  assert.equal(app.quadrantOf({ interest: 0.8, potential: 0.8 }), 'strategic');
  assert.equal(app.quadrantOf({ interest: 0.8, potential: 0.2 }), 'interest');
  assert.equal(app.quadrantOf({ interest: 0.2, potential: 0.8 }), 'potential');
  assert.equal(app.quadrantOf({ interest: 0.2, potential: 0.2 }), 'low');
});

test('daysSinceContact is null when unset and correct once lastContact is set', () => {
  const app = loadApp({ people: [{ id: 'p1', name: 'Alice' }] });
  assert.equal(app.daysSinceContact('p1'), null);
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  app.getProfile('p1').lastContact = tenDaysAgo;
  assert.equal(app.daysSinceContact('p1'), 10);
});

test('buildRecommendations reactivate list picks up long silence via lastContact', () => {
  const app = loadApp({ people: [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }] });
  const staleDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  app.getProfile('p1').lastContact = staleDate;
  const rows = [{ id: 'p1' }, { id: 'p2' }].map(app.getRelationMetrics);
  const recs = app.buildRecommendations(rows);
  assert.ok(recs.reactivate.some(r => r.person.id === 'p1'));
});

test('getGlobalScore matches the documented weighted formula', () => {
  const app = loadApp({
    people: [{ id: 'p1', name: 'Alice' }, { id: 'p2', name: 'Bob' }],
    weights: { envie: 40, prob: 30, momentum: 20, logistique: 10 },
  });
  app.recordComparison('p1', 'p2', 'p1', 'p2'); // p1 wins envie (1/1), loses prob (0/1)
  const pr = app.getProfile('p1');
  pr.momentum = 5; pr.logistique = 0;
  const expected = (1 * 40 + 0 * 30 + (5 / 5) * 20 + (0 / 5) * 10) / 100;
  assert.ok(Math.abs(app.getGlobalScore('p1') - expected) < 1e-9);
});
