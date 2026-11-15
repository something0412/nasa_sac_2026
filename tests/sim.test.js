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
  // Like an alert player: watches the countdown bar (and the red "storm active" bar) and shelters.
  const on = globalThis.MT.CONFIG.rad.stormOn;
  const coming = S.upcoming(st, st.hour).some((i) => i.kind === 'storm') || st.stormRate > on;
  if (coming && S.hasShelter(st)) S.setShelter(st, true);
  if (st.sheltering && st.stormRate < on && !st.storms.some((s) => s.h > st.hour - 3 && s.h < st.hour + 3)) S.setShelter(st, false);
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

test('May 2024 storm radiation is the real LRO measurement, hour by hour', () => {
  const st = S.create({ scenario: 'history', seed: 1 });
  assert.ok(st.radCurve && st.radCurve.length >= 720, 'RadLab curve loaded');
  const peakHour = st.radCurve.slice(0, 720).reduce((best, v, i, a) => (v > a[best] ? i : best), 0);
  assert.strictEqual(Math.floor(peakHour / 24) + 1, 14, 'LRO saw the highest dose rate on 14 May 2024');
  // Real May 2024 was survivable even without the shelter, but the shelter still cuts the dose.
  const ignored = play('history', 1, goodSetup);
  assert.strictEqual(ignored.status, 'won');
  assert.ok(ignored.crew.every((a) => !a.medbay), 'nobody ends up in the medbay in May 2024: ' + ignored.crew.map((a) => Math.round(a.hp)).join(','));
});

test('training storms are copies of real recorded storms, and a big one needs the shelter', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const st = S.create({ scenario: 'training', seed });
    assert.ok(st.storms.every((s) => s.profile && s.realName), 'seed ' + seed + ' uses real storm shapes');
    assert.strictEqual(st.storms.filter((s) => s.strong).length, 1, 'exactly one big storm');
    const ignored = play('training', seed, goodSetup);
    const lost = ignored.failure && ignored.failure.cause === 'crew';
    const best = Math.max(...ignored.crew.map((a) => a.hp));
    assert.ok(lost || best < 40, `seed ${seed}: ignoring a big storm costs most of everyone's health (best ${Math.round(best)} HP)`);
  }
});

test('working outside during a big real storm sends that astronaut to the medbay', () => {
  // Seed 5 gets a copy of the January 2012 storm at hour ~250. One astronaut goes out to pile moon dirt.
  let worker = null;
  const st = play('training', 5, goodSetup, (s) => {
    if (s.hour === 250) S.startBerm(s);
    if (!worker) worker = s.crew.find((a) => a.job === 'berm') || null;
  });
  assert.ok(worker, 'someone took the shielding job');
  assert.strictEqual(worker.medbay, true, worker.name + ' should be in the medbay');
  assert.ok(st.doseFrom.outside > 100, 'outside dose ' + st.doseFrom.outside);
});

// ---------------- Astronaut Management System ----------------
test('crew: 4 named astronauts; each job gets exactly one, at most maxOutside outside', () => {
  const C = globalThis.MT.CONFIG;
  const st = S.create({ scenario: 'training', seed: 3 });
  assert.deepStrictEqual(st.crew.map((a) => a.name), ['Astronaut 1', 'Astronaut 2', 'Astronaut 3', 'Astronaut 4']);
  build(st, 'solar', 'plain'); build(st, 'solar', 'plain'); build(st, 'battery', 'plain');
  S.step(st);
  const jobs = S.jobList(st);
  const workers = st.crew.filter((a) => a.where === 'outside');
  assert.strictEqual(workers.length, C.maxOutside);
  assert.strictEqual(new Set(workers.map((a) => a.job)).size, workers.length, 'never two astronauts on one job');
  assert.strictEqual(jobs.filter((j) => j.worker).length, C.maxOutside);
  // A 6-crew-hour solar panel now takes 6 hours (one astronaut), not 3.
  const first = st.modules.find((m) => m.type === 'solar' && !m.built);
  for (let i = 0; i < 5; i++) S.step(st);
  assert.strictEqual(first.built, true);
});

test('health: 600 mSv = all health, so living in the habitat lasts about 2 years', () => {
  const C = globalThis.MT.CONFIG;
  const hpPerDay = C.rad.surfacePerH * 24 * C.rad.hab * C.astro.hpPerMsv;
  const days = 100 / hpPerDay;
  assert.ok(days > 730 && days < 1000, 'habitat-only survival ~' + Math.round(days) + ' days');
});

