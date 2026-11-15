// Run: node --test tests/models.test.js   (from the project root)
// Checks the 2.5D building models: every building has one, the sun lighting makes sense, and every model
// can be drawn in every state (being built, running, off, no power, no water, damaged) without crashing.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

globalThis.window = globalThis;
require(path.join(__dirname, '../data/may2024.js'));
require(path.join(__dirname, '../data/radlab.js'));
require(path.join(__dirname, '../js/config.js'));
require(path.join(__dirname, '../js/iso.js'));
require(path.join(__dirname, '../js/sim.js'));
require(path.join(__dirname, '../js/models.js'));
const { CONFIG, Models, Iso, Sim } = globalThis.MT;

// A pretend canvas: accepts every drawing call and remembers how many shapes were filled.
function fakeCanvas() {
  const calls = { fill: 0, stroke: 0 };
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({}, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'fill' || key === 'stroke') return () => { calls[key]++; };
      if (key === 'measureText') return (t) => ({ width: String(t).length * 6 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => gradient;
      return () => {};
    },
    set(target, key, value) { target[key] = value; return true; },
  });
  return { ctx, calls };
}

test('every building in the build menu (and the habitat) has a model and a height', () => {
  for (const type of Object.keys(CONFIG.modules)) {
    assert.strictEqual(typeof Models.MODELS[type], 'function', `model for ${type}`);
    assert.ok(Models.height(type) > 0, `height for ${type}`);
  }
});

test('walls facing the Sun are brighter than walls facing away', () => {
  const sun = Models.sunVector(0); // Sun towards +c
  const toward = Models.brightness([1, 0, 0], sun, 1), away = Models.brightness([-1, 0, 0], sun, 1);
  assert.ok(toward > away + 0.3, `${toward} vs ${away}`);
  // in a hill's shadow (no sunlight) the sunny side is no brighter than the other side
  assert.ok(Math.abs(Models.brightness([1, 0, 0], sun, 0) - Models.brightness([0, 1, 0], sun, 0)) < 1e-9);
  // the Sun is low: it lights walls more than roofs
  assert.ok(Models.brightness([1, 0, 0], sun, 1) > Models.brightness([0, 0, 1], sun, 1));
});

test('the Sun vector follows the game Sun and stays low over the horizon', () => {
  for (const az of [0, 90, 200, 333]) {
    const s = Models.sunVector(az);
    assert.ok(Math.abs(Math.hypot(...s) - 1) < 1e-9);
    assert.ok(s[2] > 0 && s[2] < 0.25, 'low Sun');
    const a = (Math.atan2(s[1], s[0]) * 180) / Math.PI;
    assert.ok(Math.abs(((a - az + 540) % 360) - 180) < 1e-6, `azimuth ${az}`);
  }
});

test('faces are only drawn when the camera can see them', () => {
  assert.ok(Models.facesCamera([1, 0, 0]) && Models.facesCamera([0, 1, 0]) && Models.facesCamera([0, 0, 1]));
  assert.ok(!Models.facesCamera([-1, 0, 0]) && !Models.facesCamera([0, -1, 0]));
});

test('every model draws in every state without errors', () => {
  const st = Sim.create({ scenario: 'training', seed: 3 });
  const rows = CONFIG.map.rows;
  const { ctx, calls } = fakeCanvas();
  const k = Models.Toolkit(ctx, (c, r) => Iso.toScreen(c, r, rows));
  const spawned = [];
  const env = { state: st, t: 12.3, blink: true, sun: Models.sunVector(210), L: 0.8, on: true, charge: 0.4, water: 0.6, growth: 0.5, training: true, spawn: (...a) => spawned.push(a) };
  const states = [
    { built: false, on: true, powered: false, progress: 3 },
    { built: true, on: true, powered: true },
    { built: true, on: false, powered: false },
    { built: true, on: true, powered: false },
    { built: true, on: true, powered: true, noWater: true },
    { built: true, on: true, powered: true, damaged: true, repair: { progress: 2, work: 6 } },
  ];
  st.berm.building = true; st.berm.progress = 10; st.sheltering = true;
  for (const type of Object.keys(CONFIG.modules)) {
    const d = CONFIG.modules[type];
    for (const s of states) {
      const m = { id: 7, type, c: 10, r: 12, w: d.w, h: d.h, light: 0.8, ...s };
      env.on = m.built && m.on && m.powered;
      const before = calls.fill;
      assert.doesNotThrow(() => Models.draw(k, m, env), `${type} ${JSON.stringify(s)}`);
      assert.ok(calls.fill > before, `${type} drew something`);
      if (!m.built) assert.doesNotThrow(() => Models.scaffold(k, m, 0.4));
    }
  }
  assert.doesNotThrow(() => Models.badge(ctx, 10, 10, 'OFF', '#fff'));
});
