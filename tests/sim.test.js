// Run: node --test tests/sim.test.js   (from the project root)
// Plays whole missions with simple "bot" strategies to check the game is winnable but not too easy.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

globalThis.window = globalThis;
require(path.join(__dirname, '../data/may2024.js'));
require(path.join(__dirname, '../data/radlab.js'));
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
  if (st.sheltering && st.stormRate < globalThis.MT.CONFIG.rad.stormOn && !st.storms.some((s) => s.h > st.hour - 3 && s.h < st.hour + 3)) S.setShelter(st, false);
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

test('May 2024 storm radiation is the real LRO measurement, hour by hour', () => {
  const st = S.create({ scenario: 'history', seed: 1 });
  assert.ok(st.radCurve && st.radCurve.length >= 720, 'RadLab curve loaded');
  const peakHour = st.radCurve.slice(0, 720).reduce((best, v, i, a) => (v > a[best] ? i : best), 0);
  assert.strictEqual(Math.floor(peakHour / 24) + 1, 14, 'LRO saw the highest dose rate on 14 May 2024');
  // Real May 2024 was survivable even without the shelter, but the shelter still cuts the dose.
  const ignored = play('history', 1, goodSetup);
  assert.strictEqual(ignored.status, 'won');
  assert.ok(ignored.dose < globalThis.MT.CONFIG.rad.limit / 2, 'dose ' + ignored.dose);
});

test('training storms are copies of real recorded storms, and a big one needs the shelter', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const st = S.create({ scenario: 'training', seed });
    assert.ok(st.storms.every((s) => s.profile && s.realName), 'seed ' + seed + ' uses real storm shapes');
    assert.strictEqual(st.storms.filter((s) => s.strong).length, 1, 'exactly one big storm');
    const ignored = play('training', seed, goodSetup);
    assert.strictEqual(ignored.failure && ignored.failure.cause, 'radiation', 'seed ' + seed + ': ignoring a big storm is deadly');
  }
});

test('working outside during a big real storm is deadly', () => {
  // Seed 5 gets a copy of the January 2012 storm at hour ~250.
  const st = play('training', 5, goodSetup, (s) => { if (s.hour === 250) S.startBerm(s); });
  assert.strictEqual(st.failure && st.failure.cause, 'radiation');
  assert.ok(st.doseFrom.outside > 100, 'outside dose ' + st.doseFrom.outside);
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

test('Astronomy Tower: buildable anywhere, uses no power, cannot be switched off', () => {
  const st = S.create({ scenario: 'training', seed: 3 });
  const r = S.place(st, 'tower', 4, 4);
  assert.ok(r.ok, 'tower placed');
  while (!r.m.built) S.step(st);
  assert.strictEqual(S.needOf(st, r.m), 0);
  assert.strictEqual(S.toggle(st, r.m.id), false, 'click opens the picture instead of toggling');
});

test('APOD feed: picks the newest IMAGE post, asks for a smaller copy, strips HTML', () => {
  require(path.join(__dirname, '../js/apod.js'));
  const p = globalThis.MT.APOD._pick([
    { media_type: 'video', hdurl: '', title: 'A video day' },
    { media_type: 'image', date: '2026-11-14', title: 'Apollo 12 &amp; Surveyor 3', explanation: '<strong>Explanation:</strong> Put on <a href="x">glasses</a>.',
      credit: '<a href="y">NASA</a>', permalink: 'https://science.nasa.gov/image-article/x/',
      hdurl: 'https://assets.science.nasa.gov/dynamicimage/a.jpg?w=4000&h=3000&fit=clip&crop=faces%2Cfocalpoint' },
  ]);
  assert.strictEqual(p.title, 'Apollo 12 & Surveyor 3');
  assert.strictEqual(p.text, 'Put on glasses.', 'tags and the "Explanation:" label are removed');
  assert.strictEqual(p.credit, 'NASA');
  assert.match(p.image, /w=1400&h=1400&fit=clip$/);
  assert.strictEqual(globalThis.MT.APOD._pick([{ media_type: 'image', hdurl: 'javascript:alert(1)' }]), null, 'only https images');
});

test('first built tower shows today; later towers show the archive', () => {
  const st = S.create({ scenario: 'training', seed: 4 });
  const a = S.place(st, 'tower', 4, 4).m, b = S.place(st, 'tower', 5, 4).m;
  assert.strictEqual(S.firstTower(st), null, 'nothing built yet');
  while (!a.built || !b.built) S.step(st);
  assert.strictEqual(S.firstTower(st), a);
});

test('archive picture: random week between 1995-06-16 and the day before today, skips videos and placeholders', async () => {
  require(path.join(__dirname, '../js/apod.js'));
  const A = globalThis.MT.APOD;
  const urls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    urls.push(url);
    const today = { media_type: 'image', date: '2026-11-14', title: 'Today', hdurl: 'https://assets.science.nasa.gov/t.jpg' };
    const list = /date_from/.test(url) ? [
      { media_type: 'video', date: '1999-07-06', hdurl: 'https://assets.science.nasa.gov/v.jpg' },
      { media_type: 'image', date: '1999-07-05', hdurl: 'https://assets.science.nasa.gov/dynamicimage/assets/science/astro/programs/cosmic-origins/images/misc/news-thumbnail.png?w=594' },
      { media_type: 'image', date: '1999-07-04', title: 'Mars Pathfinder', hdurl: 'https://assets.science.nasa.gov/content/dam/x.jpg' },
    ] : [today];
    return { ok: true, json: async () => list };
  };
  try {
    let n = 0;
    const p = await A._archivePicture(() => [0.5, 0][n++ % 2]);
    assert.strictEqual(p.date, '1999-07-04', 'video and placeholder skipped');
    assert.strictEqual(p.archive, true);
    const q = urls.find((u) => /date_from/.test(u));
    const [, from, to] = q.match(/date_from=(\d{6})&date_to=(\d{6})/);
    const toDate = (s) => Date.UTC((+s.slice(0, 2) < 90 ? 2000 : 1900) + +s.slice(0, 2), +s.slice(2, 4) - 1, +s.slice(4, 6));
    assert.ok(toDate(from) >= Date.UTC(1995, 5, 16) && toDate(to) < Date.UTC(2026, 10, 14), from + '..' + to);
    assert.strictEqual(A._yymmdd(Date.UTC(1995, 5, 16)), '950616');
  } finally { globalThis.fetch = realFetch; }
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