test('medbay: astronauts with no health leave, stop eating, and the mission ends when none are left', () => {
  const st = S.create({ scenario: 'training', seed: 2 });
  goodSetup(st);
  st.crew[0].wounds.push({ hp: 200, what: 'test' }); st.crew[0].injury = 200; // out of health
  S.step(st);
  assert.strictEqual(st.crew[0].medbay, true);
  const before = st.stats.foodEaten;
  S.step(st);
  const eaten = st.stats.foodEaten - before;
  assert.ok(Math.abs(eaten - globalThis.MT.CONFIG.use.foodPerPersonH * 3) < 1e-6, 'only 3 astronauts eat: ' + eaten);
  for (const a of st.crew) { a.wounds.push({ hp: 200, what: 'test' }); a.injury = 200; }
  S.step(st);
  assert.strictEqual(st.status, 'lost');
  assert.strictEqual(st.failure.cause, 'crew');
  assert.ok(S.debrief(st).chain.some((c) => /medbay/.test(c.text)));
});

test('bones: a Fitness Center keeps them strong; without one astronauts get grounded', () => {
  const B = globalThis.MT.CONFIG.astro.bone;
  const withGym = play('history', 1, (s) => { goodSetup(s); build(s, 'gym', 'plain'); }, shelterBot);
  const noGym = play('history', 1, goodSetup, shelterBot);
  assert.ok(withGym.crew.every((a) => a.bone > 90), 'with gym: ' + withGym.crew.map((a) => Math.round(a.bone)).join(','));
  assert.ok(noGym.crew.every((a) => a.bone < B.groundedBelow), 'no gym: ' + noGym.crew.map((a) => Math.round(a.bone)).join(','));
  assert.ok(noGym.crew.some((a) => a.injuries > 0), 'weak bones cause small injuries');
});

test('bones: 50% fragile and 25% severe make injuries worse; 0% = medbay for good', () => {
  const B = globalThis.MT.CONFIG.astro.bone;
  const st = S.create({ scenario: 'training', seed: 7 });
  const [a, b, c] = st.crew;
  a.bone = B.fragileBelow - 1; b.bone = B.severeBelow - 1; c.bone = 0.01;
  const stressA = a.stress, stressB = b.stress;
  for (let i = 0; i < 200 && !(a.wounds.length && b.wounds.length); i++) { S.step(st); a.bone = Math.min(a.bone, B.fragileBelow - 1); b.bone = Math.min(b.bone, B.severeBelow - 1); }
  assert.strictEqual(a.wounds[0].hp, B.injuryHp * B.fragileMult, 'fragile: bigger fractures');
  assert.strictEqual(b.wounds[0].hp, B.injuryHp * B.severeMult, 'severe: even bigger');
  assert.ok(a.stress > stressA && b.stress > stressB, 'worry adds stress');
  assert.strictEqual(c.medbay, true);
  assert.strictEqual(c.medbayWhy, 'bones');
});

test('medbay healing: 3 days, exactly 10 HP (smallest injuries first), never above the radiation limit, 2 uses per mission', () => {
  const C = globalThis.MT.CONFIG, M = C.astro.medbay;
  const st = S.create({ scenario: 'training', seed: 2 });
  const [a, b, c] = st.crew;
  a.dose = 120; // 20 HP of radiation damage: can never come back
  a.wounds.push({ hp: 15, what: 'meteoroid hit' }, { hp: 5, what: 'sprain' }); a.injury = 20;
  assert.strictEqual(S.startHeal(st, b.id).ok, false, 'no injuries = nothing to heal');
  const r = S.startHeal(st, a.id);
  assert.ok(r.ok); assert.strictEqual(r.amount, M.healHp, 'always heals 10');
  S.step(st);
  const before = S.maxHp(a) - 20;
  assert.strictEqual(a.where, 'medbay');
  assert.strictEqual(a.job, null);
  for (let i = 1; i < M.healH; i++) { assert.ok(a.heal, 'still healing at hour ' + i); S.step(st); }
  assert.strictEqual(a.heal, null, `done after ${M.healH} hours`);
  assert.deepStrictEqual(a.wounds.map((w) => [w.what, Math.round(w.hp)]), [['meteoroid hit', 10]], 'sprain (5) gone first, then 5 off the meteoroid hit');
  assert.ok(Math.abs(a.injury - 10) < 1e-6, 'exactly 10 HP healed: injuries 20 → 10');
  assert.ok(a.hp > before && a.hp <= S.maxHp(a) + 1e-9 && S.maxHp(a) < 80, 'radiation sets the ceiling');
  // Less than 10 HP of injuries: it heals up to the radiation limit, never past it.
  b.wounds.push({ hp: 4, what: 'sprain' }); b.injury = 4;
  assert.strictEqual(S.healAmount(b), 4);
  // Only 2 treatments in the whole mission.
  c.wounds.push({ hp: 4, what: 'sprain' }); c.injury = 4;
  assert.ok(S.startHeal(st, b.id).ok);
  assert.strictEqual(S.startHeal(st, c.id).ok, false, 'third treatment refused');
  assert.strictEqual(st.medbayUses, M.uses);
});

