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

const goodSetup = (st) => {
  for (const [t, c, r] of [['solar', 1, 1], ['solar', 2, 1], ['solar', 3, 0], ['battery', 12, 6], ['battery', 12, 7], ['shelter', 10, 9], ['drill', 15, 9]]) {
    assert.ok(S.place(st, t, c, r).ok, `place ${t}`);
  }
};
const shelterBot = (st, ev) => {
  for (const e of ev) if (e.decision === 'shelter') S.setShelter(st, true);
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
  const st = play('history', 1, (s) => { S.place(s, 'solar', 1, 1); S.place(s, 'solar', 2, 1); S.place(s, 'battery', 12, 6); S.place(s, 'battery', 12, 7); });
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

test('building rules', () => {
  const st = S.create({ scenario: 'training', seed: 2 });
  assert.strictEqual(S.canPlace(st, 'drill', 1, 1).ok, false, 'drill only on ice');
  assert.strictEqual(S.canPlace(st, 'drill', 16, 10).ok, true);
  assert.strictEqual(S.canPlace(st, 'solar', 8, 6).ok, false, 'not on top of the habitat');
  const before = st.res.parts;
  const r = S.place(st, 'solar', 3, 3);
  assert.ok(S.cancel(st, r.m.id));
  assert.strictEqual(st.res.parts, before, 'cancel refunds parts');
});
