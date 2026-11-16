// Run: node --test tests/ground.test.js   (from the project root)
// The 2.5D ground picture can be painted a little at a time (prepareStep), so the game never freezes.
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;
require('../data/may2024.js');
require('../data/radlab.js');
require('../js/config.js');
require('../js/iso.js');
require('../js/sim.js');
require('../js/crew_motion.js');
require('../js/shapes.js'); // building signs (js/shapes.js) used by both renderers
require('../js/render.js');
require('../js/render_iso.js');
const LW = globalThis.LW;

// A fake canvas that accepts every drawing call (Node has no real canvas).
function fakeCanvas() {
  const ctx = new Proxy({}, {
    get(t, k) { if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} }); return k in t ? t[k] : () => {}; },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
}
globalThis.document = { createElement: () => fakeCanvas() };
globalThis.Path2D = class { moveTo() {} lineTo() {} closePath() {} rect() {} };
globalThis.performance = globalThis.performance || { now: () => Date.now() };

test('2.5D ground is painted in many small slices, then drawing works', () => {
  const r = LW.IsoRenderer(fakeCanvas());
  const st = LW.Sim.create({ scenario: 'history', seed: 1 });
  let slices = 0;
  while (!r.prepareStep(st, 0)) slices++; // budget 0 = one small piece per call
  assert.ok(slices > 50, 'split into many small pieces, got ' + slices);
  assert.equal(r.prepareStep(st, 0), true, 'finished stays finished');
  r.draw(st, 1 / 60, { frac: 0 }); // uses the finished picture
});

test('switching to the view in the middle of painting finishes the rest at once', () => {
  const r = LW.IsoRenderer(fakeCanvas());
  const st = LW.Sim.create({ scenario: 'history', seed: 1 });
  for (let i = 0; i < 20; i++) r.prepareStep(st, 0); // only partly painted
  r.draw(st, 1 / 60, { frac: 0 }); // must finish painting, not crash or draw half a Moon
  assert.equal(r.prepareStep(st, 0), true, 'the picture is now complete');
});
