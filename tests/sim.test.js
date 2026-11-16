// Written with help from Claude Code (AI); reviewed and tested by the team.
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
const S = globalThis.LW.Sim;

// The game is endless, so a test plays until the base closes or `hours` have passed (default: 30 days).
function play(scenario, seed, setup, each, hours) {
  const st = S.create({ scenario, seed });
  if (setup) setup(st);
  const until = hours || 720;
  while (st.status === 'running' && st.hour < until) {
    const ev = S.step(st);
    for (const e of ev) if (e.decision === 'cargo') S.chooseCargo(st, e.cargoIndex, 'food');
    if (each) each(st, ev);
  }
  return st;
}

// Nearest free tile of a zone, measured from the habitat (so tests survive map changes).
function freeTile(st, zone, type) {
  const C = globalThis.LW.CONFIG, B = C.base;
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
  const on = globalThis.LW.CONFIG.rad.stormOn;
  const coming = S.upcoming(st, st.hour).some((i) => i.kind === 'storm') || st.stormRate > on;
  if (coming && S.hasShelter(st)) S.setShelter(st, true);
  if (st.sheltering && st.stormRate < on && !st.storms.some((s) => s.h > st.hour - 3 && s.h < st.hour + 3)) S.setShelter(st, false);
};

test('real May 2024 data is loaded and lines up with the mission', () => {
  const st = S.create({ scenario: 'history', seed: 1 });
  assert.ok(st.flares.length > 20);
  assert.strictEqual(st.storms.filter((s) => s.h < 720).length, 4, 'the 4 real storms of May 2024 (random weather after day 30)');
  assert.ok(st.storms.some((s) => s.strong), 'the 2024-05-11 storm (>100 MeV) is strong');
});

test('doing nothing fails in the first long shadow (habitat gets cold)', () => {
  const st = play('history', 1, null, null, 3000);
  assert.strictEqual(st.status, 'lost', 'the cold sends everyone home');
  assert.strictEqual(st.failure.reason, 'cold');
  const d = S.debrief(st);
  assert.ok(d.chain.some((c) => /battery ran empty/i.test(c.text)), 'debrief explains the battery step');
});

test('no ice drill → runs out of water', () => {
  const st = play('history', 1, (s) => { build(s, 'solar', 'ridge'); build(s, 'solar', 'ridge'); build(s, 'battery', 'plain'); build(s, 'battery', 'plain'); }, null, 3000);
  assert.strictEqual(st.failure && st.failure.reason, 'water', 'water ran out first');
  assert.ok(S.debrief(st).chain.some((c) => /water tank ran dry/.test(c.text)));
});

test('a sensible plan wins, in history and in several random missions', () => {
  assert.strictEqual(play('history', 1, goodSetup, shelterBot).status, 'running', 'still going after 30 days');
  for (let seed = 1; seed <= 8; seed++) assert.strictEqual(play('training', seed, goodSetup, shelterBot).status, 'running', 'seed ' + seed);
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
  assert.strictEqual(ignored.status, 'running');

  assert.ok(ignored.crew.length === 4 && ignored.crew.every((a) => !a.medbay), 'nobody is sent home in May 2024: ' + ignored.crew.map((a) => Math.round(a.hp)).join(','));
});

test('training storms are copies of real recorded storms, and a big one needs the shelter', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const st = S.create({ scenario: 'training', seed });
    assert.ok(st.storms.every((s) => s.profile && s.realName), 'seed ' + seed + ' uses real storm shapes');
    assert.strictEqual(st.storms.filter((s) => s.strong && s.h < 720).length, 1, 'exactly one big storm in each 30 days');
    assert.strictEqual(st.storms.filter((s) => s.strong && s.h >= 720 && s.h < 1440).length, 1, 'and in the next 30 days too');
    const ignored = play('training', seed, goodSetup);
    const lost = ignored.failure && ignored.failure.cause === 'crew';
    const best = Math.max(...ignored.crew.map((a) => a.hp));
    assert.ok(lost || best < 40, `seed ${seed}: ignoring a big storm costs most of everyone's health (best ${Math.round(best)} HP)`);
  }
});

test('working outside during a big real storm gets that astronaut sent home to Earth', () => {
  // Seed 5 gets a copy of the January 2012 storm at hour ~250. One astronaut goes out to pile moon dirt.
  let worker = null;
  const st = play('training', 5, goodSetup, (s) => {
    if (s.hour === 250) S.startBerm(s);
    if (!worker) worker = s.crew.find((a) => a.job === 'berm') || null;
  });
  assert.ok(worker, 'someone took the shielding job');
  assert.strictEqual(worker.home, true, worker.name + ' should be sent home');
  assert.ok(st.sentHome.includes(worker) && !st.crew.includes(worker), 'and is gone from the roster');
  assert.ok(st.doseFrom.outside > 100, 'outside dose ' + st.doseFrom.outside);
});

// ---------------- Astronaut Management System ----------------
test('crew: 4 named astronauts with roles; each job gets exactly one Engineer', () => {
  const st = S.create({ scenario: 'training', seed: 3 });
  assert.deepStrictEqual(st.crew.map((a) => a.name), ['Astronaut 1', 'Astronaut 2', 'Astronaut 3', 'Astronaut 4']);
  assert.deepStrictEqual(st.crew.map((a) => a.role), ['engineer', 'engineer', 'scientist', 'botanist']);
  build(st, 'solar', 'plain'); build(st, 'solar', 'plain'); build(st, 'battery', 'plain');
  S.step(st);
  const jobs = S.jobList(st);
  const workers = st.crew.filter((a) => a.where === 'outside');
  assert.deepStrictEqual(workers.map((a) => a.id), [1, 2], 'only the two Engineers go out');
  assert.strictEqual(new Set(workers.map((a) => a.job)).size, workers.length, 'never two astronauts on one job');
  assert.strictEqual(jobs.filter((j) => j.active).length, 2);
  // A 6-crew-hour solar panel takes 6 hours of work (one astronaut, not 3), counted from when they reach it.
  const first = st.modules.find((m) => m.type === 'solar' && !m.built);
  const walk = st.crew.find((a) => a.job === 'b' + first.id).walk.total;
  assert.ok(walk > 0, 'they walk there first');
  for (let i = 0; i < 5; i++) S.step(st);
  assert.strictEqual(first.built, false, 'not done 6 hours after leaving: the walk came first');
  while (st.hour < Math.ceil(walk) + 6) S.step(st);
  assert.strictEqual(first.built, true);
});

