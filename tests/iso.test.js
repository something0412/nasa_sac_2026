// Written with help from Claude Code (AI); reviewed and tested by the team.
// Run: node --test tests/iso.test.js   (from the project root)
// Checks the isometric math: grid square → screen → grid square must always come back the same.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

globalThis.window = globalThis;
require(path.join(__dirname, '../js/config.js'));
require(path.join(__dirname, '../js/iso.js'));
const Iso = globalThis.LW.Iso;
const { cols, rows } = globalThis.LW.CONFIG.map;

test('every tile goes to the screen and back to the same tile', () => {
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const top = Iso.toScreen(c, r, rows);
      assert.deepStrictEqual(Iso.toGrid(top.x, top.y, rows), { c, r }, `top corner of (${c}, ${r})`);
      const mid = Iso.tileCenter(c, r, rows);
      assert.deepStrictEqual(Iso.toGrid(mid.x, mid.y, rows), { c, r }, `center of (${c}, ${r})`);
    }
  }
});

test('a click anywhere inside a diamond picks that tile', () => {
  const mid = Iso.tileCenter(5, 3, rows);
  const nearEdge = 0.45; // stay just inside each corner of the diamond
  const inside = [
    [0, 0],
    [-Iso.TILE_W / 2 * nearEdge * 2, 0], // toward the left corner
    [Iso.TILE_W / 2 * nearEdge * 2, 0],  // toward the right corner
    [0, -Iso.TILE_H / 2 * nearEdge * 2], // toward the top corner
    [0, Iso.TILE_H / 2 * nearEdge * 2],  // toward the bottom corner
  ];
  for (const [dx, dy] of inside) {
    assert.deepStrictEqual(Iso.toGrid(mid.x + dx, mid.y + dy, rows), { c: 5, r: 3 }, `offset (${dx}, ${dy})`);
  }
});

test('clicks just past each edge pick the neighbouring tile', () => {
  const mid = Iso.tileCenter(5, 3, rows);
  const step = 0.55 * 2; // just past halfway to the corner, along each diagonal edge direction
  // Moving down-right along the screen = c + 1, down-left = r + 1 (and the opposite ways).
  assert.deepStrictEqual(Iso.toGrid(mid.x + Iso.TILE_W / 4 * step, mid.y + Iso.TILE_H / 4 * step, rows), { c: 6, r: 3 });
  assert.deepStrictEqual(Iso.toGrid(mid.x - Iso.TILE_W / 4 * step, mid.y + Iso.TILE_H / 4 * step, rows), { c: 5, r: 4 });
  assert.deepStrictEqual(Iso.toGrid(mid.x - Iso.TILE_W / 4 * step, mid.y - Iso.TILE_H / 4 * step, rows), { c: 4, r: 3 });
  assert.deepStrictEqual(Iso.toGrid(mid.x + Iso.TILE_W / 4 * step, mid.y - Iso.TILE_H / 4 * step, rows), { c: 5, r: 2 });
});

test('the whole map fits inside worldSize, starting at (0, 0)', () => {
  const size = Iso.worldSize(cols, rows);
  assert.deepStrictEqual(size, { w: (cols + rows) * Iso.TILE_W / 2, h: (cols + rows) * Iso.TILE_H / 2 });
  assert.deepStrictEqual(Iso.toScreen(0, 0, rows), { x: rows * Iso.TILE_W / 2, y: 0 }, 'tile (0, 0) is the top of the map');
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const p = Iso.toScreen(c, r, rows);
      assert.ok(p.x - Iso.TILE_W / 2 >= 0 && p.x + Iso.TILE_W / 2 <= size.w, `(${c}, ${r}) fits left-right`);
      assert.ok(p.y >= 0 && p.y + Iso.TILE_H <= size.h, `(${c}, ${r}) fits top-bottom`);
    }
  }
});

test('inMap knows the map edges', () => {
  assert.ok(Iso.inMap(0, 0, cols, rows));
  assert.ok(Iso.inMap(cols - 1, rows - 1, cols, rows));
  assert.ok(!Iso.inMap(-1, 0, cols, rows));
  assert.ok(!Iso.inMap(0, rows, cols, rows));
  assert.ok(!Iso.inMap(cols, 0, cols, rows));
});
