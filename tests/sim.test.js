// Run: node --test tests/sim.test.js   (from the project root)
// Plays whole missions with simple "bot" strategies to check the game is winnable but not too easy.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

globalThis.window = globalThis;
require(path.join(__dirname, '../data/may2024.js'));
require(path.join(__dirname, '../js/config.js'));
require(path.join(__dirname, '../js/sim.js'));
const S = globalThis.MT.Sim;

function play(scenario, seed, setup, each) {
  const st = S.create({ scenario, seed });
  if (setup) setup(st);
  while (st.status === 'running') {
    const ev = S.step(st);
    for (const e of ev) if (e.decision === 'cargo') S.chooseCargo(st, e.cargoIndex, 'food');
    if (each) each(st, ev);
  }
  return st;
}

// Nearest free tile of a zone, measured from the habitat (so tests survive map changes).
function freeTile(st, zone, type) {
  const C = globalThis.MT.CONFIG, B = C.base;
  let best = null;
  for (let r = 0; r < C.map.rows; r++) for (let c = 0; c < C.map.cols; c++) {
    if (S.zoneOf(st, c, r) !== zone || !S.canPlace(st, type, c, r).ok) continue;
    const d = Math.hypot(c - B.c, r - B.r);
    if (!best || d < best.d) best = { c, r, d };
  }
  assert.ok(best, 'no free ' + zone + ' tile for ' + type);
  return best;
}
function build(st, type, zone) { const t = freeTile(st, zone, type); assert.ok(S.place(st, type, t.c, t.r).ok, 'place ' + type); }

const goodSetup = (st) => {
  build(st, 'solar', 'ridge'); build(st, 'solar', 'ridge'); build(st, 'solar', 'ridge');
  build(st, 'battery', 'plain'); build(st, 'battery', 'plain');
  build(st, 'shelter', 'plain'); build(st, 'drill', 'ice');
};
const shelterBot = (st, ev) => {
  // Like an alert player: watches the countdown bar and shelters when a storm is coming.
  if (S.upcoming(st, st.hour).some((i) => i.kind === 'storm') && S.hasShelter(st)) S.setShelter(st, true);
  if (st.sheltering && st.stormRate < 0.3 && !st.storms.some((s) => s.h > st.hour - 3 && s.h < st.hour + 3)) S.setShelter(st, false);
};

test('real May 2024 data is loaded and lines up with the mission', () => {
  const st = S.create({ scenario: 'history', seed: 1 });
  assert.ok(st.flares.length > 20);
  assert.strictEqual(st.storms.length, 4);
  assert.ok(st.storms.some((s) => s.strong), 'the 2024-05-11 storm (>100 MeV) is strong');
});

test('doing nothing fails in the first long shadow (habitat gets cold)', () => {
  const st = play('history', 1);
  assert.strictEqual(st.status, 'lost');
  assert.strictEqual(st.failure.cause, 'cold');
  const d = S.debrief(st);
  assert.ok(d.chain.some((c) => /battery ran empty/i.test(c.text)), 'debrief explains the battery step');
});

test('no ice drill → runs out of water', () => {
  const st = play('history', 1, (s) => { build(s, 'solar', 'ridge'); build(s, 'solar', 'ridge'); build(s, 'battery', 'plain'); build(s, 'battery', 'plain'); });
  assert.strictEqual(st.failure && st.failure.cause, 'water');
});

test('a sensible plan wins, in history and in several random missions', () => {
  assert.strictEqual(play('history', 1, goodSetup, shelterBot).status, 'won');
  for (let seed = 1; seed <= 8; seed++) assert.strictEqual(play('training', seed, goodSetup, shelterBot).status, 'won', 'seed ' + seed);
});

test('the shelter cuts storm radiation a lot', () => {
  const sheltered = play('history', 1, goodSetup, shelterBot).doseFrom.storm;
  const exposed = play('history', 1, goodSetup).doseFrom.storm;
  assert.ok(exposed > sheltered * 3, `exposed ${exposed} vs sheltered ${sheltered}`);
});

