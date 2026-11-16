// Written with help from Claude Code (AI); reviewed and tested by the team.
// Isometric (2.5D) math: turns grid squares into diamond positions on screen, and back.
// The game rules (sim.js) only know grid squares (c = column, r = row). This file is only about
// WHERE to draw them in an isometric view, and WHICH square the mouse is pointing at.
// Nothing uses it yet: the isometric renderer comes in a later step.
//
//   top-down grid          isometric (turned 45° and squashed to half height)
//   (0,0) (1,0)                      (0,0)
//   (0,1) (1,1)               (0,1)         (1,0)
//                                    (1,1)
//
// Each square becomes a diamond TILE_W wide and TILE_H tall (2:1 is the classic isometric look).
// Positions are in "iso world pixels": (0, 0) is the top-left corner of the whole isometric map.
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const TILE_W = 64;
  const TILE_H = 32;
  const HALF_W = TILE_W / 2;
  const HALF_H = TILE_H / 2;

  // Rows push the map to the left (row 55 sits far left of row 0), so shift everything right by
  // rows * HALF_W to keep every x at 0 or more.
  function shiftX(rows) { return rows * HALF_W; }

  // Grid square → the TOP corner of its diamond.
  function toScreen(c, r, rows) {
    return { x: (c - r) * HALF_W + shiftX(rows), y: (c + r) * HALF_H };
  }

  // Grid square → the middle of its diamond (handy for drawing icons and labels).
  function tileCenter(c, r, rows) {
    const p = toScreen(c, r, rows);
    return { x: p.x, y: p.y + HALF_H };
  }

  // Iso world pixel → the grid square it is inside. This is toScreen run backwards, then rounded down.
  // It can return squares outside the map (like c = -1), so check with inMap() before using them.
  function toGrid(x, y, rows) {
    const a = (x - shiftX(rows)) / HALF_W; // = c - r
    const b = y / HALF_H;                  // = c + r
    return { c: Math.floor((a + b) / 2), r: Math.floor((b - a) / 2) };
  }

  function inMap(c, r, cols, rows) {
    return c >= 0 && r >= 0 && c < cols && r < rows;
  }

  // How big the whole isometric map is, in pixels (the camera needs this to know where to stop).
  function worldSize(cols, rows) {
    return { w: (cols + rows) * HALF_W, h: (cols + rows) * HALF_H };
  }

  LW.Iso = { TILE_W, TILE_H, toScreen, tileCenter, toGrid, inMap, worldSize };
})(typeof window !== 'undefined' ? window : globalThis);
