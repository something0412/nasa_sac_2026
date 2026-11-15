const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.window = globalThis;
require('../js/config.js');
require('../js/iso.js');
require('../js/sim.js');
require('../js/crew_motion.js'); // shared astronaut positions used by both views
require('../js/render.js');
require('../js/render_iso.js');

function canvasProbe() {
  const calls = [];
  let path = [];
  const context = new Proxy({}, {
    get(target, name) {
      if (name === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (name === 'beginPath') return () => { path = []; };
      if (name === 'moveTo' || name === 'lineTo') return (x, y) => path.push([x, y]);
      if (name === 'fill') return () => calls.push({ name, color: target.fillStyle, path: path.map(point => [...point]) });
      if (name === 'stroke' || name === 'strokeRect') return (...args) => calls.push({ name, color: target.strokeStyle, width: target.lineWidth, args, path: path.map(point => [...point]) });
      if (name === 'fillRect' || name === 'rotate' || name === 'ellipse' || name === 'translate') return (...args) => calls.push({ name, color: target.fillStyle, args });
      return target[name] ?? (() => {});
    },
    set(target, name, value) { target[name] = value; return true; },
  });
  return { calls, getContext: () => context };
}

for (const view of ['Renderer', 'IsoRenderer']) {
  test(`${view}: building hammer animates, pauses, stops, and preserves the original progress bar`, () => {
    globalThis.document = { createElement: () => canvasProbe() };
    globalThis.Path2D = class {
      rect() {}
      moveTo() {}
      lineTo() {}
      closePath() {}
    };
    const canvas = canvasProbe();
    const renderer = LW[view](canvas, canvasProbe());
    const state = LW.Sim.create({ scenario: 'training', seed: 1 });
    const head = () => canvas.calls.find(call => call.color === '#c6d0dd');
    let workTime = 0;
    function draw(paused = false, dt = 0.1) {
      canvas.calls.length = 0;
      const before = JSON.stringify(state);
      renderer.draw(state, dt, { paused, frac: 0 });
      if (!paused) workTime += dt;
      assert.equal(JSON.stringify(state), before, 'drawing preserves simulation state');
    }
    draw();
    assert.equal(head(), undefined);
    let site = null;
    const base = LW.CONFIG.base;
    for (let r = base.r - 4; r <= base.r + 4 && !site; r++) {
      for (let c = base.c - 4; c <= base.c + 4 && !site; c++) {
        if (!LW.Sim.canPlace(state, 'solar', c, r).ok) continue;
        assert.ok(LW.Sim.place(state, 'solar', c, r).ok);
        site = state.modules.find(module => !module.built);
      }
    }
    assert.ok(site);
    LW.Sim.step(state);
    draw();
    assert.equal(head(), undefined, 'no hammer swing while walking to the site');
    for (let frame = 0; frame < 40; frame++) draw();
    assert.ok(head());
    const visorIndex = canvas.calls.findIndex(call => call.name === 'fill' && call.color === '#1ea5e9');
    assert.ok(visorIndex >= 0, 'builder has a visible visor');
    if (view === 'Renderer') {
      const direction = canvas.calls.slice(0, visorIndex).findLast(call => call.name === 'rotate').args[0];
      assert.ok(Math.abs(Math.abs(direction) - Math.PI) < 1e-8, 'stationary builder faces back toward the building');
      const helmetOrigin = canvas.calls.slice(0, visorIndex).findLast(call => call.name === 'translate').args;
      const headIndex = canvas.calls.indexOf(head());
      const hammerOrigin = canvas.calls.slice(0, headIndex).findLast(call => call.name === 'translate').args;
      assert.ok(hammerOrigin[1] <= helmetOrigin[1] - 7, 'hammer arm stays to the astronaut\'s right, clear of the visor');
    } else {
      const visor = canvas.calls.find(call => call.name === 'ellipse' && call.color === '#1ea5e9');
      const position = LW.Iso.toScreen(site.c + site.w + 0.2, site.r + site.h / 2, LW.CONFIG.map.rows);
      assert.ok(visor.args[0] < position.x, 'visor is on the building-facing side of the helmet');
    }
    const width = view === 'Renderer' ? 32 : 30;
    assert.ok(canvas.calls.some(call => call.name === 'fillRect' && call.args[2] === width && call.args[3] === 5));
    let pose;
    if (view === 'IsoRenderer') {
      for (const color of ['#7d8b9e', '#9aa9bb']) assert.ok(canvas.calls.some(call => call.name === 'fill' && call.color === color), 'hammer head has shaded side faces');
      const corners = head().path;
      assert.equal(corners.length, 4);
      pose = JSON.stringify(corners);
    } else pose = JSON.stringify(canvas.calls.filter(call => call.name === 'rotate').at(-1).args);
    const currentPose = () => JSON.stringify(view === 'IsoRenderer' ? head().path : canvas.calls.filter(call => call.name === 'rotate').at(-1).args);
    draw(true);
    assert.equal(currentPose(), pose);
    draw();
    assert.notEqual(currentPose(), pose);
    assert.ok(canvas.calls.some(call => call.color === '#4a5566' && call.width === 0.6), 'hammer outline is thin');
    if (view === 'IsoRenderer') {
      const worker = state.crew.find(astronaut => astronaut.job === 'b' + site.id);
      const phaseOffset = worker.id * 0.17;
      const restTime = (Math.ceil(workTime * 1.4 + phaseOffset) + 0.5 - phaseOffset) / 1.4;
      draw(false, restTime - workTime);
      const restCorners = head().path;
      const longEdge = [restCorners[1][0] - restCorners[0][0], restCorners[1][1] - restCorners[0][1]];
      const shortEdge = [restCorners[2][0] - restCorners[1][0], restCorners[2][1] - restCorners[1][1]];
      assert.ok(longEdge[0] > 0 && longEdge[1] > 0, 'mallet head faces along the wall normal on the c axis');
      assert.ok(Math.abs(longEdge[0] - 2 * longEdge[1]) < 1e-8, 'raised pose follows the isometric projection');
      assert.ok(Math.hypot(...longEdge) > 2 * Math.hypot(...shortEdge), 'mallet has a broad block head');
      assert.ok(Math.hypot(...longEdge) < 9, 'mallet head stays small relative to the astronaut');
      const handle = canvas.calls.find(call => call.name === 'stroke' && call.color === '#725234').path;
      const headCentreX = restCorners.reduce((sum, corner) => sum + corner[0], 0) / 4;
      const headTopY = restCorners.reduce((sum, corner) => sum + corner[1], 0) / 4;
      assert.ok(Math.abs(handle[1][0] - headCentreX) < 1e-8, 'handle attaches beneath the centre of the head');
      assert.ok(Math.abs(handle[1][1] - (headTopY + 3)) < 1e-8, 'handle meets the underside of the head');
      assert.ok(Math.hypot(handle[0][0] - handle[1][0], handle[0][1] - handle[1][1]) < 5, 'mallet has a short handle');
      assert.ok(handle[0][1] > handle[1][1], 'handle extends down toward the astronaut');
      const impactTime = (Math.ceil(workTime * 1.4 + phaseOffset) - phaseOffset) / 1.4;
      draw(false, impactTime - workTime);
      assert.notDeepEqual(head().path, restCorners, 'mallet tilts from its upright pose into the strike');
      const contact = LW.Iso.toScreen(site.c + site.w - 0.12, site.r + site.h / 2, LW.CONFIG.map.rows);
      const side = canvas.calls.find(call => call.name === 'fill' && call.color === '#7d8b9e').path;
      const faceX = (side[0][0] + side[3][0]) / 2 + 0.05 * LW.Iso.TILE_W / 2;
      assert.ok(Math.abs(faceX - contact.x) < 1e-8, 'mallet striking face reaches the building wall');
    }
    LW.Sim.cancel(state, site.id);
    draw();
    assert.equal(head(), undefined);
    renderer.reset();
    draw();
    assert.equal(head(), undefined);
  });
}