test('walking: the Engineer walks from the HAB to the site, and the work only starts when they arrive', () => {
  const C = globalThis.LW.CONFIG;
  const st = S.create({ scenario: 'training', seed: 4 });
  st.res.parts = 50;
  const H = S.habs(st)[0];
  // A spot about 18 squares from the HAB centre: 3 hours of walking at 6 squares an hour.
  let spot = null;
  for (let dc = 17; dc < 30 && !spot; dc++) for (const dr of [0, 1, -1, 2, -2]) if (!spot && S.canPlace(st, 'battery', H.c + 1 + dc, H.r + dr).ok) spot = { c: H.c + 1 + dc, r: H.r + dr };
  if (!spot) for (let dc = 17; dc < 30 && !spot; dc++) for (const dr of [0, 1, -1, 2, -2]) if (!spot && S.canPlace(st, 'battery', H.c - dc, H.r + dr).ok) spot = { c: H.c - dc, r: H.r + dr };
  assert.ok(spot, 'found a far spot');
  const m = S.place(st, 'battery', spot.c, spot.r, 1).m, eng = st.crew[0];
  const dist = Math.hypot(spot.c + 0.5 - (H.c + 1), spot.r + 0.5 - (H.r + 1));
  S.step(st);
  assert.strictEqual(eng.where, 'outside', 'they are outside (and exposed) while walking');
  assert.ok(Math.abs(eng.walk.total - dist / C.walk.tilesPerH) < 1e-9, 'walk time = distance / walking speed');
  const walkH = Math.ceil(eng.walk.total);
  assert.strictEqual(walkH, 3);
  for (let i = 1; i < walkH; i++) S.step(st);
  assert.strictEqual(m.progress, 0, 'no work while still walking');
  assert.ok(S.walkLeft(eng, st.hour - 1) > 0);
  S.step(st);
  assert.strictEqual(m.progress, 1, 'work starts once they are there');
  const done = walkH + C.modules.battery.work;
  while (!m.built && st.hour < 100) S.step(st);
  assert.strictEqual(st.hour, done, 'built = walk + work hours');
  // Next job straight from that site: the walk starts where they are, not at the HAB.
  st.res.parts = 50;
  let next = null;
  for (let dr = 2; dr < 6 && !next; dr++) if (S.canPlace(st, 'battery', spot.c, spot.r + dr).ok) next = { c: spot.c, r: spot.r + dr };
  const m2 = S.place(st, 'battery', next.c, next.r, 1).m;
  S.step(st);
  assert.ok(Math.abs(eng.walk.from.c - (spot.c + 0.5)) < 1e-9 && Math.abs(eng.walk.from.r - (spot.r + 0.5)) < 1e-9, 'walks on from the last site');
  assert.ok(eng.walk.total < 1, 'a short walk this time');
  assert.ok(!m2.built);
  // Shelter: they go in; afterwards the walk starts again from the HAB.
  const sh = freeTile(st, 'plain', 'shelter'); instant(st, 'shelter', sh.c, sh.r);
  assert.ok(S.setShelter(st, true)); S.step(st);
  assert.strictEqual(eng.walk, null);
  S.setShelter(st, false); S.step(st);
  assert.ok(Math.abs(eng.walk.from.c - (H.c + 1)) < 1e-9 && Math.abs(eng.walk.from.r - (H.r + 1)) < 1e-9, 'out of the HAB again');
});

test('instant orders: an order given halfway through an hour starts the walk right then; work starts after arrival', () => {
  const st = S.create({ scenario: 'training', seed: 4 });
  st.res.parts = 50;
  const H = S.habs(st)[0];
  let spot = null;
  for (let dc = 9; dc < 20 && !spot; dc++) if (S.canPlace(st, 'battery', H.c + 1 + dc, H.r).ok) spot = { c: H.c + 1 + dc, r: H.r };
  S.step(st); // the clock is now in hour 1 (the screen shows hour 0 .. 1)
  const m = S.place(st, 'battery', spot.c, spot.r, 1).m, eng = st.crew[0];
  S.applyOrders(st, 0.5); // the player clicked halfway through the hour
  assert.strictEqual(eng.where, 'outside', 'goes out at once');
  assert.strictEqual(eng.walk.startH, st.hour - 1 + 0.5, 'the walk starts at the moment of the order');
  const arrive = eng.walk.startH + eng.walk.total;
  assert.ok(S.walkPoint(st, eng, 0.6), 'on the way a moment later');
  while (st.hour < arrive) { S.step(st); assert.strictEqual(m.progress, 0, 'no work before they get there'); }
  S.step(st);
  assert.ok(m.progress > 0, 'work starts once they are there');
});

test('health: 600 mSv = all health, so living in the habitat lasts about 2 years', () => {
  const C = globalThis.LW.CONFIG;
  const hpPerDay = C.rad.surfacePerH * 24 * C.rad.hab * C.astro.hpPerMsv;
  const days = 100 / hpPerDay;
  assert.ok(days > 730 && days < 1000, 'habitat-only survival ~' + Math.round(days) + ' days');
});