test('working outside during the strong storm is dangerous', () => {
  const st = play('history', 1, goodSetup, (s) => { if (s.hour === 238) S.startBerm(s); });
  assert.ok(st.doseFrom.outside > 60, 'outside dose ' + st.doseFrom.outside);
});

test('each coming shadow is warned about exactly once', () => {
  const titles = [];
  play('history', 1, goodSetup, (s, ev) => { for (const e of ev) if (/^Forecast: shadow/.test(e.title)) titles.push(e.title); });
  // Plain has 2 shadow periods, ridge has 1, and this plan has panels on both.
  assert.strictEqual(titles.filter((t) => /plain/.test(t)).length, 2, titles.join(' | '));
  assert.strictEqual(titles.filter((t) => /ridge/.test(t)).length, 1, titles.join(' | '));
});

test('countdown bar: cargo always shown, storm only after its warning', () => {
  const st = S.create({ scenario: 'history', seed: 1 });
  goodSetup(st);
  const first = S.upcoming(st, 0);
  assert.ok(first.some((i) => i.kind === 'cargo' && Math.abs(i.left - 240) < 1e-9));
  assert.ok(!first.some((i) => i.kind === 'storm'), 'no storm countdown before the warning');
  const storm = st.storms[0];
  while (!storm.warned) S.step(st);
  const s = S.upcoming(st, st.hour).find((i) => i.kind === 'storm');
  assert.ok(s, 'storm countdown appears after the warning');
  assert.ok(s.left > 1 && s.left <= 2, 'countdown should start near 2 h, got ' + s.left);
  while (st.hour < Math.ceil(storm.h) + 3) S.step(st);
  assert.ok(S.upcoming(st, st.hour).some((i) => i.kind === 'stormActive'), 'active storm shows when it ends');
});

test('radiation storm warnings do not pause the game or open a pop-up', () => {
  const evs = [];
  play('history', 1, goodSetup, (s, ev) => evs.push(...ev.filter((e) => /radiation storm incoming/i.test(e.title))));
  assert.strictEqual(evs.length, 4, 'one CAPCOM message per storm');
  assert.ok(evs.every((e) => !e.pause && !e.banner && !e.decision));
});

test('building rules', () => {
  const st = S.create({ scenario: 'training', seed: 2 });
  const ridge = freeTile(st, 'ridge', 'solar'), ice = freeTile(st, 'ice', 'drill');
  assert.strictEqual(S.canPlace(st, 'drill', ridge.c, ridge.r).ok, false, 'drill only on ice');
  assert.strictEqual(S.canPlace(st, 'drill', ice.c, ice.r).ok, true);
  const B = globalThis.MT.CONFIG.base;
  assert.strictEqual(S.canPlace(st, 'solar', B.c + 1, B.r + 1).ok, false, 'not on top of the habitat');
  assert.strictEqual(S.canPlace(st, 'solar', -1, 0).ok, false, 'not outside the map');
  const before = st.res.parts;
  const r = S.place(st, 'solar', ridge.c, ridge.r);
  assert.ok(S.cancel(st, r.m.id));
  assert.strictEqual(st.res.parts, before, 'cancel refunds parts');
});

test('light fades gradually and solar power follows it', () => {
  const st = S.create({ scenario: 'history', seed: 1 });
  const vals = [];
  for (let h = 160; h <= 200; h++) vals.push(S.zoneLight(st, 'plain', h));
  assert.ok(vals.some((v) => v > 0.2 && v < 0.8), 'there are in-between light levels');
  for (let i = 1; i < vals.length; i++) assert.ok(Math.abs(vals[i] - vals[i - 1]) < 0.15, 'no sudden jump at hour ' + (160 + i));
  assert.strictEqual(S.zoneLight(st, 'ice', 100), 0, 'ice crater never sees the Sun');
});
