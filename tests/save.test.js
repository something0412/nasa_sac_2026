// Run: node --test tests/save.test.js   (from the project root)
// Saving and loading must give back EXACTLY the same game: after loading, the game plays on hour by
// hour just like the game that was never saved.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

globalThis.window = globalThis;
require(path.join(__dirname, '../data/may2024.js'));
require(path.join(__dirname, '../data/radlab.js'));
require(path.join(__dirname, '../js/config.js'));
require(path.join(__dirname, '../js/sim.js'));
require(path.join(__dirname, '../js/save.js'));
const LW = globalThis.LW, S = LW.Sim, Save = LW.Save;

function freeTile(st, zone, type) {
  const C = LW.CONFIG, B = C.base;
  let best = null;
  for (let r = 0; r < C.map.rows; r++) for (let c = 0; c < C.map.cols; c++) {
    if (S.zoneOf(st, c, r) !== zone || !S.canPlace(st, type, c, r).ok) continue;
    const d = Math.hypot(c - B.c, r - B.r);
    if (!best || d < best.d) best = { c, r, d };
  }
  return best;
}
function build(st, type, zone) { const t = freeTile(st, zone, type); if (t) S.place(st, type, t.c, t.r); }

// A busy player, so the save has a bit of everything: buildings in progress, cargo choices, shelter,
// research, the moon-dirt shield, new crew.
function bot(st, ev) {
  const C = LW.CONFIG;
  for (const e of ev) if (e.decision === 'cargo') S.chooseCargo(st, e.cargoIndex, ['food', 'parts', 'life'][e.cargoIndex % 3]);
  if (st.pendingCrew > 0) S.joinCrew(st, ['engineer', 'botanist', 'scientist'].slice(0, st.pendingCrew), st.landedPadId);
  // (the same storm watcher as the shelterBot in sim.test.js)
  const on = C.rad.stormOn;
  const coming = S.upcoming(st, st.hour).some((i) => i.kind === 'storm') || st.stormRate > on;
  if (coming && S.hasShelter(st)) S.setShelter(st, true);
  if (st.sheltering && st.stormRate < on && !st.storms.some((x) => x.h > st.hour - 3 && x.h < st.hour + 3)) S.setShelter(st, false);
  if (st.hour === 30) S.startBerm(st);
  if (st.hour % 100 === 50 && st.res.parts >= 10) build(st, 'solar', st.hour % 200 === 50 ? 'ridge' : 'plain');
  S.applyOrders(st, 0);
}
// The "sensible plan" from sim.test.js (it keeps the base alive).
function setup(st) {
  build(st, 'solar', 'ridge'); build(st, 'solar', 'ridge'); build(st, 'solar', 'ridge');
  build(st, 'battery', 'plain'); build(st, 'battery', 'plain');
  build(st, 'shelter', 'plain'); build(st, 'drill', 'ice');
  S.applyOrders(st, 0);
}
function play(st, hours) {
  const until = st.hour + hours;
  while (st.status === 'running' && st.hour < until) bot(st, S.step(st));
  return st;
}
// What a file export + import does: pack → text → parse → unpack.
function roundTrip(st) {
  const text = JSON.stringify(Save.pack(st));
  const r = Save.unpack(JSON.parse(text));
  assert.ok(r.ok, r.why);
  return r.state;
}
// Same data (the order of fields does not matter). Compared as plain data, like a save would see it.
const same = (a, b, msg) => assert.deepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), msg);

/** Objects reachable twice in the state (JSON would turn them into two copies). */
function sharedObjects(state) {
  const seen = new Map(), out = [];
  (function walk(v, at) {
    if (!v || typeof v !== 'object') return;
    if (seen.has(v)) { out.push(at + ' = ' + seen.get(v)); return; }
    seen.set(v, at);
    for (const k of Object.keys(v)) walk(v[k], at + '.' + k);
  })(state, 'state');
  return out;
}

for (const scenario of ['training', 'history']) {
  test(`${scenario}: a loaded game plays on exactly like the original`, () => {
    const a = S.create({ scenario, seed: 7 });
    setup(a);
    play(a, 400);
    assert.strictEqual(a.status, 'running');
    const b = roundTrip(a);
    same(b, a, 'loaded state = saved state (tiles and sunlight rebuilt the same)');
    assert.strictEqual(b.berm, b.modules.find((m) => m.type === 'hab').berm, 'state.berm is the first HAB\'s shield again (same object)');
    for (let i = 0; i < 12; i++) { play(a, 60); play(b, 60); same(b, a, `still the same ${(i + 1) * 60} hours after loading`); }
    assert.ok(a.crewTotal > LW.CONFIG.crew, `a crew spaceship came and its astronauts joined (hour ${a.hour}, ${a.status})`);
  });
}

