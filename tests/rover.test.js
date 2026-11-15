const test = require('node:test');
const assert = require('node:assert/strict');
require('../js/config.js');
require('../js/sim.js');
const S = globalThis.LW.Sim;

function setup() {
  const state = S.create({ scenario: 'training', seed: 1 });
  state.res.parts = 999;
  const base = LW.CONFIG.base;
  const second = S.place(state, 'hab', base.c + 12, base.r + 6);
  assert.ok(second.ok);
  second.m.built = true;
  second.m.progress = LW.CONFIG.modules.hab.work;
  assert.ok(S.buyRover(state).ok);
  return state;
}

test('rover detours around buildings and construction sites, then parks outside the destination', () => {
  const state = setup(), [first, second] = S.habs(state);
  const base = LW.CONFIG.base;
  for (let r = base.r; r < base.r + 10; r++) {
    assert.ok(S.place(state, 'solar', base.c + 6, r).ok);
  }
  const trip = S.startTrip(state, second.id, [1, 2]);
  assert.ok(trip.ok);
  const route = state.rover.trip.path;
  assert.ok(route.some(p => p.r < base.r || p.r >= base.r + 10), 'route goes around the wall');
  for (let index = 1; index < route.length; index++) {
    assert.equal(Math.abs(route[index].c - route[index - 1].c) + Math.abs(route[index].r - route[index - 1].r), 1, 'turns never cut through corners');
  }
  for (let sample = 0; sample <= 200; sample++) {
    const elapsed = trip.hours * sample / 200;
    state.rover.trip.left = trip.hours - Math.floor(elapsed);
    const before = JSON.stringify(state);
    const position = S.roverPosition(state, elapsed % 1);
    assert.equal(JSON.stringify(state), before, 'reading the animation position preserves state');
    for (const m of state.modules) {
      const overlaps = position.c > m.c - 0.4 && position.c < m.c + m.w + 0.4 && position.r > m.r - 0.4 && position.r < m.r + m.h + 0.4;
      assert.equal(overlaps, false, 'rover has clearance beside every building');
    }
  }
  state.rover.trip.left = trip.hours;
  for (let hour = 0; hour < trip.hours; hour++) S.step(state);
  const parked = S.roverPosition(state, 0);
  assert.equal(parked.c, route.at(-1).c);
  assert.equal(parked.r, route.at(-1).r);
  assert.equal(parked.moving, false);
  assert.equal(S.moduleAt(state, Math.floor(parked.c), Math.floor(parked.r)), undefined);
  assert.ok(state.crew.filter(a => [1, 2].includes(a.id)).every(a => a.homeId === second.id));
  assert.ok(S.startTrip(state, first.id, [1, 2]).ok);
  assert.deepEqual(state.rover.trip.path[0], { c: parked.c, r: parked.r }, 'return trip starts at the actual parking space');
});

test('an inaccessible HAB rejects the trip without boarding or changing state', () => {
  const state = setup(), destination = S.habs(state)[1];
  const spots = [];
  for (let c = destination.c; c < destination.c + destination.w; c++) {
    spots.push([c, destination.r - 1], [c, destination.r + destination.h]);
  }
  for (let r = destination.r; r < destination.r + destination.h; r++) {
    spots.push([destination.c - 1, r], [destination.c + destination.w, r]);
  }
  for (const [c, r] of spots) assert.ok(S.place(state, 'solar', c, r).ok);
  const before = JSON.stringify(state);
  const result = S.startTrip(state, destination.id, [1]);
  assert.equal(result.ok, false);
  assert.match(result.why, /No clear rover route/);
  assert.equal(JSON.stringify(state), before);
});

test('parking and active routes stay clear of new construction, including older rover states', () => {
  const state = setup(), destination = S.habs(state)[1];
  const parked = S.roverPosition(state, 0);
  assert.equal(S.canPlace(state, 'solar', Math.floor(parked.c), Math.floor(parked.r)).ok, false);
  assert.ok(S.startTrip(state, destination.id, [1]).ok);
  const tile = state.rover.trip.path[2];
  assert.equal(S.canPlace(state, 'solar', Math.floor(tile.c), Math.floor(tile.r)).ok, false);
  delete state.rover.parked;
  delete state.rover.trip.path;
  assert.ok(S.roverPosition(state, 0.5), 'older trips without a stored route still render');
});

