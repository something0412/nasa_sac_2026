// Run: node --test tests/crew_motion.test.js   (from the project root)
// The shared astronaut positions used by both map views (js/crew_motion.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

globalThis.window = globalThis;
require(path.join(__dirname, '../data/may2024.js'));
require(path.join(__dirname, '../data/radlab.js'));
require(path.join(__dirname, '../js/config.js'));
require(path.join(__dirname, '../js/sim.js'));
require(path.join(__dirname, '../js/crew_motion.js'));
const LW = globalThis.LW;

function setup() {
  const st = LW.Sim.create({ scenario: 'history', seed: 1 });
  const eng = st.crew.find((a) => a.role === 'engineer');
  const B = LW.CONFIG.base;
  const r = LW.Sim.place(st, 'battery', B.c + 8, B.r + 4, eng.id);
  assert.ok(r.ok, 'job placed: ' + r.why);
  return { st, eng, site: r.m };
}

test('an astronaut walks smoothly from their HAB to a job (no jumping)', () => {
  const { st, eng, site } = setup();
  const motion = LW.CrewMotion();
  motion.update(st, 1 / 60); // first sight: standing at their HAB
  const start = { ...motion.get(eng.id) };
  LW.Sim.step(st); // the game hour where the Engineer goes outside
  assert.strictEqual(eng.where, 'outside');
  let last = start, maxStep = 0, frames = 0;
  while (frames++ < 60 * 20) {
    motion.update(st, 1 / 60);
    const p = motion.get(eng.id);
    maxStep = Math.max(maxStep, Math.hypot(p.c - last.c, p.r - last.r));
    last = { ...p };
    if (p.dist === 0) break;
  }
  assert.ok(maxStep < 0.1, 'moves a little each frame, biggest step ' + maxStep);
  // Builders stand just outside the building's right-hand wall, in the middle of that side (Gerardo's mallet spot).
  const goal = { c: site.c + site.w + 0.2, r: site.r + site.h / 2 };
  assert.ok(Math.hypot(last.c - goal.c, last.r - goal.r) < 0.01, 'arrives at the wall of the job site');
  assert.ok(last.visible, 'shown while working outside');
  assert.strictEqual(last.building, site.id, 'marked as hammering on that building');
});

test('positions do not depend on which view is drawing: one shared object, one update per frame', () => {
  const { st, eng } = setup();
  const a = LW.CrewMotion(), b = LW.CrewMotion();
  a.update(st, 1 / 60); b.update(st, 1 / 60);
  LW.Sim.step(st);
  for (let i = 0; i < 90; i++) { a.update(st, 1 / 60); b.update(st, 1 / 60); }
  assert.deepStrictEqual(a.get(eng.id), b.get(eng.id), 'same state + same frames = same spot');
});

test('reset forgets everyone; astronauts no longer in the crew are not returned', () => {
  const { st, eng } = setup();
  const m = LW.CrewMotion();
  m.update(st, 1 / 60);
  assert.ok(m.get(eng.id));
  st.crew = st.crew.filter((x) => x !== eng); // e.g. sent home to Earth
  m.update(st, 1 / 60);
  assert.strictEqual(m.get(eng.id), null);
  m.reset();
  assert.strictEqual(m.get(st.crew[0].id), null);
});
