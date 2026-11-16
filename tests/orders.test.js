// Written with help from Claude Code (AI); reviewed and tested by the team.
// Run: node --test tests/orders.test.js   (from the project root)
// Orders take effect right away (LW.Sim.applyOrders), without moving the clock or using randomness.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

globalThis.window = globalThis;
require(path.join(__dirname, '../data/may2024.js'));
require(path.join(__dirname, '../data/radlab.js'));
require(path.join(__dirname, '../js/config.js'));
require(path.join(__dirname, '../js/sim.js'));
const S = globalThis.LW.Sim, B = globalThis.LW.CONFIG.base;

function orderBuilding() {
  const st = S.create({ scenario: 'history', seed: 1 });
  const eng = st.crew.find((a) => a.role === 'engineer');
  const r = S.place(st, 'battery', B.c + 6, B.r + 3, eng.id);
  assert.ok(r.ok, r.why);
  return { st, eng };
}

test('a build order sends the Engineer outside at once, without moving the clock', () => {
  const { st, eng } = orderBuilding();
  assert.strictEqual(eng.where, 'hab', 'before: still at home');
  const hour = st.hour, rng = st.rngA;
  S.applyOrders(st);
  assert.strictEqual(eng.where, 'outside');
  assert.ok(eng.job, 'has the job');
  assert.strictEqual(st.hour, hour, 'no time passed');
  assert.strictEqual(st.rngA, rng, 'no random numbers used');
});

test('applying orders twice changes nothing more (safe to call after every click)', () => {
  const { st } = orderBuilding();
  S.applyOrders(st);
  const once = JSON.stringify(st);
  S.applyOrders(st);
  assert.strictEqual(JSON.stringify(st), once);
});

test('save → load right after an order continues exactly the same', () => {
  const { st } = orderBuilding();
  S.applyOrders(st);
  const loaded = JSON.parse(JSON.stringify(st));
  for (let i = 0; i < 48; i++) { S.step(st); S.step(loaded); }
  assert.strictEqual(JSON.stringify(loaded), JSON.stringify(st));
});

test('sending the crew to the shelter moves them at once', () => {
  const st = S.create({ scenario: 'history', seed: 1 });
  const eng = st.crew.find((a) => a.role === 'engineer');
  const r = S.place(st, 'shelter', B.c - 4, B.r + 3, eng.id);
  while (!r.m.built) S.step(st);
  assert.ok(S.setShelter(st, true));
  S.applyOrders(st);
  assert.ok(S.activeCrew(st).every((a) => a.where === 'shelter'), st.crew.map((a) => a.where).join(','));
});