test('2.5D rover dips into the drawn crater and rises smoothly out, including its wheel tilt', () => {
  globalThis.window = globalThis;
  require('../js/iso.js');
  require('../js/shapes.js'); // building signs used by both renderers
  require('../js/crew_motion.js'); // astronaut positions shared by both views
  require('../js/render.js');
  require('../js/render_iso.js');
  const craters = [], roofs = [];
  let points = [];
  const context = new Proxy({}, {
    get(target, name) {
      if (name === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (name === 'beginPath') return () => { points = []; };
      if (name === 'moveTo' || name === 'lineTo') return (x, y) => points.push([x, y]);
      if (name === 'fill') return () => { if (target.fillStyle === '#e8c547') roofs.push(points.map(point => [...point])); };
      return target[name] ?? (() => {});
    },
    set(target, name, value) { target[name] = value; return true; },
  });
  const canvas = () => ({ getContext: () => context });
  globalThis.document = { createElement: canvas };
  globalThis.Path2D = class {
    rect() {}
    moveTo() {}
    lineTo() {}
    closePath() {}
  };
  const originalCrater = LW.drawCrater, originalPosition = S.roverPosition;
  let position = null;
  try {
    LW.drawCrater = (ctx, x, y, radius) => craters.push({ x, y, radius });
    S.roverPosition = () => position;
    const renderer = LW.IsoRenderer(canvas());
    const state = S.create({ scenario: 'training', seed: 1 });
    renderer.draw(state, 0.1, {});
    const crater = craters.find(candidate => candidate.radius > 20 && [-1.2, 0, 1.2].every(offset =>
      craters.every(other => other === candidate || Math.hypot((candidate.x + offset * candidate.radius - other.x) / other.radius, (candidate.y - other.y) / (other.radius * 0.5)) > 1.15)));
    assert.ok(crater, 'generated terrain contains a clear crater for the crossing');
    const depths = [];
    const halfWidth = LW.Iso.TILE_W / 2, halfHeight = LW.Iso.TILE_H / 2;
    const terraceStep = 14;
    const topOffset = Math.max(0, ...LW.CONFIG.features.map(feature => feature.height || 0)) * terraceStep;
    let tilted = false;
    for (let sample = 0; sample <= 48; sample++) {
      const x = crater.x + (sample / 48 * 2.4 - 1.2) * crater.radius;
      const y = crater.y;
      const colsAxis = (x - LW.CONFIG.map.rows * halfWidth) / halfWidth, rowsAxis = (y - topOffset) / halfHeight;
      position = { c: (colsAxis + rowsAxis) / 2, r: (rowsAxis - colsAxis) / 2, dir: { c: 1, r: 0 }, moving: true };
      roofs.length = 0;
      const before = JSON.stringify(state);
      renderer.draw(state, 0.1, { paused: true });
      assert.equal(JSON.stringify(state), before);
      const roof = roofs.at(-1);
      const groundY = y - LW.CONFIG.heightAt(Math.floor(position.c), Math.floor(position.r)) * terraceStep;
      const depth = roof.reduce((sum, point) => sum + point[1], 0) / 4 - (groundY - 8);
      depths.push(depth);
      const frontBack = (roof[0][1] + roof[1][1] - roof[2][1] - roof[3][1]) / 2;
      if (Math.abs(frontBack - 2 * 0.28 * halfHeight) > 0.1) tilted = true;
    }
    assert.ok(Math.abs(depths[0]) < 1e-8 && Math.abs(depths.at(-1)) < 1e-8, 'returns to level ground');
    assert.ok(depths[24] > 2 && depths[24] <= 7, 'dips gently at the crater floor');
    for (let sample = 1; sample < depths.length; sample++) assert.ok(Math.abs(depths[sample] - depths[sample - 1]) < 2, 'crossing stays smooth');
    assert.ok(tilted, 'wheel height follows the slope');
  } finally {
    LW.drawCrater = originalCrater;
    S.roverPosition = originalPosition;
  }
});
