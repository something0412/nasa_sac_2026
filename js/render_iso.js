// Isometric (2.5D) map drawing. Same job as render.js (and the same functions, so main.js can use
// either one), but the Moon is drawn as diamonds and buildings as little 3D blocks.
// Runs every frame (60 fps). Reads the sim state, never changes it.
//
// Two kinds of positions are used here:
//   grid  (c, r)  = the game's squares (can be fractions, e.g. the middle of a square is c + 0.5)
//   world (x, y)  = pixels on the big isometric picture (see js/iso.js). The camera shows part of it.
(function (root) {
  'use strict';
  const MT = (root.MT = root.MT || {});

  const POOL_SIZE = 420;
  const METERS_PER_TILE = 10; // for the "base is 120 m away" tag

  function IsoRenderer(canvas) {
    const C = MT.CONFIG, Iso = MT.Iso;
    const COLS = C.map.cols, ROWS = C.map.rows;
    const HW = Iso.TILE_W / 2, HH = Iso.TILE_H / 2;
    const WORLD = Iso.worldSize(COLS, ROWS), W = WORLD.w, H = WORLD.h;
    const PX_PER_TILE = Math.hypot(HW, HH); // rough screen size of one square, for speeds and lengths
    let VW = 800, VH = 560, DPR = 1; // screen size in CSS pixels
    // ZOOM: 1 = normal, 2 = everything twice as big. The camera then sees VW / zoom world pixels across.
    const ZOOM_MIN = 0.5, ZOOM_MAX = 2.5;
    let zoom = 1;
    const vw = () => VW / zoom, vh = () => VH / zoom; // how much of the world fits on screen
    const safe = { left: 0, right: 0, top: 0, bottom: 0 }; // screen edges covered by open panels
    const ctx = canvas.getContext('2d');

    let ground = null, zoneGrid = null;
    let crew = {}; // astronaut id -> where they stand (grid squares) and where they were drawn (for clicks)
    const pool = [];
    for (let i = 0; i < POOL_SIZE; i++) pool.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, kind: 0, color: '' });
    let time = 0, dashOffset = 0, frac = 0;
    const cam = { x: 0, y: 0, tx: 0, ty: 0, flying: false };
    let tagRect = null;

    // ---------- grid ↔ world helpers ----------
    const P = (c, r) => Iso.toScreen(c, r, ROWS);            // grid point → world pixel
    const mid = (m) => P(m.c + m.w / 2, m.r + m.h / 2);       // middle of a building's footprint
    // A direction in the grid (like "towards the Sun") → the same direction on screen.
    const gridDir = (dc, dr) => ({ x: (dc - dr) * HW, y: (dc + dr) * HH });
    // The 4 corners of a footprint (top, right, bottom, left on screen), shrunk inward by `inset` squares.
    function footprint(c, r, w, h, inset) {
      const k = inset || 0;
      return [P(c + k, r + k), P(c + w - k, r + k), P(c + w - k, r + h - k), P(c + k, r + h - k)];
    }
    function poly(pts, dy) {
      const d = dy || 0;
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y - d);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y - d);
      ctx.closePath();
    }
    // A box standing on a footprint: left face, right face, then the lid `ht` pixels up.
    function prism(f, ht, top, left, right, edge) {
      ctx.beginPath(); ctx.moveTo(f[3].x, f[3].y); ctx.lineTo(f[2].x, f[2].y); ctx.lineTo(f[2].x, f[2].y - ht); ctx.lineTo(f[3].x, f[3].y - ht); ctx.closePath();
      ctx.fillStyle = left; ctx.fill(); if (edge) { ctx.strokeStyle = edge; ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(f[2].x, f[2].y); ctx.lineTo(f[1].x, f[1].y); ctx.lineTo(f[1].x, f[1].y - ht); ctx.lineTo(f[2].x, f[2].y - ht); ctx.closePath();
      ctx.fillStyle = right; ctx.fill(); if (edge) ctx.stroke();
      poly(f, ht); ctx.fillStyle = top; ctx.fill(); if (edge) ctx.stroke();
    }

    // ---------- screen size ----------
    function resize(cssW, cssH) {
      const midX = cam.x + vw() / 2, midY = cam.y + vh() / 2;
      VW = Math.max(200, Math.round(cssW)); VH = Math.max(200, Math.round(cssH));
      cam.x = midX - vw() / 2; cam.y = midY - vh() / 2;
      DPR = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(VW * DPR)) canvas.width = Math.round(VW * DPR);
      if (canvas.height !== Math.round(VH * DPR)) canvas.height = Math.round(VH * DPR);
      moveTo(cam.x, cam.y);
    }
    function setSafeArea(a) { Object.assign(safe, a); }

    // ---------- camera ----------
    const clampX = (x) => (W <= vw() ? (W - vw()) / 2 : Math.max(0, Math.min(W - vw(), x)));
    const clampY = (y) => (H <= vh() ? (H - vh()) / 2 : Math.max(0, Math.min(H - vh(), y)));
    function moveTo(x, y) { cam.x = clampX(x); cam.y = clampY(y); cam.flying = false; }
    function flyTo(x, y) { cam.tx = clampX(x); cam.ty = clampY(y); cam.flying = true; }
    function centerOn(wx, wy, smooth) {
      const sx = (safe.left + VW - safe.right) / 2, sy = (safe.top + VH - safe.bottom) / 2; // screen pixels
      (smooth ? flyTo : moveTo)(wx - sx / zoom, wy - sy / zoom);
    }
    // Zoom in (factor > 1) or out (factor < 1), keeping the spot under the mouse in the same place.
    function zoomAt(evt, factor) {
      const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
      if (next === zoom) return;
      const p = evt ? toCanvas(evt) : { x: VW / 2, y: VH / 2 };
      const wx = cam.x + p.x / zoom, wy = cam.y + p.y / zoom; // world point under the mouse
      zoom = next;
      moveTo(wx - p.x / zoom, wy - p.y / zoom);
    }
    function centerOnBase(state, smooth) {
      const hab = state.modules.find((m) => m.type === 'hab');
      const p = mid(hab);
      centerOn(p.x, p.y, smooth);
    }

    // Mouse → canvas pixels → world pixels → grid square (the diamond under the mouse).
    function toCanvas(evt) {
      const rect = canvas.getBoundingClientRect();
      return { x: ((evt.clientX - rect.left) / rect.width) * VW, y: ((evt.clientY - rect.top) / rect.height) * VH, px: evt.clientX - rect.left, py: evt.clientY - rect.top, scale: VW / rect.width / zoom }; // scale: mouse pixels → world pixels (for dragging)
    }
    function tileAt(evt) {
      const p = toCanvas(evt);
      const g = Iso.toGrid(cam.x + p.x / zoom, cam.y + p.y / zoom, ROWS);
      return { c: g.c, r: g.r, px: p.px, py: p.py };
    }
    function hitTag(evt) {
      if (!tagRect) return false;
      const p = toCanvas(evt);
      const pad = 12;
      return p.x >= tagRect.x - pad && p.x <= tagRect.x + tagRect.w + pad && p.y >= tagRect.y - pad && p.y <= tagRect.y + tagRect.h + pad;
    }

    // ---------- static ground, drawn once ----------
    const ZONE_IDS = { ridge: 0, plain: 1, ice: 2 }, ZONE_NAMES = ['ridge', 'plain', 'ice'];
    const zoneAt = (c, r) => ZONE_NAMES[zoneGrid[r * COLS + c]];
    function buildGround(state) {
      zoneGrid = new Uint8Array(COLS * ROWS);
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) zoneGrid[r * COLS + c] = ZONE_IDS[MT.Sim.zoneOf(state, c, r)];

      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const g = off.getContext('2d');
      let seed = 1234;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const diamond = (path, c, r) => {
        const a = P(c, r), b = P(c + 1, r), d = P(c + 1, r + 1), e = P(c, r + 1);
        path.moveTo(a.x, a.y); path.lineTo(b.x, b.y); path.lineTo(d.x, d.y); path.lineTo(e.x, e.y); path.closePath();
      };
      const paths = { ridge: new Path2D(), plain: new Path2D(), ice: new Path2D() };
      const all = new Path2D();
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { diamond(paths[zoneAt(c, r)], c, r); diamond(all, c, r); }
      for (const z of ['plain', 'ridge', 'ice']) { g.fillStyle = C.zones[z].color; g.fill(paths[z]); g.strokeStyle = C.zones[z].color; g.lineWidth = 1; g.stroke(paths[z]); }

      // Dust speckles and craters, only on the Moon (not in the empty corners of the picture).
      g.save(); g.clip(all);
      const area = (COLS * ROWS) / (20 * 14);
      for (let i = 0; i < 1300 * area; i++) {
        const p = P(rand() * COLS, rand() * ROWS), s = rand() * 2 + 0.5;
        g.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
        g.fillRect(p.x, p.y, s, s);
      }
      const base = document.createElement('canvas'); // the ground before craters (see drawCrater in render.js)
      base.width = W; base.height = H; base.getContext('2d').drawImage(off, 0, 0);
      const craters = [];
      for (let i = 0; i < 23 * area; i++) { const p = P(rand() * COLS, rand() * ROWS); craters.push({ x: p.x, y: p.y, r: (4 + rand() ** 2 * 30) * 1.25 }); }
      craters.sort((a, b) => b.r - a.r); // big (old) craters first, so small ones land on top of them
      for (const k of craters) MT.drawCrater(g, k.x, k.y, k.r, 0.5, base); // same crater as render.js, squashed flat
      g.restore();
      g.save(); g.clip(paths.ice);
      for (let i = 0; i < 260 * area; i++) {
        const p = P(rand() * COLS, rand() * ROWS);
        g.fillStyle = `rgba(170,210,255,${0.15 + rand() * 0.35})`;
        g.fillRect(p.x, p.y, 1.5, 1.5);
      }
      g.restore();

      // Ridge edges: a darker "cliff" strip where high ground meets low ground (the 2.5D look).
      const cliff = new Path2D(), rim = new Path2D();
      const isRidge = (c, r) => c >= 0 && r >= 0 && c < COLS && r < ROWS && zoneAt(c, r) === 'ridge';
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
        if (!isRidge(c, r)) continue;
        const edges = [];
        if (r + 1 < ROWS && !isRidge(c, r + 1)) edges.push([P(c, r + 1), P(c + 1, r + 1)]); // front-left edge
        if (c + 1 < COLS && !isRidge(c + 1, r)) edges.push([P(c + 1, r), P(c + 1, r + 1)]); // front-right edge
        for (const [a, b] of edges) {
          cliff.moveTo(a.x, a.y); cliff.lineTo(b.x, b.y); cliff.lineTo(b.x, b.y + 7); cliff.lineTo(a.x, a.y + 7); cliff.closePath();
          rim.moveTo(a.x, a.y); rim.lineTo(b.x, b.y);
        }
        if (r > 0 && !isRidge(c, r - 1)) { const a = P(c, r), b = P(c + 1, r); rim.moveTo(a.x, a.y); rim.lineTo(b.x, b.y); }
        if (c > 0 && !isRidge(c - 1, r)) { const a = P(c, r), b = P(c, r + 1); rim.moveTo(a.x, a.y); rim.lineTo(b.x, b.y); }
      }
      g.fillStyle = 'rgba(30,30,38,0.55)'; g.fill(cliff);
      g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 2; g.stroke(rim);

      // faint diamond grid
      g.strokeStyle = 'rgba(255,255,255,0.045)'; g.lineWidth = 1;
      for (let c = 0; c <= COLS; c++) { const a = P(c, 0), b = P(c, ROWS); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
      for (let r = 0; r <= ROWS; r++) { const a = P(0, r), b = P(COLS, r); g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }

      g.font = 'bold 13px system-ui, sans-serif'; g.textAlign = 'center';
      for (const f of C.features) {
        const p = P(f.u * COLS, f.v * ROWS);
        g.fillStyle = f.zone === 'ice' ? 'rgba(170,210,255,0.75)' : 'rgba(255,255,255,0.6)';
        g.fillText(f.label, p.x, p.y);
      }
      ground = off;
      crew = {};
    }

    // ---------- particles (object pool, no new objects per frame) ----------
    function spawn(kind, x, y, vx, vy, life, color) {
      for (const p of pool) if (!p.alive) { p.alive = true; p.kind = kind; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.life = 0; p.max = life; p.color = color; return p; }
      return null;
    }

    // Direction the sunlight comes FROM, in grid squares (unit length). Smooth between game hours.
    const sunGrid = (state) => {
      const a = (MT.Sim.sunAz(state, state.hour + frac) * Math.PI) / 180;
      return { c: Math.cos(a), r: Math.sin(a) };
    };
    const lightAt = (state, m) => MT.Sim.zoneLight(state, MT.Sim.zoneOf(state, m.c, m.r), state.hour + frac);

    function hull(pts) {
      pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
      const lo = [], up = [];
      for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
      for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
      return lo.slice(0, -1).concat(up.slice(0, -1));
    }
    const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

    // How tall each building is drawn (pixels). Used for the block, labels and status icons.
    const HEIGHT = { hab: 26, solar: 34, battery: 22, o2gen: 18, greenhouse: 20, drill: 32, shelter: 16, gym: 7, tower: 30, lab: 18 };

    // ---------- buildings ----------
    function drawModule(state, m, blink) {
      const on = m.built && m.on && m.powered;
      const ctr = mid(m), ht = HEIGHT[m.type] || 16;
      ctx.save();
      if (!m.built) ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      switch (m.type) {
        case 'hab': {
          if (state.berm.built || state.berm.building) { // moon-dirt shield piled around the habitat
            const f = state.berm.built ? 1 : state.berm.progress / C.bermWork;
            ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y, 2.1 * HW * 0.62, 2.1 * HH * 0.62, 0, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f);
            ctx.strokeStyle = '#8a7558'; ctx.lineWidth = 12; ctx.stroke(); ctx.lineWidth = 1;
          }
          const f = footprint(m.c, m.r, m.w, m.h, 0.32);
          prism(f, ht - 10, '#d9dde4', '#aeb5c1', '#c4cad4', '#8f96a3');
          // dome roof
          ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y - (ht - 10), HW * 0.95, HH * 0.95, 0, Math.PI, 0);
          ctx.lineTo(ctr.x + HW * 0.95, ctr.y - (ht - 10)); ctx.ellipse(ctr.x, ctr.y - (ht - 10), HW * 0.95, HH * 0.95, 0, 0, Math.PI);
          ctx.fillStyle = '#e4e8ee'; ctx.fill();
          ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y - (ht - 10), HW * 0.95, HW * 0.55, 0, Math.PI, 0);
          ctx.fillStyle = '#eef1f5'; ctx.fill(); ctx.strokeStyle = '#8f96a3'; ctx.stroke();
          // windows on the two front walls
          const win = on ? (state.habTemp < 15 ? '#7fb4ff' : '#ffd36b') : '#39404b';
          ctx.fillStyle = win;
          for (const t of [0.3, 0.7]) {
            const a = { x: f[3].x + (f[2].x - f[3].x) * t, y: f[3].y + (f[2].y - f[3].y) * t };
            const b = { x: f[2].x + (f[1].x - f[2].x) * t, y: f[2].y + (f[1].y - f[2].y) * t };
            ctx.fillRect(a.x - 3, a.y - 12, 6, 6); ctx.fillRect(b.x - 3, b.y - 12, 6, 6);
          }
          ctx.fillStyle = '#5b6576'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.fillText('HAB', ctr.x, ctr.y - ht + 2);
          break;
        }
        case 'solar': {
          // A tall panel on a post. It turns to face the Sun (the Sun is always low at the south pole).
          const L = lightAt(state, m), s = sunGrid(state);
          ctx.fillStyle = '#555'; ctx.fillRect(ctr.x - 1.5, ctr.y - 10, 3, 10);
          const half = gridDir(-s.r * 0.36, s.c * 0.36); // half the panel width, sideways to the Sun
          const lo = 8, hi = ht;
          const a = { x: ctr.x - half.x, y: ctr.y - half.y }, b = { x: ctr.x + half.x, y: ctr.y + half.y };
          ctx.beginPath(); ctx.moveTo(a.x, a.y - lo); ctx.lineTo(b.x, b.y - lo); ctx.lineTo(b.x, b.y - hi); ctx.lineTo(a.x, a.y - hi); ctx.closePath();
          const facing = gridDir(s.c, s.r).y > 0; // we see the sunny side when the Sun is "in front"
          ctx.fillStyle = rgb(mix(facing ? [29, 44, 72] : [22, 28, 40], facing ? [47, 111, 214] : [52, 64, 88], L)); ctx.fill();
          ctx.strokeStyle = rgb(mix([58, 74, 102], [156, 195, 255], L)); ctx.stroke();
          ctx.beginPath();
          for (let i = 1; i < 4; i++) { const t = i / 4; ctx.moveTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t - lo); ctx.lineTo(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t - hi); }
          ctx.stroke();
          if (L > 0.3 && m.built && m.on && facing) {
            ctx.fillStyle = `rgba(255,255,255,${(0.25 + 0.25 * Math.sin(time * 3 + m.id)) * L})`;
            ctx.beginPath(); ctx.moveTo(a.x, a.y - lo); ctx.lineTo(a.x + (b.x - a.x) * 0.25, a.y + (b.y - a.y) * 0.25 - lo);
            ctx.lineTo(a.x + (b.x - a.x) * 0.25, a.y + (b.y - a.y) * 0.25 - hi); ctx.lineTo(a.x, a.y - hi); ctx.closePath(); ctx.fill();
          }
          break;
        }
        case 'battery': {
          const cap = MT.Sim.batteryCap(state) || 1;
          const fr = Math.max(0, Math.min(1, state.res.battery / cap));
          const f = footprint(m.c, m.r, 1, 1, 0.24);
          prism(f, ht, '#3a414d', '#22272f', '#2a2f38', '#8a93a3');
          // charge level shown on the right wall
          if (m.built) {
            const lvl = (ht - 6) * fr;
            ctx.beginPath(); ctx.moveTo(f[2].x + 3, f[2].y - 3); ctx.lineTo(f[1].x - 3, f[1].y - 3 + 2); ctx.lineTo(f[1].x - 3, f[1].y - 3 + 2 - lvl); ctx.lineTo(f[2].x + 3, f[2].y - 3 - lvl); ctx.closePath();
            ctx.fillStyle = fr < 0.2 ? '#ff5d5d' : fr < 0.5 ? '#ffc04d' : '#5fe08a'; ctx.fill();
          }
          ctx.fillStyle = '#596273'; ctx.fillRect(ctr.x - 4, ctr.y - ht - 3, 8, 4);
          break;
        }
        case 'o2gen': {
          const f = footprint(m.c, m.r, 1, 1, 0.26);
          prism(f, ht, '#d6dee8', '#a9b4c2', '#bcc6d2', '#7f8b99');
          ctx.fillStyle = on && !m.noWater ? '#58c4ff' : '#59636f';
          ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.fillText('O₂', ctr.x, ctr.y - ht + 4);
          if (on && !m.noWater && Math.random() < 0.15) spawn(2, ctr.x + (Math.random() - 0.5) * 12, ctr.y - ht - 4, 0, -12, 1.2, '#9fe0ff');
          break;
        }
        case 'greenhouse': {
          const f = footprint(m.c, m.r, 1, 1, 0.1);
          poly(f); ctx.fillStyle = '#3a3f46'; ctx.fill(); // floor
          for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { // plants
            const p = P(m.c + 0.25 + i * 0.25, m.r + 0.25 + j * 0.25);
            ctx.fillStyle = on ? '#4fdc6a' : '#3c6b45';
            ctx.beginPath(); ctx.ellipse(p.x, p.y - 3, on ? 3.6 + Math.sin(time * 2 + i + j) * 0.4 : 2.6, on ? 4.5 : 3, 0, 0, Math.PI * 2); ctx.fill();
          }
          // glass walls and roof (see-through)
          const glass = on ? 'rgba(255,120,220,0.18)' : 'rgba(80,90,100,0.3)', edge = on ? '#ff9de8' : '#6b7480';
          prism(f, ht, on ? 'rgba(255,150,230,0.22)' : 'rgba(90,100,110,0.35)', glass, glass, edge);
          break;
        }
        case 'drill': {
          // Tripod over the ice, with a spinning drill bit.
          const top = { x: ctr.x, y: ctr.y - ht };
          ctx.strokeStyle = '#e0b860'; ctx.lineWidth = 2.5;
          for (const [dc, dr] of [[-0.35, -0.35], [0.35, 0.05], [0.05, 0.35]]) {
            const p = P(m.c + 0.5 + dc, m.r + 0.5 + dr);
            ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(p.x, p.y); ctx.stroke();
          }
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
          const a = on ? time * 8 : 0;
          ctx.beginPath(); ctx.moveTo(ctr.x - Math.cos(a) * 7, ctr.y - 4 - Math.sin(a) * 3.5); ctx.lineTo(ctr.x + Math.cos(a) * 7, ctr.y - 4 + Math.sin(a) * 3.5); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(ctr.x, top.y); ctx.lineTo(ctr.x, ctr.y - 4); ctx.stroke();
          if (on && Math.random() < 0.25) spawn(1, ctr.x, ctr.y, (Math.random() - 0.5) * 30, -Math.random() * 15, 0.9, 'rgba(190,220,255,0.8)');
          break;
        }
        case 'shelter': {
          // A mound of moon dirt with a dark doorway: the dirt blocks the radiation.
          ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y, HW * 0.75, HH * 0.75, 0, 0, Math.PI); ctx.ellipse(ctr.x, ctr.y, HW * 0.75, ht + HH * 0.2, 0, Math.PI, 0);
          ctx.fillStyle = '#8a7558'; ctx.fill(); ctx.strokeStyle = '#b39a77'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.beginPath(); ctx.ellipse(ctr.x - 2, ctr.y - ht * 0.55, HW * 0.55, ht * 0.5, 0, Math.PI * 1.15, Math.PI * 1.6);
          ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.stroke();
          ctx.fillStyle = '#2b2b2b'; ctx.beginPath(); ctx.roundRect(ctr.x - 4, ctr.y - 8, 8, 10, [4, 4, 0, 0]); ctx.fill();
          if (state.sheltering) { ctx.fillStyle = '#7dff9a'; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'; ctx.fillText('CREW', ctr.x, ctr.y - ht - 6); }
          break;
        }
        case 'gym': {
          const training = state.crew.some((a) => a.where === 'gym' && a.gymId === m.id);
          const f = footprint(m.c, m.r, 1, 1, 0.12);
          prism(f, ht, '#2f3a4c', '#232c3a', '#283244', on && !m.damaged ? '#7fb4ff' : '#59636f');
          const lift = training ? Math.abs(Math.sin(time * 4)) * 6 : 0;
          const y = ctr.y - ht - 4 - lift;
          ctx.fillStyle = '#c9d3df'; ctx.fillRect(ctr.x - 9, y - 1.5, 18, 3);
          ctx.fillStyle = training ? '#ffd36b' : '#8a93a3';
          ctx.fillRect(ctr.x - 13, y - 6, 4, 12); ctx.fillRect(ctr.x + 9, y - 6, 4, 12);
          break;
        }
        case 'tower': {
          const f = footprint(m.c, m.r, 1, 1, 0.22);
          prism(f, 14, '#5b6371', '#3f4652', '#4b5361', '#6f7888');
          const dy = ctr.y - 14;
          ctx.beginPath(); ctx.ellipse(ctr.x, dy, 13, 6.5, 0, 0, Math.PI); ctx.ellipse(ctr.x, dy, 13, 13, 0, Math.PI, 0);
          ctx.fillStyle = '#e4e8ee'; ctx.fill(); ctx.strokeStyle = '#9aa2af'; ctx.stroke();
          const sweep = m.built ? Math.sin(time * 0.6 + m.id) * 0.5 : 0;
          ctx.save(); ctx.translate(ctr.x, dy - 4); ctx.rotate(sweep);
          ctx.fillStyle = '#1b2230'; ctx.fillRect(-2.5, -9, 5, 9);
          ctx.fillStyle = '#ffd36b'; ctx.fillRect(-1.5, -15, 3, 8);
          ctx.restore();
          if (m.built && blink && !MT.Sim.towerReadyIn(state, m)) { ctx.fillStyle = '#7fb4ff'; ctx.beginPath(); ctx.arc(f[1].x - 4, f[1].y - 16, 2.2, 0, Math.PI * 2); ctx.fill(); } // ready to use
          break;
        }
        case 'lab': {
          // Research Bay: a low lab block with a round window; a flask on the roof glows while the Scientist works.
          const busy = state.crew.some((a) => !a.medbay && a.task && a.task.kind === 'lab' && a.task.id === m.id);
          const f = footprint(m.c, m.r, 1, 1, 0.18);
          prism(f, ht, '#dfe5ec', '#aab4c1', '#c1c9d4', '#7f8b99');
          const w = { x: f[3].x + (f[2].x - f[3].x) * 0.5, y: f[3].y + (f[2].y - f[3].y) * 0.5 - ht * 0.5 };
          ctx.fillStyle = '#26303f'; ctx.beginPath(); ctx.ellipse(w.x, w.y, 4, 4.5, 0, 0, Math.PI * 2); ctx.fill();
          const ty = ctr.y - ht;
          ctx.fillStyle = busy ? '#6fd3ff' : '#4d5868';
          ctx.beginPath(); ctx.moveTo(ctr.x - 2, ty - 12); ctx.lineTo(ctr.x + 2, ty - 12); ctx.lineTo(ctr.x + 2, ty - 8); ctx.lineTo(ctr.x + 6, ty); ctx.lineTo(ctr.x - 6, ty); ctx.lineTo(ctr.x - 2, ty - 8); ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#9aa2af'; ctx.fillRect(f[1].x - 8, f[1].y - ht - 9, 2, 9); // antenna
          if (busy && Math.random() < 0.12) spawn(2, ctr.x + (Math.random() - 0.5) * 6, ty - 12, 0, -14, 1, '#bdf0ff');
          break;
        }
      }
      ctx.restore();
      drawStatus(state, m, blink, ctr, ht);
    }

    // Building under construction / OFF / no power / no water / damaged: shown on the footprint diamond.
    function drawStatus(state, m, blink, ctr, ht) {
      const f = footprint(m.c, m.r, m.w, m.h, 0.04);
      const bar = (fr, color) => {
        const w = 30 * Math.min(m.w, 2), x = ctr.x - w / 2, y = ctr.y + HH * m.h * 0.55;
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x, y, w, 5);
        ctx.fillStyle = color; ctx.fillRect(x, y, w * fr, 5);
      };
      const icon = (txt, size) => { ctx.font = `${size}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(txt, ctr.x + HW * 0.45, ctr.y - ht - 4); };
      ctx.save();
      if (!m.built) {
        ctx.strokeStyle = '#ffd36b'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; poly(f); ctx.stroke(); ctx.setLineDash([]);
        bar(m.progress / C.modules[m.type].work, '#ffd36b');
      } else if (!m.on) {
        poly(f); ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fill();
        ctx.fillStyle = '#ccc'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.fillText('OFF', ctr.x, ctr.y - ht - 4);
      } else if (MT.Sim.needOf(state, m) > 0 && m.type !== 'solar' && !m.powered) {
        poly(f); ctx.fillStyle = 'rgba(40,0,0,0.45)'; ctx.fill();
        ctx.strokeStyle = '#ff5d5d'; ctx.lineWidth = 2; ctx.stroke();
        if (blink) icon('⚡', 16);
      } else if (m.noWater && blink) {
        poly(f); ctx.strokeStyle = '#58c4ff'; ctx.lineWidth = 2; ctx.stroke();
        icon('💧', 14);
      }
      if (m.built && m.damaged) { // damage from storms or meteors: cracks + wrench, and repair progress
        poly(f); ctx.fillStyle = 'rgba(60,20,0,0.35)'; ctx.fill();
        ctx.strokeStyle = 'rgba(255,170,90,0.9)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(ctr.x - 14, ctr.y - 2); ctx.lineTo(ctr.x - 6, ctr.y + 2); ctx.lineTo(ctr.x - 8, ctr.y + 6); ctx.lineTo(ctr.x + 2, ctr.y + 9);
        ctx.moveTo(ctr.x + 8, ctr.y - 6); ctx.lineTo(ctr.x + 15, ctr.y - 2); ctx.stroke();
        if (m.repair || blink) icon('🔧', 13);
        if (m.repair) bar(m.repair.progress / m.repair.work, '#ff9f45');
      }
      // Moondust on a solar panel (accident): brown footprint with speckles.
      if (m.built && m.type === 'solar' && m.dustLeft > 0) {
        poly(f); ctx.fillStyle = 'rgba(140,110,70,0.45)'; ctx.fill();
        ctx.fillStyle = 'rgba(190,160,110,0.9)';
        for (let i = 0; i < 9; i++) { const p = P(m.c + 0.15 + ((i * 0.37 + m.id * 0.11) % 0.7), m.r + 0.15 + ((i * 0.23 + m.id * 0.07) % 0.7)); ctx.fillRect(p.x, p.y, 2, 2); }
      }
      // Research boost: "1.5x" / "2x" badge above machines close enough to a Research Bay.
      if (m.built && C.research.targets.includes(m.type)) {
        const b = MT.Sim.boostOf(state, m);
        if (b > 1) {
          const x = ctr.x - HW * 0.5, y = ctr.y - ht - 10;
          ctx.fillStyle = 'rgba(10,14,22,0.85)'; ctx.beginPath(); ctx.roundRect(x - 10, y - 8, 20, 11, 3); ctx.fill();
          ctx.fillStyle = '#6fd3ff'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText(b + 'x', x, y + 0.5);
        }
      }
      ctx.restore();
    }

    // ---------- astronauts ----------
    function drawAstronaut(A, a, exposed, danger, blink, sel) {
      const p = P(a.c, a.r);
      a.x = p.x; a.y = p.y; // remembered for clicks (crewAt)
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(p.x, p.y, 5, 2.5, 0, 0, Math.PI * 2); ctx.fill();
      if (sel) { // picked: pulsing gold ring on the ground
        const k = 1 + Math.sin(time * 5) * 0.15;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 11 * k, 5.5 * k, 0, 0, Math.PI * 2); ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2; ctx.stroke();
      }
      const body = exposed && danger && blink ? '#ff5d5d' : MT.Sim.isSlow(A) ? '#ffc04d' : '#ffffff';
      ctx.fillStyle = body; ctx.beginPath(); ctx.roundRect(p.x - 3.5, p.y - 10, 7, 9, 3); ctx.fill(); // suit
      ctx.beginPath(); ctx.arc(p.x, p.y - 12.5, 4, 0, Math.PI * 2); ctx.fill(); // helmet
      ctx.beginPath(); ctx.arc(p.x + 1.2, p.y - 13, 2, 0, Math.PI * 2); ctx.fillStyle = '#f5a623'; ctx.fill(); // visor
      // number tag (border = role colour) so you can match the astronaut to the AMS list
      ctx.fillStyle = 'rgba(10,14,22,0.85)'; ctx.beginPath(); ctx.roundRect(p.x - 6, p.y - 29, 12, 10, 3); ctx.fill();
      ctx.strokeStyle = C.astro.roleInfo[A.role].color; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#ffd36b'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText(String(A.id), p.x, p.y - 21.5);
    }

    // ---------- meteor shower animation ----------
    function spawnMeteors(dt) {
      const want = 9 * dt;
      let n = Math.floor(want) + (Math.random() < want % 1 ? 1 : 0);
      while (n-- > 0) {
        const sp = 380 + Math.random() * 260;
        const vx = -0.78 * sp, vy = 0.62 * sp;
        const life = 0.55 + Math.random() * 0.9;
        const lx = cam.x - 40 + Math.random() * (vw() + 80), ly = cam.y - 20 + Math.random() * (vh() + 40);
        spawn(3, lx - vx * life, ly - vy * life, vx, vy, life, Math.random() < 0.25 ? '#ffd6a0' : '#f2f6ff');
      }
    }

    // ---------- "back to base" tag on the edge of the view ----------
    function drawBaseTag(hc, habM) {
      const sx = (hc.x - cam.x) * zoom, sy = (hc.y - cam.y) * zoom; // base position on screen
      tagRect = null;
      const L = safe.left, R = VW - safe.right, Tp = safe.top, B = VH - safe.bottom;
      if (sx > L + 30 && sx < R - 30 && sy > Tp + 30 && sy < B - 30) return;
      const ox = (L + R) / 2, oy = (Tp + B) / 2, dx = sx - ox, dy = sy - oy;
      const mx = Math.max(10, (R - L) / 2 - 64), my = Math.max(10, (B - Tp) / 2 - 26);
      const t = Math.min(mx / Math.max(1e-6, Math.abs(dx)), my / Math.max(1e-6, Math.abs(dy)));
      const px = ox + dx * t, py = oy + dy * t;
      const ang = Math.atan2(dy, dx);
      // distance in squares between the middle of the screen and the habitat
      const v = Iso.toGrid(cam.x + vw() / 2, cam.y + vh() / 2, ROWS);
      const dist = Math.round((Math.hypot(v.c - (habM.c + 1), v.r - (habM.r + 1)) * METERS_PER_TILE) / 10) * 10;
      const pulse = 0.75 + 0.25 * Math.sin(time * 4);
      ctx.save();
      ctx.translate(px + Math.cos(ang) * 46, py + Math.sin(ang) * 20);
      ctx.rotate(ang);
      ctx.fillStyle = `rgba(255,211,107,${pulse})`;
      ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(-6, -9); ctx.lineTo(-6, 9); ctx.closePath(); ctx.fill();
      ctx.restore();
      const w = 104, h = 36, x = px - w / 2, y = py - h / 2;
      ctx.fillStyle = 'rgba(12,16,26,0.9)';
      ctx.strokeStyle = `rgba(255,211,107,${pulse})`; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffd36b'; ctx.font = 'bold 13px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('🏠 BASE', px, py - 2);
      ctx.fillStyle = '#c9d1dc'; ctx.font = '10px system-ui';
      ctx.fillText(`${dist} m · click`, px, py + 12);
      tagRect = { x, y, w, h };
    }

    // ---------- main draw ----------
    function draw(state, dt, ui) {
      if (!ground) { buildGround(state); centerOnBase(state, false); }
      frac = ui.frac || 0;
      time += dt;
      dashOffset -= dt * 28;
      if (cam.flying) {
        const k = Math.min(1, dt * 6);
        cam.x += (cam.tx - cam.x) * k; cam.y += (cam.ty - cam.y) * k;
        if (Math.abs(cam.tx - cam.x) < 0.5 && Math.abs(cam.ty - cam.y) < 0.5) { cam.x = cam.tx; cam.y = cam.ty; cam.flying = false; }
      }
      const blink = Math.floor(time * 2.5) % 2 === 0;
      const habM = state.modules.find((m) => m.type === 'hab');
      const hc = mid(habM);

      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.fillStyle = '#0b0e15'; ctx.fillRect(0, 0, VW, VH);
      const S = DPR * zoom; // world pixels → device pixels
      ctx.setTransform(S, 0, 0, S, -Math.round(cam.x * S), -Math.round(cam.y * S));
      const gx = Math.max(0, Math.floor(cam.x)), gy = Math.max(0, Math.floor(cam.y));
      const gw = Math.min(W - gx, Math.ceil(vw()) + 2), gh = Math.min(H - gy, Math.ceil(vh()) + 2);
      if (gw > 0 && gh > 0) ctx.drawImage(ground, gx, gy, gw, gh, gx, gy, gw, gh);
      const VWz = vw(), VHz = vh(); // the part of the world on screen, in world pixels

      // Terrain shadow: each zone gets darker as the Sun slides behind the hills. Only squares on screen.
      const corners = [[cam.x, cam.y], [cam.x + VWz, cam.y], [cam.x, cam.y + VHz], [cam.x + VWz, cam.y + VHz]].map(([x, y]) => Iso.toGrid(x, y, ROWS));
      const c0 = Math.max(0, Math.min(...corners.map((g) => g.c)) - 1), c1 = Math.min(COLS - 1, Math.max(...corners.map((g) => g.c)) + 1);
      const r0 = Math.max(0, Math.min(...corners.map((g) => g.r)) - 1), r1 = Math.min(ROWS - 1, Math.max(...corners.map((g) => g.r)) + 1);
      const shadeOf = {
        ridge: 0.75 * (1 - MT.Sim.zoneLight(state, 'ridge', state.hour + frac)),
        plain: 0.75 * (1 - MT.Sim.zoneLight(state, 'plain', state.hour + frac)),
        ice: 0.35,
      };
      for (const z of ['ridge', 'plain', 'ice']) {
        if (shadeOf[z] < 0.005) continue;
        ctx.fillStyle = z === 'ice' ? 'rgba(5,8,25,0.35)' : `rgba(5,8,20,${shadeOf[z].toFixed(3)})`;
        ctx.beginPath();
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          if (zoneAt(c, r) !== z) continue;
          const t = P(c, r);
          if (t.x + HW < cam.x || t.x - HW > cam.x + VWz || t.y + 2 * HH < cam.y || t.y > cam.y + VHz) continue;
          ctx.moveTo(t.x, t.y); ctx.lineTo(t.x + HW, t.y + HH); ctx.lineTo(t.x, t.y + 2 * HH); ctx.lineTo(t.x - HW, t.y + HH); ctx.closePath();
        }
        ctx.fill();
      }

      // Object shadows point AWAY from the Sun, long and soft because the Sun is always low at the pole.
      const sg = sunGrid(state);
      for (const m of state.modules) {
        if (!m.built) continue;
        const L = lightAt(state, m);
        if (L < 0.02) continue;
        const len = (m.type === 'hab' ? 1.1 : m.type === 'solar' || m.type === 'drill' || m.type === 'tower' ? 0.9 : 0.5) * (1 + (1 - L) * 1.5);
        const f = footprint(m.c, m.r, m.w, m.h, m.type === 'hab' ? 0.3 : 0.25);
        const off = gridDir(-sg.c * len, -sg.r * len);
        const pts = f.map((p) => [p.x, p.y]);
        const hp = hull(pts.concat(pts.map(([px, py]) => [px + off.x, py + off.y])));
        ctx.fillStyle = `rgba(0,0,0,${(0.28 * L).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(hp[0][0], hp[0][1]);
        for (let i = 1; i < hp.length; i++) ctx.lineTo(hp[i][0], hp[i][1]);
        ctx.closePath(); ctx.fill();
      }

      // power cables on the ground: yellow moving dashes = power flowing, red = no power
      ctx.lineWidth = 2;
      for (const m of state.modules) {
        if (m.type === 'hab' || !m.built) continue;
        const c = mid(m);
        let color, flow = 0;
        if (m.type === 'solar') { const lit = m.light > 0.02 && m.on; color = lit ? '#ffd36b' : '#4a4f5a'; flow = lit ? 1 : 0; }
        else if (m.type === 'battery') {
          const charging = state.power.supply > state.power.use;
          color = state.res.battery > 0.01 || charging ? '#7de0a0' : '#4a4f5a'; flow = charging ? 1 : state.res.battery > 0.01 ? -1 : 0;
        } else if (m.type === 'shelter' || !MT.Sim.needOf(state, m)) { color = m.type === 'shelter' ? '#6b5b45' : '#5a6170'; } // walkways, no power cable
        else { color = !m.on ? '#4a4f5a' : m.powered ? '#ffd36b' : '#ff5d5d'; flow = m.on && m.powered ? -1 : 0; }
        ctx.strokeStyle = color;
        ctx.setLineDash(flow ? [6, 6] : (m.type === 'shelter' || !MT.Sim.needOf(state, m)) ? [2, 4] : [3, 5]);
        ctx.lineDashOffset = flow * dashOffset;
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(hc.x, hc.y); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.lineDashOffset = 0;

      // Research Bay reach (dashed ring on the ground): while placing one, hovering one, or with the Scientist
      // picked. A circle of R squares on the grid is an ellipse √2·R·HW wide and √2·R·HH tall on screen.
      const picked = ui.selectedCrew ? state.crew.find((a) => a.id === ui.selectedCrew && !a.medbay) : null;
      const hoverM = ui.hover && !ui.buildType && Iso.inMap(ui.hover.c, ui.hover.r, COLS, ROWS) ? MT.Sim.moduleAt(state, ui.hover.c, ui.hover.r) : null;
      const rings = [];
      if (ui.buildType === 'lab' && ui.hover) rings.push({ ...P(ui.hover.c + 0.5, ui.hover.r + 0.5) });
      for (const l of MT.Sim.built(state, 'lab')) {
        if ((picked && picked.role === 'scientist') || hoverM === l || (hoverM && C.research.targets.includes(hoverM.type))) rings.push({ ...mid(l), dead: l.damaged });
      }
      for (const g of rings) {
        const R = C.research.radius * Math.SQRT2;
        ctx.beginPath(); ctx.ellipse(g.x, g.y, R * HW, R * HH, 0, 0, Math.PI * 2);
        ctx.fillStyle = g.dead ? 'rgba(255,93,93,0.04)' : 'rgba(111,211,255,0.06)'; ctx.fill();
        ctx.setLineDash([8, 6]); ctx.lineDashOffset = dashOffset * 0.5;
        ctx.strokeStyle = g.dead ? 'rgba(255,93,93,0.6)' : 'rgba(111,211,255,0.75)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      // The picked Engineer's job sites get a dashed outline in their role colour.
      const jobs = MT.Sim.jobList(state);
      if (picked) {
        ctx.strokeStyle = C.astro.roleInfo[picked.role].color; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
        for (const j of jobs) if (j.assignee === picked.id) { const m = j.m || habM; poly(footprint(m.c, m.r, m.w, m.h, -0.06)); ctx.stroke(); }
        ctx.setLineDash([]);
      }

      // Astronauts: work out where each one is (in grid squares), walking toward where the AMS says they are.
      const shelter = MT.Sim.built(state, 'shelter')[0];
      const danger = state.stormRate > C.rad.stormOn || !!state.meteorOn;
      const hcg = { c: habM.c + habM.w / 2, r: habM.r + habM.h / 2 };
      const gmid = (m) => ({ c: m.c + m.w / 2, r: m.r + m.h / 2 });
      const people = [];
      for (const k in crew) crew[k].shown = false; // astronauts sent home to Earth are no longer in state.crew
      state.crew.forEach((A) => {
        const i = A.id - 1; // keyed by id, so someone leaving never moves the others' spots
        const a = crew[A.id] || (crew[A.id] = { c: 0, r: 0, init: false });
        let tc = hcg.c + Math.cos(i * 1.57 + 0.8) * 0.22, tr = hcg.r + Math.sin(i * 1.57 + 0.8) * 0.22;
        let visible = false;
        if (A.where === 'shelter' && shelter) { const s = gmid(shelter); tc = s.c - 0.2 + i * 0.15; tr = s.r + 0.4; visible = true; }
        else if (A.where === 'gym') {
          const g = state.modules.find((m) => m.id === A.gymId);
          if (g) { const gc = gmid(g); tc = gc.c + 0.3; tr = gc.r + 0.3; visible = true; }
        } else if (A.task && A.where === A.task.kind) { // Research Bay, greenhouse or Astronomy Tower
          const tm = state.modules.find((m) => m.id === A.task.id);
          if (tm) { const g = gmid(tm); tc = g.c + 0.38 + Math.sin(time * 1.5 + i) * 0.04; tr = g.r + 0.38; visible = true; }
        } else if (A.where === 'outside') {
          const j = jobs.find((x) => x.key === A.job);
          const jc = j && j.m ? gmid(j.m) : { c: hcg.c + Math.cos(time * 0.4 + i * 3) * 1.05, r: hcg.r + Math.sin(time * 0.4 + i * 3) * 1.05 };
          tc = jc.c + 0.38 + Math.sin(time * 3 + i) * 0.07; tr = jc.r + 0.38; visible = true;
        }
        if (!a.init) { a.c = tc; a.r = tr; a.init = true; }
        const dc = tc - a.c, dr = tr - a.r, d = Math.hypot(dc, dr), sp = (140 / 40) * dt; // same walking speed as the top-down map
        if (d > sp) { a.c += (dc / d) * sp; a.r += (dr / d) * sp; } else { a.c = tc; a.r = tr; }
        const sel = picked === A;
        a.id = A.id;
        a.shown = !A.medbay && (visible || d * PX_PER_TILE >= 1 || sel); // the picked astronaut is always shown, even inside
        if (!a.shown) return; // inside the habitat (or medbay): hidden
        people.push({ depth: a.c + a.r, draw: () => drawAstronaut(A, a, MT.Sim.isExposed(A), danger, blink, sel) });
      });

      // Draw buildings and people from the back of the map to the front, so nearer things cover farther ones.
      const things = state.modules.map((m) => ({ depth: m.c + m.w / 2 + m.r + m.h / 2, draw: () => drawModule(state, m, blink) }));
      for (const t of things.concat(people).sort((a, b) => a.depth - b.depth)) t.draw();

      // radiation storm particles stream in from the Sun's direction
      if (state.stormRate > C.rad.stormOn) {
        const sv = gridDir(sg.c, sg.r), n0 = Math.hypot(sv.x, sv.y) || 1, ux = sv.x / n0, uy = sv.y / n0;
        const n = Math.min(6, state.stormRate * 0.6 + 0.5);
        const vx = cam.x + VWz / 2, vy = cam.y + VHz / 2;
        for (let k = 0; k < n; k++) {
          if (Math.random() > 0.5) continue;
          const perp = (Math.random() - 0.5) * 1.6 * VWz;
          const sx = vx + ux * VWz * 0.65 - uy * perp, sy = vy + uy * VWz * 0.65 + ux * perp;
          const sp = 500 + Math.random() * 300;
          spawn(0, sx, sy, -ux * sp, -uy * sp, 2.2, Math.random() < 0.5 ? 'rgba(255,90,90,0.7)' : 'rgba(255,220,120,0.7)');
        }
      }
      if (state.meteorOn) spawnMeteors(dt);
      for (const p of pool) {
        if (!p.alive) continue;
        p.life += dt;
        if (p.life >= p.max) {
          p.alive = false;
          if (p.kind === 3) {
            spawn(4, p.x, p.y, 0, 0, 0.55, p.color);
            for (let k = 0; k < 5; k++) spawn(1, p.x, p.y, (Math.random() - 0.5) * 60, -Math.random() * 40, 0.7, 'rgba(200,200,205,0.8)');
          }
          continue;
        }
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.kind === 0) {
          ctx.strokeStyle = p.color; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
        } else if (p.kind === 3) {
          const tx = p.x - p.vx * 0.12, ty = p.y - p.vy * 0.12;
          const grad = ctx.createLinearGradient(p.x, p.y, tx, ty);
          grad.addColorStop(0, p.color); grad.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.strokeStyle = grad; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(tx, ty); ctx.stroke(); ctx.lineCap = 'butt';
          ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2); ctx.fill();
        } else if (p.kind === 4) { // impact flash, squashed to lie flat on the ground
          const t = p.life / p.max;
          ctx.globalAlpha = 1 - t;
          ctx.strokeStyle = '#ffe2b0'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.ellipse(p.x, p.y, 3 + t * 20, (3 + t * 20) / 2, 0, 0, Math.PI * 2); ctx.stroke();
          if (t < 0.25) { ctx.fillStyle = '#fff6e0'; ctx.beginPath(); ctx.arc(p.x, p.y, 5 * (1 - t * 4), 0, Math.PI * 2); ctx.fill(); }
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = 1 - p.life / p.max;
          ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.kind === 1 ? 2 : 1.6, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      // hover outline / build ghost on the diamond under the mouse
      if (ui.hover && !ui.dragging && Iso.inMap(ui.hover.c, ui.hover.r, COLS, ROWS)) {
        const { c, r } = ui.hover;
        if (ui.buildType) {
          const d = C.modules[ui.buildType];
          const ok = MT.Sim.canPlace(state, ui.buildType, c, r).ok;
          const f = footprint(c, r, d.w, d.h, 0);
          poly(f); ctx.fillStyle = ok ? 'rgba(95,224,138,0.25)' : 'rgba(255,93,93,0.25)'; ctx.fill();
          ctx.strokeStyle = ok ? '#5fe08a' : '#ff5d5d'; ctx.lineWidth = 2; ctx.stroke();
          const p = P(c + d.w / 2, r + d.h / 2);
          ctx.font = '20px system-ui'; ctx.textAlign = 'center'; ctx.fillText(d.icon, p.x, p.y + 7);
        } else {
          const m = MT.Sim.moduleAt(state, c, r);
          ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5;
          poly(m ? footprint(m.c, m.r, m.w, m.h, 0) : footprint(c, r, 1, 1, 0)); ctx.stroke();
        }
      }

      // screen-space overlays
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      if (state.stormRate > C.rad.stormOn) { ctx.fillStyle = `rgba(255,40,40,${Math.min(0.14, state.stormRate * 0.01)})`; ctx.fillRect(0, 0, VW, VH); }
      if (state.meteorOn) { ctx.fillStyle = 'rgba(40,20,70,0.12)'; ctx.fillRect(0, 0, VW, VH); }
      drawBaseTag(hc, habM);
    }

    function reset() { ground = null; tagRect = null; zoom = 1; for (const p of pool) p.alive = false; }
    /** The astronaut drawn under the mouse (id), or null. Checks the body and the number tag above it. */
    function crewAt(evt) {
      const p = toCanvas(evt), wx = cam.x + p.x / zoom, wy = cam.y + p.y / zoom; // mouse → world pixels
      let best = null, bd = 12;
      for (const a of Object.values(crew)) {
        if (!a.shown || a.x == null) continue;
        const d = Math.min(Math.hypot(a.x - wx, a.y - 8 - wy), Math.hypot(a.x - wx, a.y - 24 - wy));
        if (d < bd) { bd = d; best = a.id; }
      }
      return best;
    }

    return {
      draw, tileAt, toCanvas, hitTag, crewAt, reset, centerOnBase, resize, setSafeArea, zoomAt,

      panStart: () => ({ x: cam.x, y: cam.y }),
      debug: () => ({ cam: { ...cam }, zoom, tag: tagRect, view: [VW, VH], world: [W, H] }),
      panTo: (x, y) => moveTo(x, y),
    };
  }

  MT.IsoRenderer = IsoRenderer;
})(window);