// After loading, two things that were ONE object become two copies. That is only OK when nobody
// changes them later. Allowed: state.berm (save.js links it back to the first HAB's shield),
// storm profiles (real LRO data, never changed) and lastAccident (only read, for the debrief).
test('nothing else in the game state is shared (it would split in two after loading)', () => {
  const st = S.create({ scenario: 'training', seed: 3 });
  setup(st);
  play(st, 1500);
  const ok = [/^state\.berm = |= state\.berm$/, /^state\.storms\.\d+\.profile = state\.storms\.\d+\.profile$/, /^state\.lastAccident = state\.stats\.accidents\.\d+$/];
  const shared = sharedObjects(st).filter((s) => !ok.some((re) => re.test(s)));
  assert.deepStrictEqual(shared, []);
});

test('saving in the middle of a crew landing keeps the new astronauts waiting for their jobs', () => {
  const a = S.create({ scenario: 'training', seed: 2 });
  setup(a);
  while (a.pendingCrew === 0 && a.status === 'running' && a.hour < 2000) {
    const ev = S.step(a);
    for (const e of ev) if (e.decision === 'cargo') S.chooseCargo(a, e.cargoIndex, 'food');
    if (a.pendingCrew === 0) bot(a, []);
  }
  assert.ok(a.pendingCrew > 0, 'a spaceship landed');
  const b = roundTrip(a);
  assert.strictEqual(b.pendingCrew, a.pendingCrew);
  S.joinCrew(a, ['engineer', 'scientist'], a.landedPadId);
  S.joinCrew(b, ['engineer', 'scientist'], b.landedPadId);
  same(b, a);
});

test('an old save without some fields gets the defaults of a new game', () => {
  const st = S.create({ scenario: 'training', seed: 4 });
  setup(st);
  play(st, 50);
  const env = JSON.parse(JSON.stringify(Save.pack(st)));
  delete env.state.research; delete env.state.stats.harm; delete env.state.crew[0].bone; delete env.state.modules[0].dustLeft;
  delete env.state.towerVisits; delete env.lightLen;
  const r = Save.unpack(env);
  assert.ok(r.ok, r.why);
  assert.deepStrictEqual(r.state.research, { solar: 0, o2gen: 0, drill: 0 });
  assert.deepStrictEqual(r.state.stats.harm, {});
  assert.strictEqual(r.state.crew[0].bone, 100);
  assert.strictEqual(r.state.modules[0].dustLeft, 0);
  assert.strictEqual(r.state.towerVisits, 0);
  assert.ok(r.state.light.plain.length > r.state.hour, 'sunlight forecast rebuilt');
  play(r.state, 100); // and it keeps running
  assert.strictEqual(r.state.status, 'running');
});

test('bad saves are refused with a clear reason (never a crash)', () => {
  const good = Save.pack(S.create({ scenario: 'training', seed: 1 }));
  const bad = [
    ['not json {', /not valid JSON/],
    [null, /not a Lunar World save/],
    [{ ...good, game: 'other-game' }, /not a Lunar World save/],
    [{ ...good, saveVersion: Save.SAVE_VERSION + 1 }, /newer version/],
    [{ ...good, saveVersion: undefined }, /damaged/],
    [{ ...good, state: { hour: 'x' } }, /damaged/],
    [{ ...good, state: { ...good.state, scenario: 'mars' } }, /damaged/],
  ];
  for (const [env, why] of bad) {
    const r = Save.unpack(env);
    assert.strictEqual(r.ok, false);
    assert.match(r.why, why);
  }
  assert.ok(Save.unpack(good).ok, 'the good one loads');
});

test('a save is small and quick', () => {
  const st = S.create({ scenario: 'history', seed: 1 });
  setup(st);
  play(st, 24 * 120); // 120 days
  const t0 = performance.now();
  const text = JSON.stringify(Save.pack(st));
  const ms = performance.now() - t0;
  assert.ok(!('tiles' in JSON.parse(text).state) && !('light' in JSON.parse(text).state), 'map and sunlight are not saved');
  assert.ok(text.length < 2e6, `save is ${Math.round(text.length / 1024)} KB`);
  assert.ok(ms < 200, `saving took ${Math.round(ms)} ms`);
  assert.match(Save.fileName(Save.pack(st)), /^lunar-world-history-day-\d+\.json$/);
});
