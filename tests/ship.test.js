// The crew spaceship landing (js/ship.js): timing only (the drawing is checked by eye in the browser).
const test = require('node:test');
const assert = require('node:assert');
require('../js/shapes.js');
require('../js/ship.js');
const LW = globalThis.LW;

const pad = { id: 7, type: 'pad', c: 10, r: 20, w: 2, h: 2 };
const run = (landing, secs) => { let f = null; for (let t = 0; t < secs; t += 1 / 60) f = landing.update(1 / 60); return f; };

test('ship: comes down onto the middle of its pad, then the game carries on exactly once', () => {
  const L = LW.ShipLanding();
  let done = 0;
  L.play(pad, 'hi', () => done++);
  const f0 = L.update(1 / 60);
  assert.strictEqual(f0.c, 11); assert.strictEqual(f0.r, 21); assert.strictEqual(f0.padId, 7);
  assert.ok(f0.alt > 0.95 && f0.flame === 1, 'starts high up with the engine on');
  let last = f0.alt, burst = 0;
  for (let t = 0; t < 2.6; t += 1 / 60) { const f = L.update(1 / 60); assert.ok(f.alt <= last + 1e-9, 'never goes back up while landing'); last = f.alt; if (f.burst) burst++; }
  assert.ok(last < 0.01, 'on the pad');
  assert.strictEqual(done, 0, 'the game waits until it has landed');
  const f = run(L, 1.2);
  assert.strictEqual(done, 1); assert.ok(f.label > 0.9, 'the "landed" tag shows');
  run(L, 2.5);
  assert.strictEqual(L.active(), true, 'it flies back up afterwards instead of vanishing');
  run(L, 2);
  assert.strictEqual(L.active(), false);
  assert.strictEqual(L.update(1 / 60), null);
  assert.strictEqual(done, 1, 'onDone runs once');
  assert.ok(burst <= 1);
});

test('ship: a new landing (or a new game) never leaves the old one\'s game stuck waiting', () => {
  const L = LW.ShipLanding();
  let a = 0, b = 0;
  L.play(pad, 'a', () => a++);
  run(L, 1);
  L.play({ ...pad, id: 8 }, 'b', () => b++);
  assert.strictEqual(a, 1, 'the first one is finished off');
  run(L, 4);
  assert.strictEqual(b, 1);
  L.clear(); assert.strictEqual(L.active(), false);
});