test('stress: rises outside; the first look through each NEW tower lowers it once', () => {
  const C = globalThis.MT.CONFIG;
  const st = S.create({ scenario: 'training', seed: 4 });
  const t = freeTile(st, 'plain', 'tower');
  const tower = S.place(st, 'tower', t.c, t.r).m;
  while (!tower.built) S.step(st);
  const builder = st.crew.find((a) => a.stress > 0);
  assert.ok(builder && builder.stress >= C.astro.stress.outsidePerH * 5, 'building outside raised stress');
  const before = builder.stress;
  assert.strictEqual(S.enterTower(st, tower.id).relief, true);
  assert.ok(builder.stress < before, 'first look lowers stress');
  const after = builder.stress;
  assert.strictEqual(S.enterTower(st, tower.id).relief, false, 'only the first look counts');
  assert.strictEqual(builder.stress, after);
});

test('damage: half output until repaired; damaged towers cannot be entered; repair costs 1 part and 1 astronaut', () => {
  const C = globalThis.MT.CONFIG;
  const st = S.create({ scenario: 'training', seed: 6 });
  const t = freeTile(st, 'plain', 'tower');
  const tower = S.place(st, 'tower', t.c, t.r).m;
  while (!tower.built) S.step(st);
  tower.damaged = true;
  assert.strictEqual(S.enterTower(st, tower.id).ok, false);
  const parts = st.res.parts;
  assert.ok(S.orderRepair(st, tower.id).ok);
  assert.strictEqual(st.res.parts, parts - C.damage.repairCost);
  assert.strictEqual(S.orderRepair(st, tower.id).ok, false, 'no double repair');
  S.step(st);
  assert.strictEqual(st.crew.filter((a) => a.job === 'r' + tower.id).length, 1, 'exactly one astronaut repairs');
  while (tower.damaged) S.step(st);
  assert.strictEqual(S.enterTower(st, tower.id).ok, true);
});

test('meteor showers: forecast, then damage risk; May 2024 has the real Eta Aquariids', () => {
  const h = S.create({ scenario: 'history', seed: 1 });
  assert.strictEqual(h.meteors[0].name, 'Eta Aquariids');
  for (let seed = 1; seed <= 5; seed++) assert.ok(S.create({ scenario: 'training', seed }).meteors.length >= 1);
  const st = S.create({ scenario: 'history', seed: 1 });
  let warned = false, active = false;
  while (st.hour < h.meteors[0].h + 1) {
    const ev = S.step(st);
    if (ev.some((e) => /Meteor shower coming/.test(e.title))) warned = st.hour;
    if (st.meteorOn) active = true;
  }
  assert.ok(warned && warned <= h.meteors[0].h - 4, 'forecast hours before it starts');
  assert.ok(active);
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
  // With real LRO data the dose doesn't rise exactly at the DONKI alert time, so wait until it really does.
  const on = globalThis.MT.CONFIG.rad.stormOn;
  let guard = 0;
  while (st.stormRate <= on && st.status === 'running' && guard++ < 200) S.step(st);
  assert.ok(st.stormRate > on, 'a radiation storm actually arrives');
  const active = S.upcoming(st, st.hour).find((i) => i.kind === 'stormActive');
  assert.ok(active && active.left > 0, 'active storm shows when it ends');
});

test('radiation storm warnings do not pause the game or open a pop-up', () => {
  const evs = [];
  play('history', 1, goodSetup, (s, ev) => evs.push(...ev.filter((e) => /radiation (storm incoming|is rising again)/i.test(e.title))));
  assert.strictEqual(evs.filter((e) => /incoming/i.test(e.title)).length, 4, 'one CAPCOM message per storm');
  assert.ok(evs.every((e) => !e.pause && !e.banner && !e.decision), 'no pop-up, no pause, no banner for radiation');
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