test('sent home: an astronaut whose health runs out leaves the roster (pop-up), stops eating; all gone = mission over', () => {
  const st = S.create({ scenario: 'training', seed: 2 });
  goodSetup(st);
  const first = st.crew[0];
  first.dose = 600; // the whole health bar is radiation
  const ev = S.step(st);
  const pop = ev.find((e) => e.popup === 'home');
  assert.ok(pop && pop.who === 'Astronaut 1' && pop.left === 3, 'pop-up event for the player');
  assert.deepStrictEqual(st.crew.map((a) => a.id), [2, 3, 4], 'gone from the roster');
  assert.strictEqual(st.sentHome[0], first);
  assert.strictEqual(S.crewSummary(st).total, 4);
  assert.strictEqual(S.useTower(st, 999, 1).ok, false);
  const before = st.stats.foodEaten;
  S.step(st);
  const eaten = st.stats.foodEaten - before;
  assert.ok(Math.abs(eaten - globalThis.LW.CONFIG.use.foodPerPersonH * 3) < 1e-6, 'only 3 astronauts eat: ' + eaten);
  for (const a of st.crew) { a.wounds.push({ hp: 200, what: 'test' }); a.injury = 200; }
  S.step(st);
  assert.strictEqual(st.status, 'lost');
  assert.strictEqual(st.failure.cause, 'crew');
  assert.strictEqual(st.crew.length, 0);
  const d = S.debrief(st);
  assert.strictEqual(d.title, 'Every astronaut was sent home to Earth');
  assert.strictEqual(d.chain.filter((c) => /sent home to Earth/.test(c.text)).length, 4);
});

test('bones at 0% still means the medbay on the Moon (they stay on the roster)', () => {
  const st = S.create({ scenario: 'training', seed: 3 });
  st.crew[1].bone = 0.01;
  S.step(st);
  assert.strictEqual(st.crew.length, 4);
  assert.strictEqual(st.crew[1].medbay, true);
  assert.strictEqual(st.sentHome.length, 0);
});


test('bones: the player sends astronauts to the Fitness Center (never automatic); without it they get grounded', () => {
  const B = globalThis.LW.CONFIG.astro.bone;
  const lazy = play('history', 1, (s) => { goodSetup(s); build(s, 'gym', 'plain'); }, shelterBot);
  assert.ok(lazy.crew.every((a) => a.bone < B.groundedBelow), 'a gym nobody is sent to does nothing: ' + lazy.crew.map((a) => Math.round(a.bone)).join(','));
  const gymBot = (s, ev) => {
    shelterBot(s, ev);
    const g = S.built(s, 'gym')[0];
    if (g) for (const a of S.activeCrew(s)) if (a.sinceGym >= B.visitEveryH - 2) S.sendToGym(s, g.id, a.id);
  };
  const withGym = play('history', 1, (s) => { goodSetup(s); build(s, 'gym', 'plain'); }, gymBot);

  const noGym = play('history', 1, goodSetup, shelterBot);
  assert.ok(withGym.crew.every((a) => a.bone > 90), 'with gym: ' + withGym.crew.map((a) => Math.round(a.bone)).join(','));
  assert.ok(noGym.crew.every((a) => a.bone < B.groundedBelow), 'no gym: ' + noGym.crew.map((a) => Math.round(a.bone)).join(','));
  assert.ok(noGym.crew.some((a) => a.injuries > 0), 'weak bones cause small injuries');
});

test('bones: 50% fragile and 25% severe make injuries worse; 0% = medbay for good', () => {
  const B = globalThis.LW.CONFIG.astro.bone;
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
  const C = globalThis.LW.CONFIG, M = C.astro.medbay;
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

test('stress: rises outside; a tower visit lowers only that astronaut\'s stress, and each tower works every 12 h', () => {
  const C = globalThis.LW.CONFIG, St = C.astro.stress;
  const st = S.create({ scenario: 'training', seed: 4 });
  const t = freeTile(st, 'plain', 'tower');
  const tower = S.place(st, 'tower', t.c, t.r, 1).m;
  while (!tower.built) S.step(st);
  const builder = st.crew[0], other = st.crew[1];
  assert.ok(builder.stress >= St.outsidePerH * 5, 'building outside raised stress');
  other.stress = 40;
  const before = builder.stress;
  const r = S.useTower(st, tower.id, builder.id);
  assert.ok(r.ok); assert.strictEqual(r.visit, 1, 'first visit of the mission (shows today\'s picture)');
  assert.ok(builder.stress < before, 'their stress went down');
  assert.strictEqual(other.stress, 40, 'nobody else\'s stress changes');
  assert.strictEqual(S.useTower(st, tower.id, other.id).ok, false, 'tower is resting for 12 hours');
  S.step(st);
  assert.strictEqual(builder.where, 'tower', 'they spend an hour at the tower');
  for (let i = 1; i < St.towerCooldownH; i++) S.step(st);
  assert.strictEqual(S.towerReadyIn(st, tower), 0);
  const r2 = S.useTower(st, tower.id, other.id);
  assert.ok(r2.ok); assert.strictEqual(r2.visit, 2, 'later visits show archive pictures');
  assert.strictEqual(other.stress, 40 - St.towerRelief);
});

test('damage: half output until repaired; damaged towers cannot be entered; repair costs 1 part and 1 astronaut', () => {
  const C = globalThis.LW.CONFIG;
  const st = S.create({ scenario: 'training', seed: 6 });
  const t = freeTile(st, 'plain', 'tower');
  const tower = S.place(st, 'tower', t.c, t.r).m;
  while (!tower.built) S.step(st);
  tower.damaged = true;
  assert.strictEqual(S.useTower(st, tower.id, 3).ok, false);
  const parts = st.res.parts;
  assert.strictEqual(S.orderRepair(st, tower.id, 3).ok, false, 'only Engineers repair');
  assert.ok(S.orderRepair(st, tower.id, 2).ok);
  assert.strictEqual(st.res.parts, parts - C.damage.repairCost);
  assert.strictEqual(S.orderRepair(st, tower.id, 1).ok, false, 'no double repair');
  S.step(st);
  assert.deepStrictEqual(st.crew.filter((a) => a.job === 'r' + tower.id).map((a) => a.id), [2], 'exactly the Engineer the player picked repairs');
  while (tower.damaged) S.step(st);
  assert.strictEqual(S.useTower(st, tower.id, 3).ok, true);
});

// ---------------- roles, Research Bay, greenhouse, accidents ----------------
test('roles: only Engineers build and repair; the player picks who does each job', () => {
  const st = S.create({ scenario: 'training', seed: 8 });
  const a = freeTile(st, 'plain', 'solar');
  assert.strictEqual(S.place(st, 'solar', a.c, a.r, 3).ok, false, 'the Scientist cannot build');
  assert.strictEqual(S.place(st, 'solar', a.c, a.r, 4).ok, false, 'the Botanist cannot build');
  const parts = st.res.parts;
  const p1 = S.place(st, 'solar', a.c, a.r, 2).m;
  assert.strictEqual(st.res.parts, parts - 2, 'a refused build costs nothing');
  const b = freeTile(st, 'plain', 'battery');
  const p2 = S.place(st, 'battery', b.c, b.r, 2).m;
  S.step(st);
  assert.strictEqual(st.crew[1].job, 'b' + p1.id, 'Astronaut 2 works on their first job');
  assert.strictEqual(st.crew[0].where, 'hab', 'Astronaut 1 was not picked, so they stay in');
  assert.ok(S.assignWorker(st, p2.id, 1).ok, 'give the second job to Astronaut 1');
  S.step(st);
  assert.strictEqual(st.crew[0].job, 'b' + p2.id);
  assert.strictEqual(S.assignWorker(st, p2.id, 4).ok, false);
  assert.strictEqual(S.startBerm(st, 3).ok, false, 'shield needs an Engineer too');
});

test('Research Bay: Scientist only, 1 day, costs more each time, boosts nearby machines up to 2x', () => {
  const C = globalThis.LW.CONFIG, R = C.research;
  const st = S.create({ scenario: 'training', seed: 5 });
  st.res.parts = 100;
  const o2 = st.modules.find((m) => m.type === 'o2gen');
  // Build the lab right next to the starting O₂ Generator.
  let spot = null;
  for (let dc = -2; dc <= 2 && !spot; dc++) for (let dr = -2; dr <= 2 && !spot; dr++) if (S.canPlace(st, 'lab', o2.c + dc, o2.r + dr).ok) spot = { c: o2.c + dc, r: o2.r + dr };
  const lab = S.place(st, 'lab', spot.c, spot.r, 1).m;
  const sh = freeTile(st, 'plain', 'shelter');
  const shelter = S.place(st, 'shelter', sh.c, sh.r, 2).m;
  while (!lab.built || !shelter.built) S.step(st);
  assert.strictEqual(S.boostOf(st, o2), 1, 'no research yet');
  assert.strictEqual(S.startResearch(st, lab.id, 1, 'o2gen').ok, false, 'Engineers cannot research');
  assert.strictEqual(S.startResearch(st, lab.id, 4, 'o2gen').ok, false, 'Botanists cannot research');
  const sci = st.crew[2];
  const parts = st.res.parts;
  const r = S.startResearch(st, lab.id, sci.id, 'o2gen');
  assert.ok(r.ok); assert.strictEqual(r.cost, R.costBase); assert.strictEqual(st.res.parts, parts - R.costBase);
  assert.strictEqual(S.researchCost(st), R.costBase + R.costStep, 'the next upgrade costs more');
  // In the lab the radiation is the same as in the habitat.
  const dose0 = sci.dose, bot0 = st.crew[3].dose;
  S.step(st);
  assert.strictEqual(sci.where, 'lab');
  assert.strictEqual(st.crew[3].where, 'hab');
  assert.ok(Math.abs((sci.dose - dose0) - (st.crew[3].dose - bot0)) < 1e-12, 'lab dose = habitat dose');
  for (let i = 0; i < 4; i++) S.step(st); // 5 hours of research done
  // Shelter: the Scientist goes too, and the research waits (19 h left) until the player sends them back.
  assert.ok(S.setShelter(st, true));
  S.step(st);
  assert.strictEqual(sci.where, 'shelter');
  assert.strictEqual(sci.task, null);
  assert.strictEqual(sci.paused.left, R.hours - 5);
  S.setShelter(st, false);
  for (let i = 0; i < 3; i++) S.step(st);
  assert.strictEqual(sci.where, 'hab', 'does NOT go back by themselves');
  assert.strictEqual(st.research.o2gen, 0);
  assert.strictEqual(S.startResearch(st, lab.id, sci.id, 'drill').ok, false, 'finish the paused research first');
  const partsBefore = st.res.parts;
  const back = S.resumeTask(st, lab.id, sci.id);
  assert.ok(back.ok); assert.strictEqual(back.left, R.hours - 5);
  assert.strictEqual(st.res.parts, partsBefore, 'continuing costs nothing');
  for (let i = 0; i < R.hours - 6; i++) S.step(st);
  assert.strictEqual(st.research.o2gen, 0, 'not done one hour early');
  S.step(st);
  assert.strictEqual(sci.task, null, 'done after 1 day');
  assert.strictEqual(st.research.o2gen, 1);
  assert.strictEqual(S.boostOf(st, o2), 1 + R.levelBoost, 'nearby O₂ Generator is faster');
  // Far away = no boost.
  const far = { ...o2, c: lab.c + R.radius + 3, r: lab.r };
  assert.strictEqual(S.boostOf(st, far), 1, 'outside the radius: no boost');
  // A second level reaches 2x; a third is refused.
  assert.ok(S.startResearch(st, lab.id, sci.id, 'o2gen').ok);
  assert.strictEqual(S.startResearch(st, lab.id, sci.id, 'drill').ok, false, 'one experiment at a time');
  for (let i = 0; i < R.hours; i++) S.step(st);
  assert.strictEqual(S.boostOf(st, o2), 2);
  assert.strictEqual(S.startResearch(st, lab.id, sci.id, 'o2gen').ok, false, 'max 2x');
  // A damaged lab gives no boost.
  lab.damaged = true;
  assert.strictEqual(S.boostOf(st, o2), 1);
});

test('greenhouse: only the Botanist; a day of tending doubles its food', () => {
  const C = globalThis.LW.CONFIG;
  const grown = (tend) => {
    const st = S.create({ scenario: 'training', seed: 6 });
    st.res.battery = 30; st.res.parts = 50;
    goodSetup(st);
    const gh = st.modules.find((m) => m.type === 'greenhouse');
    if (tend) {
      assert.strictEqual(S.tendGreenhouse(st, gh.id, 1).ok, false, 'Engineers cannot');
      assert.strictEqual(S.tendGreenhouse(st, gh.id, 3).ok, false, 'Scientists cannot');
      assert.ok(S.tendGreenhouse(st, gh.id, 4).ok);
    }
    const f0 = st.stats.foodMade;
    for (let i = 0; i < C.botany.hours; i++) S.step(st);
    return { food: st.stats.foodMade - f0, st };
  };
  const plain = grown(false), tended = grown(true);
  assert.ok(plain.food > 0);
  assert.ok(tended.food > plain.food * 1.7, `tended ${tended.food} vs ${plain.food}`);
  assert.strictEqual(tended.st.crew[3].task, null, 'back after 1 day');
});

test('accidents: happen now and then and cost supplies; work accidents injure the Scientist or Botanist', () => {
  const C = globalThis.LW.CONFIG;
  let total = 0, kinds = new Set();
  for (let seed = 1; seed <= 6; seed++) {
    const st = play('training', seed, goodSetup, shelterBot);
    total += st.stats.accidents.length;
    for (const a of st.stats.accidents) { kinds.add(a.type); assert.ok(a.lost >= 0); }
  }
  assert.ok(total >= 12 && total <= 90, 'about one every few days: ' + total);
  assert.ok(kinds.size >= 3, 'different machines: ' + [...kinds].join(','));
  // Force a micro-explosion.
  const st = S.create({ scenario: 'training', seed: 2 });
  const saved = C.research.accidentChancePerH;
  C.research.accidentChancePerH = 1;
  try {
    st.res.parts = 50;
    const t = freeTile(st, 'plain', 'lab');
    const lab = S.place(st, 'lab', t.c, t.r, 1).m;
    while (!lab.built) S.step(st);
    S.startResearch(st, lab.id, 3, 'solar');
    S.step(st);
    assert.strictEqual(st.crew[2].wounds[0].what, 'lab micro-explosion');
    assert.strictEqual(st.crew[2].wounds[0].hp, C.research.accidentHp);
  } finally { C.research.accidentChancePerH = saved; }
});

test('greenhouse: the shelter puts the Botanist\'s day on hold; clicking the greenhouse again finishes the rest', () => {
  const C = globalThis.LW.CONFIG;
  const st = S.create({ scenario: 'training', seed: 6 });
  st.res.parts = 50;
  const sh = freeTile(st, 'plain', 'shelter');
  const shelter = S.place(st, 'shelter', sh.c, sh.r, 1).m;
  while (!shelter.built) S.step(st);
  const gh = st.modules.find((m) => m.type === 'greenhouse'), bot = st.crew[3];
  assert.ok(S.tendGreenhouse(st, gh.id, bot.id).ok);
  for (let i = 0; i < 10; i++) S.step(st);
  S.setShelter(st, true); S.step(st);
  assert.strictEqual(bot.where, 'shelter');
  assert.strictEqual(bot.paused.left, C.botany.hours - 10);
  S.setShelter(st, false); S.step(st);
  assert.strictEqual(bot.where, 'hab', 'waits for the player');
  const r = S.tendGreenhouse(st, gh.id, bot.id);
  assert.ok(r.ok && r.resumed); assert.strictEqual(r.left, C.botany.hours - 10, 'the rest of the 24 hours, not a new day');
  for (let i = 0; i < C.botany.hours - 10; i++) S.step(st);
  assert.strictEqual(bot.task, null);
  assert.strictEqual(bot.paused, null);
});

test('Fitness Center: a 2-hour session lowers stress too', () => {
  const C = globalThis.LW.CONFIG;
  const st = S.create({ scenario: 'training', seed: 4 });
  st.res.parts = 50;
  const t = freeTile(st, 'plain', 'gym');
  const gym = S.place(st, 'gym', t.c, t.r, 1).m;
  while (!gym.built) S.step(st);
  const a = st.crew[2];
  a.stress = 60;
  S.step(st); // the gym gets power
  assert.ok(S.sendToGym(st, gym.id, a.id).ok);
  for (let i = 0; i < C.astro.bone.visitH; i++) S.step(st);
  assert.strictEqual(a.gymLeft, 0, 'session over after 2 hours');
  assert.ok(Math.abs(a.stress - (60 - C.astro.bone.visitH * C.astro.stress.gymReliefPerH)) < 1e-9, 'stress ' + a.stress);
});

// ---------------- endless game: crew ships, new HABs, rover ----------------
test('endless: no win after 30 days; weather, sunlight forecast and cargo keep coming', () => {
  const st = play('training', 2, goodSetup, shelterBot, 24 * 40);
  assert.strictEqual(st.status, 'running', 'still running on day 40');
  assert.ok(st.light.plain.length >= st.hour + 720, 'sunlight forecast stays 30 days ahead');
  assert.ok(st.storms.some((s) => s.h > 720 && s.h < 1440), 'new storms after day 30');
  assert.ok(st.cargo.filter((k) => k.arrived).length >= 3, 'cargo every 10 days');
});

test('running out of oxygen hurts the crew until they are sent home (the only way the game ends)', () => {
  const st = S.create({ scenario: 'training', seed: 4 });
  const E = globalThis.LW.CONFIG.endless.harm;
  st.res.o2 = 0; st.modules.forEach((m) => { if (m.type === 'o2gen') m.on = false; });
  S.step(st);
  assert.strictEqual(st.status, 'running', 'no instant game over any more');
  assert.ok(Math.abs(st.crew[0].injury - E.noO2PerH) < 1e-9, 'lost health instead');
  let guard = 0;
  while (st.status === 'running' && guard++ < 200) { st.res.o2 = 0; S.step(st); }
  assert.strictEqual(st.status, 'lost');
  assert.strictEqual(st.failure.reason, 'o2');
  assert.strictEqual(st.sentHome.length, 4);
});

// Finish a building right away (tests only): an Engineer is assigned, then it is marked built.
function instant(st, type, c, r) {
  st.res.parts += 50;
  const res = S.place(st, type, c, r, 1);
  assert.ok(res.ok, `place ${type} at ${c},${r}: ${res.why}`);
  res.m.built = true; res.m.progress = globalThis.LW.CONFIG.modules[type].work;
  return res.m;
}
/** A free spot about `from` squares left of the base where a 2x2 HAB fits. */
function farHab(st, from) {
  const B = globalThis.LW.CONFIG.base;
  const parts = st.res.parts; st.res.parts = 999; // (only looking for room, not paying)
  try { for (let dc = from || 30; dc < 45; dc++) if (S.canPlace(st, 'hab', B.c - dc, B.r).ok) return { c: B.c - dc, r: B.r }; } finally { st.res.parts = parts; }
  assert.fail('no far HAB spot');
}
/** A free 2x2 Landing Pad spot within reach of HAB H. */
function padSpot(st, H) {
  const parts = st.res.parts; st.res.parts = 999;
  try { for (let dr = -5; dr <= 5; dr++) for (let dc = -5; dc <= 5; dc++) if (S.canPlace(st, 'pad', H.c + dc, H.r + dr).ok) return { c: H.c + dc, r: H.r + dr }; } finally { st.res.parts = parts; }
  assert.fail('no pad spot');
}
/** Step to the hour the first crew spaceship comes, keeping everyone alive. */
function untilShip(st) {
  const E = globalThis.LW.CONFIG.endless;
  st.hour = E.shipEveryH - E.shipWarnH - 2; S.extendWorld(st);
  const seen = { warn: null, land: null, events: [] };
  while (!st.ships[0].arrived) {
    const ev = S.step(st);
    for (const e of ev) {
      if (/spaceship is on the way/.test(e.title)) { seen.warn = st.hour; seen.warnText = e.text; }
      if (/spaceship (has landed|could not land)/.test(e.title)) { seen.land = st.hour; seen.events.push(e); }
    }
    st.res.o2 = 30; st.res.food = 60; st.res.water = 150; st.res.battery = 30; st.crew.forEach((a) => { a.injury = 0; a.wounds = []; });
  }
  return seen;
}

test('HABs and Landing Pads are built (15 and 10 parts); pads must be close to a HAB; the rover costs 15', () => {
  const C = globalThis.LW.CONFIG;
  assert.strictEqual(C.modules.hab.cost, 15); assert.strictEqual(C.modules.pad.cost, 10); assert.strictEqual(C.rover.cost, 15);
  const st = S.create({ scenario: 'training', seed: 2 });
  st.res.parts = 100;
  const spot = farHab(st);
  assert.strictEqual(S.place(st, 'hab', spot.c, spot.r, 3).ok, false, 'only Engineers build HABs');
  const r = S.place(st, 'hab', spot.c, spot.r, 1);
  assert.ok(r.ok && !r.m.built, 'a HAB is a building job for an Engineer');
  const H1 = S.habs(st)[0];
  // Far from every HAB: refused.
  let lonely = null;
  for (let r2 = 2; r2 < 50 && !lonely; r2++) for (let c2 = 2; c2 < 75 && !lonely; c2++) {
    const near = st.modules.some((m) => m.type === 'hab' && Math.hypot(m.c + 1 - (c2 + 1), m.r + 1 - (r2 + 1)) <= C.pad.radius + 3);
    if (!near && S.canPlace(st, 'solar', c2, r2).ok && S.canPlace(st, 'solar', c2 + 1, r2 + 1).ok) lonely = { c: c2, r: r2 };
  }
  assert.strictEqual(S.canPlace(st, 'pad', lonely.c, lonely.r).ok, false, 'too far from a HAB');
  const p = padSpot(st, H1);
  assert.ok(S.place(st, 'pad', p.c, p.r, 2).ok, 'next to HAB 1: fine');
});

/** Remove the starting Landing Pad (tests about building pads yourself). */
function noPad(st) { st.modules = st.modules.filter((m) => m.type !== 'pad'); return st; }

test('the starting base has a finished Landing Pad next to HAB 1, so the first spaceship can land on it', () => {
  const st = S.create({ scenario: 'training', seed: 1 });
  const pads = st.modules.filter((m) => m.type === 'pad');
  assert.strictEqual(pads.length, 1);
  assert.ok(pads[0].built);
  assert.strictEqual(S.homeForPad(st, pads[0].id), S.habs(st)[0]);
  const seen = untilShip(st);
  assert.ok(seen.events[0].ship, 'it landed without building anything');
  assert.deepStrictEqual(seen.events[0].pads, [pads[0].id]);
});

test('crew spaceship: lands only on a Landing Pad next to a finished HAB; the player picks jobs and the home HAB', () => {
  const E = globalThis.LW.CONFIG.endless;
  const st = noPad(S.create({ scenario: 'training', seed: 1 }));
  st.medbayUses = 2;
  const H1 = S.habs(st)[0], p = padSpot(st, H1);
  instant(st, 'pad', p.c, p.r);
  const s = farHab(st), H2 = instant(st, 'hab', s.c, s.r);
  const seen = untilShip(st);
  assert.strictEqual(seen.land - seen.warn, E.shipWarnH, 'warned 5 days ahead');
  assert.strictEqual(seen.land, E.shipEveryH);
  assert.ok(seen.events[0].ship, 'it landed');
  assert.strictEqual(st.medbayUses, 0, 'medical supplies restocked');
  assert.strictEqual(st.pendingCrew, 2);
  assert.deepStrictEqual(seen.events[0].pads, [st.modules.find((m) => m.type === 'pad').id], 'one ready pad');
  const added = S.joinCrew(st, ['scientist', 'botanist'], seen.events[0].padId);
  assert.deepStrictEqual(added.map((a) => [a.name, a.role]), [['Astronaut 5', 'scientist'], ['Astronaut 6', 'botanist']]);
  assert.ok(added.every((a) => a.homeId === H1.id), 'they live in the HAB closest to their pad (HAB 1), not HAB 2');
  assert.strictEqual(S.crewSummary(st).total, 6);
  assert.strictEqual(S.habName(st, H2), 'HAB 2');
});

test('Landing Pads: no two within the same radius; landing on a pad makes its closest HAB the home of the new crew', () => {
  const C = globalThis.LW.CONFIG;
  const st = noPad(S.create({ scenario: 'training', seed: 4 }));
  const H1 = S.habs(st)[0], p1 = padSpot(st, H1);
  const P1 = instant(st, 'pad', p1.c, p1.r);
  st.res.parts = 100;
  // Every spot within the radius of pad 1 is refused, even if it is next to the HAB.
  for (let dr = -6; dr <= 6; dr++) for (let dc = -6; dc <= 6; dc++) {
    const c = P1.c + dc, r = P1.r + dr;
    if (Math.hypot(dc, dr) <= C.pad.radius) assert.strictEqual(S.canPlace(st, 'pad', c, r).ok, false, `too close at ${dc},${dr}`);
  }
  // A second HAB far away gets its own pad.
  const s2 = farHab(st), H2 = instant(st, 'hab', s2.c, s2.r), p2 = padSpot(st, H2);
  const P2 = instant(st, 'pad', p2.c, p2.r);
  const seen = untilShip(st);
  assert.deepStrictEqual(seen.events[0].pads.slice().sort(), [P1.id, P2.id].sort(), 'both pads are ready: the player picks one');
  assert.strictEqual(S.homeForPad(st, P2.id), H2);
  const added = S.joinCrew(st, ['engineer', 'engineer'], P2.id);
  assert.ok(added.every((a) => a.homeId === H2.id), 'landed on the pad by HAB 2, so they live in HAB 2');
});

test('crew spaceship: no Landing Pad next to a finished HAB = it turns back (no crew, no medbay restock)', () => {
  const st = noPad(S.create({ scenario: 'training', seed: 1 }));
  st.medbayUses = 2;
  const seen = untilShip(st);
  assert.match(seen.warnText, /needs a Landing Pad/, 'the warning tells you to build one');
  assert.match(seen.events[0].title, /could not land/);
  assert.ok(st.ships[0].missed);
  assert.strictEqual(st.pendingCrew, 0);
  assert.strictEqual(st.medbayUses, 2, 'no restock');
  // A pad next to an UNFINISHED HAB does not count either.
  const st2 = noPad(S.create({ scenario: 'training', seed: 2 }));
  const s = farHab(st2);
  st2.res.parts = 100;
  const H = S.place(st2, 'hab', s.c, s.r, 1).m; // still being built
  const p = padSpot(st2, H);
  instant(st2, 'pad', p.c, p.r);
  assert.strictEqual(S.landingSpots(st2).length, 0, 'the HAB must be finished');
  H.built = true;
  assert.strictEqual(S.landingSpots(st2).length, 1);
});

test('each HAB has its own heat and moon-dirt shield', () => {
  const st = S.create({ scenario: 'training', seed: 2 });
  const t = freeTile(st, 'plain', 'hab');
  const H2 = instant(st, 'hab', t.c, t.r);
  const r = S.startBerm(st, 1, H2.id);
  assert.ok(r.ok && r.hab === H2);
  assert.strictEqual(st.berm.building, false, 'HAB 1 untouched');
  assert.ok(S.startBerm(st, 2).ok, 'HAB 1 shield too (Engineer 2 lives there)');
  H2.on = false; // no power: it cools down, HAB 1 stays warm
  for (let i = 0; i < 4; i++) S.step(st);
  assert.ok(H2.temp < S.habs(st)[0].temp);
  assert.strictEqual(st.habTemp, H2.temp, 'the Supplies bar shows the coldest HAB');
});

test('rover: costs 15 parts, carries up to 4 astronauts to another HAB, then stays there', () => {
  const C = globalThis.LW.CONFIG;
  const st = S.create({ scenario: 'training', seed: 3 });
  st.res.parts = 14;
  assert.strictEqual(S.buyRover(st).ok, false, 'needs 15 parts');
  st.res.parts = 25;
  assert.ok(S.buyRover(st).ok); assert.strictEqual(st.res.parts, 10);
  assert.strictEqual(S.buyRover(st).ok, false, 'only one rover');
  const H1 = S.habs(st)[0];
  assert.strictEqual(S.startTrip(st, H1.id, [1]).ok, false, 'needs another HAB');
  const far = farHab(st); // about 30 squares away, so the drive takes a few hours
  const H2 = instant(st, 'hab', far.c, far.r);
  assert.strictEqual(S.startTrip(st, H2.id, [1, 2, 3, 4, 5]).ok, false, '4 seats');
  const r = S.startTrip(st, H2.id, [1, 3]);
  assert.ok(r.ok && r.hours >= 2, 'hours ' + r.hours);
  S.step(st);
  assert.strictEqual(st.crew[0].where, 'rover');
  assert.strictEqual(S.useTower(st, 1, 1).ok, false, 'busy in the rover');
  for (let i = 1; i < r.hours; i++) S.step(st);
  assert.strictEqual(st.rover.trip, null);
  assert.strictEqual(st.rover.habId, H2.id, 'the rover is now at HAB 2 (that is where the next trip starts)');
  assert.deepStrictEqual(st.crew.filter((a) => a.homeId === H2.id).map((a) => a.id), [1, 3]);
  assert.deepStrictEqual(S.roverRiders(st).map((a) => a.id), [1, 3], 'only people at HAB 2 can get in now');
  assert.ok(C.rover.seats === 4);
});

test('rover: fully shielded, so riders get no radiation even during a strong storm', () => {
  const st = S.create({ scenario: 'training', seed: 5 });
  st.res.parts = 30; S.buyRover(st);
  const far = farHab(st);
  const H2 = instant(st, 'hab', far.c, far.r);
  st.storms.push({ h: st.hour, strong: true, peak: 20, tau: 12 }); // a strong storm right now
  const r = S.startTrip(st, H2.id, [1]);
  assert.ok(r.ok && r.hours >= 2);
  const rider = st.crew[0], stay = st.crew[1], d0 = rider.dose, s0 = rider.stress, h0 = stay.dose;
  for (let i = 0; i < r.hours; i++) S.step(st);
  assert.ok(st.stormRate > 1, 'the storm is on');
  assert.strictEqual(rider.dose, d0, 'no radiation in the rover');
  assert.strictEqual(rider.stress, s0, 'no storm stress in the rover');
  assert.ok(stay.dose > h0, 'the astronaut in the habitat still got some');
  assert.strictEqual(rider.homeId, H2.id);
});

test('parts: the base starts with 25, and a cargo of building parts gives 30', () => {
  assert.strictEqual(globalThis.LW.CONFIG.cargoOptions.parts.give.parts, 30);
  assert.strictEqual(S.create({ scenario: 'training', seed: 1 }).res.parts, 25);
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
  const on = globalThis.LW.CONFIG.rad.stormOn;
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
  const p = globalThis.LW.APOD._pick([
    { media_type: 'video', hdurl: '', title: 'A video day' },
    { media_type: 'image', date: '2026-11-14', title: 'Apollo 12 &amp; Surveyor 3', explanation: '<strong>Explanation:</strong> Put on <a href="x">glasses</a>.',
      credit: '<a href="y">NASA</a>', permalink: 'https://science.nasa.gov/image-article/x/',
      hdurl: 'https://assets.science.nasa.gov/dynamicimage/a.jpg?w=4000&h=3000&fit=clip&crop=faces%2Cfocalpoint' },
  ]);
  assert.strictEqual(p.title, 'Apollo 12 & Surveyor 3');
  assert.strictEqual(p.text, 'Put on glasses.', 'tags and the "Explanation:" label are removed');
  assert.strictEqual(p.credit, 'NASA');
  assert.match(p.image, /w=1400&h=1400&fit=clip$/);
  assert.strictEqual(globalThis.LW.APOD._pick([{ media_type: 'image', hdurl: 'javascript:alert(1)' }]), null, 'only https images');
});

test('tower visits are counted across all towers (only visit 1 shows today\'s picture)', () => {
  const st = S.create({ scenario: 'training', seed: 4 });
  const a = S.place(st, 'tower', 4, 4, 1).m, b = S.place(st, 'tower', 5, 4, 2).m;
  while (!a.built || !b.built) S.step(st);
  assert.strictEqual(S.useTower(st, b.id, 3).visit, 1, 'whichever tower is used first');
  assert.strictEqual(S.useTower(st, a.id, 4).visit, 2);
});


test('archive picture: random week between 1995-06-16 and the day before today, skips videos and placeholders', async () => {
  require(path.join(__dirname, '../js/apod.js'));
  const A = globalThis.LW.APOD;
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
  const B = globalThis.LW.CONFIG.base;
  assert.strictEqual(S.canPlace(st, 'solar', B.c + 1, B.r + 1).ok, false, 'not on top of the habitat');
  assert.strictEqual(S.canPlace(st, 'solar', -1, 0).ok, false, 'not outside the map');
  const before = st.res.parts;
  const r = S.place(st, 'solar', ridge.c, ridge.r);
  assert.ok(S.cancel(st, r.m.id));
  assert.strictEqual(st.res.parts, before, 'cancel refunds parts');
});

test('cancel halfway through building: full refund, the Engineer is free again, built things cannot be cancelled', () => {
  const st = S.create({ scenario: 'training', seed: 2 });
  const t = freeTile(st, 'plain', 'solar');
  const before = st.res.parts;
  const r = S.place(st, 'solar', t.c, t.r, 1);
  assert.strictEqual(st.res.parts, before - globalThis.LW.CONFIG.modules.solar.cost);
  S.step(st); S.step(st);
  assert.ok(r.m.progress > 0 && !r.m.built, 'work has started');
  assert.strictEqual(st.crew[0].where, 'outside');
  assert.ok(S.cancel(st, r.m.id));
  assert.strictEqual(st.res.parts, before, 'all parts back, even after work started');
  assert.ok(!st.modules.includes(r.m), 'the site is gone');
  assert.strictEqual(S.cancel(st, r.m.id), false, 'cannot cancel twice');
  S.step(st);
  assert.notStrictEqual(st.crew[0].where, 'outside', 'the Engineer goes back inside');
  assert.strictEqual(st.crew[0].job, null);
  const H = S.habs(st)[0], p0 = st.res.parts;
  assert.strictEqual(S.cancel(st, H.id), false, 'finished buildings cannot be cancelled');
  assert.strictEqual(st.res.parts, p0);
});

test('light fades gradually and solar power follows it', () => {
  const st = S.create({ scenario: 'history', seed: 1 });
  const vals = [];
  for (let h = 160; h <= 200; h++) vals.push(S.zoneLight(st, 'plain', h));
  assert.ok(vals.some((v) => v > 0.2 && v < 0.8), 'there are in-between light levels');
  for (let i = 1; i < vals.length; i++) assert.ok(Math.abs(vals[i] - vals[i - 1]) < 0.15, 'no sudden jump at hour ' + (160 + i));
  assert.strictEqual(S.zoneLight(st, 'ice', 100), 0, 'ice crater never sees the Sun');
});
