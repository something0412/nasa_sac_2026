// Written with help from Claude Code (AI); reviewed and tested by the team.
// Isometric (2.5D) map drawing. Same job as render.js (and the same functions, so main.js can use
// either one), but the Moon is drawn as diamonds and buildings as little 3D blocks.
// Runs every frame (60 fps). Reads the sim state, never changes it.
//
// Two kinds of positions are used here:
//   grid  (c, r)  = the game's squares (can be fractions, e.g. the middle of a square is c + 0.5)
//   world (x, y)  = pixels on the big isometric picture (see js/iso.js). The camera shows part of it.
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const POOL_SIZE = 420;
  const SUIT_LINE = '#1b2230', VISOR = '#1ea5e9'; // astronaut outline and helmet visor (same as render.js)
  const METERS_PER_TILE = 10; // for the "base is 120 m away" tag

  // motion: shared astronaut positions (js/crew_motion.js), see render.js.
  function IsoRenderer(canvas, motion) {
    const ownMotion = !motion || typeof motion.update !== 'function';
    if (ownMotion) motion = LW.CrewMotion();
    const C = LW.CONFIG, Iso = LW.Iso;
    const COLS = C.map.cols, ROWS = C.map.rows;
    const HW = Iso.TILE_W / 2, HH = Iso.TILE_H / 2;
    // Terraces: hills step up and big craters step down (C.heightAt), STEP pixels per level. The world
    // picture gets TOP pixels of room above the map for the hills and some below it for the craters.
    const STEP = 14;
    const MAXH = Math.max(0, ...C.features.map((f) => f.height || 0)), MINH = Math.min(0, ...C.features.map((f) => f.height || 0));
    const TOP = MAXH * STEP;
    const WORLD = Iso.worldSize(COLS, ROWS), W = WORLD.w, H = WORLD.h + TOP - MINH * STEP;
    const hgt = new Int8Array(COLS * ROWS); // terrace level of every square
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) hgt[r * COLS + c] = C.heightAt(c, r);
    const PX_PER_TILE = Math.hypot(HW, HH); // rough screen size of one square, for speeds and lengths
    let VW = 800, VH = 560, DPR = 1; // screen size in CSS pixels
    // ZOOM: 1 = normal, 2 = everything twice as big. The camera then sees VW / zoom world pixels across.
    const ZOOM_MIN = 0.5, ZOOM_MAX = 2.5;
    let zoom = 1;
    const vw = () => VW / zoom, vh = () => VH / zoom; // how much of the world fits on screen
    const safe = { left: 0, right: 0, top: 0, bottom: 0 }; // screen edges covered by open panels
    const ctx = canvas.getContext('2d');

    let ground = null, zoneGrid = null, masks = null; // masks: where each zone shows on screen, for the terrain shadow
    let craters = [];
    let crew = {}; // astronaut id -> where they stand (grid squares) and where they were drawn (for clicks)
    const pool = [];
    for (let i = 0; i < POOL_SIZE; i++) pool.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, kind: 0, color: '' });
    let time = 0, dashOffset = 0, frac = 0;
    let lift = 0; // pixels the building being drawn is raised by its terrace (see drawModuleOnGround)
    let needCenter = true; // look at the base on the first frame of a game
    const cam = { x: 0, y: 0, tx: 0, ty: 0, flying: false };
    let tagRect = null;

    // ---------- grid ↔ world helpers ----------
    const P = (c, r) => { const p = Iso.toScreen(c, r, ROWS); p.y += TOP; return p; }; // grid point → world pixel (flat ground)
    const toGrid = (x, y) => Iso.toGrid(x, y - TOP, ROWS);   // world pixel → grid square on flat ground
    const mid = (m) => P(m.c + m.w / 2, m.r + m.h / 2);       // middle of a building's footprint
    // Terrace level of the square a grid point is in (outside the map = 0), and how many pixels that raises it.
    const levelAt = (c, r) => { c = Math.floor(c); r = Math.floor(r); return Iso.inMap(c, r, COLS, ROWS) ? hgt[r * COLS + c] : 0; };
    const liftAt = (c, r) => levelAt(c, r) * STEP;
    function liftOfRect(c, r, w, h) { // a building stands on the highest square under it
      let z = -Infinity;
      for (let dc = 0; dc < w; dc++) for (let dr = 0; dr < h; dr++) z = Math.max(z, liftAt(c + dc, r + dr));
      return z;
    }
    // Buildings never move and the terrain never changes, so each building's lift is worked out once and
    // remembered (here in the view, not in the game state, so saves are not affected).
    const liftCache = new WeakMap();
    const liftOf = (m) => {
      let z = liftCache.get(m);
      if (z === undefined) { z = liftOfRect(m.c, m.r, m.w, m.h); liftCache.set(m, z); }
      return z;
    };
    const up = (p, z) => ({ x: p.x, y: p.y - z });
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
    // A box standing on a footprint: left face, right face, then the lid `ht` pixels up. z0 lifts it off the ground.
    function prism(f, ht, top, left, right, edge, z0) {
      const z = z0 || 0;
      ctx.beginPath(); ctx.moveTo(f[3].x, f[3].y - z); ctx.lineTo(f[2].x, f[2].y - z); ctx.lineTo(f[2].x, f[2].y - z - ht); ctx.lineTo(f[3].x, f[3].y - z - ht); ctx.closePath();
      ctx.fillStyle = left; ctx.fill(); if (edge) { ctx.strokeStyle = edge; ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(f[2].x, f[2].y - z); ctx.lineTo(f[1].x, f[1].y - z); ctx.lineTo(f[1].x, f[1].y - z - ht); ctx.lineTo(f[2].x, f[2].y - z - ht); ctx.closePath();
      ctx.fillStyle = right; ctx.fill(); if (edge) ctx.stroke();
      poly(f, z + ht); ctx.fillStyle = top; ctx.fill(); if (edge) ctx.stroke();
    }
    // An upright cylinder standing at world point (x, y): side, then the round lid.
    function vcyl(x, y, rx, ht, side, top, edge) {
      const ry = rx * 0.5;
      ctx.beginPath(); ctx.moveTo(x - rx, y - ht); ctx.lineTo(x - rx, y); ctx.ellipse(x, y, rx, ry, 0, Math.PI, 0, true); ctx.lineTo(x + rx, y - ht); ctx.closePath();
      ctx.fillStyle = side; ctx.fill(); if (edge) { ctx.strokeStyle = edge; ctx.stroke(); }
      ctx.beginPath(); ctx.ellipse(x, y - ht, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = top; ctx.fill(); if (edge) ctx.stroke();
    }
    // A painted band around the front of an upright cylinder, between heights h1 < h2.
    function band(x, y, rx, h1, h2, color) {
      const ry = rx * 0.5;
      ctx.beginPath(); ctx.ellipse(x, y - h1, rx, ry, 0, 0, Math.PI); ctx.lineTo(x - rx, y - h2); ctx.ellipse(x, y - h2, rx, ry, 0, Math.PI, 0, true); ctx.closePath();
      ctx.fillStyle = color; ctx.fill();
    }
    // Points on an upright circle (or oval) across grid axis `ax` ('c' or 'r'), centred on grid point (c, r) at
    // height z: g = half-width in squares, R = height in pixels, angles t0..t1 (0 and PI are on the ground side).
    // Used for round tubes: the outline of a tube is the hull of the points of its two ends.
    function ring(c, r, z, ax, g, R, t0, t1, n) {
      const out = [];
      for (let i = 0; i <= n; i++) {
        const t = t0 + ((t1 - t0) * i) / n, k = Math.cos(t) * g;
        const p = ax === 'c' ? P(c, r + k) : P(c + k, r);
        out.push([p.x, p.y - z - Math.sin(t) * R]);
      }
      return out;
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
    /** Look at a grid point (c, r can be fractions). */
    function centerOnTile(c, r, smooth) { const p = up(P(c, r), liftAt(c, r)); centerOn(p.x, p.y, smooth); }
    /** Where a grid point is on the screen right now (pixels from the map's top-left corner). */
    function screenOf(c, r) { const p = up(P(c, r), liftAt(c, r)); return { x: (p.x - cam.x) * zoom, y: (p.y - cam.y) * zoom }; }
    function centerOnBase(state, smooth) {
      const hab = state.modules.find((m) => m.type === 'hab');
      const p = up(mid(hab), liftOf(hab));
      centerOn(p.x, p.y, smooth);
    }

    // Mouse → canvas pixels → world pixels → grid square (the diamond under the mouse).
    function toCanvas(evt) {
      const rect = canvas.getBoundingClientRect();
      return { x: ((evt.clientX - rect.left) / rect.width) * VW, y: ((evt.clientY - rect.top) / rect.height) * VH, px: evt.clientX - rect.left, py: evt.clientY - rect.top, scale: VW / rect.width / zoom }; // scale: mouse pixels → world pixels (for dragging)
    }
    // With terraces, a square's block covers the squares behind it. Look down through the levels: every
    // square whose block reaches the mouse is a hit, and the one nearest the front (biggest c + r) wins.
    function tileAt(evt) {
      const p = toCanvas(evt), wx = cam.x + p.x / zoom, wy = cam.y + p.y / zoom;
      let best = null;
      for (let L = MAXH; L >= MINH; L -= 0.25) {
        const g = toGrid(wx, wy + L * STEP);
        if (!Iso.inMap(g.c, g.r, COLS, ROWS) || levelAt(g.c, g.r) < L) continue;
        if (!best || g.c + g.r > best.c + best.r) best = g;
      }
      const g = best || toGrid(wx, wy);
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
    // The ground picture is painted step by step: groundSteps pauses (yield) after each small piece of work,
    // so prepareStep can paint it a few milliseconds at a time in idle time without freezing the game.
    // The finished picture is exactly the same as painting it in one go (buildGround).
    let painting = null; // a ground painting in progress (see prepareStep)
    function buildGround(state) {
      if (!painting) painting = groundSteps(state);
      while (!painting.next().done) { /* finish the rest now */ }
      painting = null;
    }
    /** Paint the ground for at most budgetMs. Returns true when the picture is finished. */
    function prepareStep(state, budgetMs) {
      if (ground) return true;
      if (!state) return false;
      if (!painting) painting = groundSteps(state);
      const end = performance.now() + budgetMs;
      do { if (painting.next().done) { painting = null; return true; } } while (performance.now() < end);
      return false;
    }
    function* groundSteps(state) {
      zoneGrid = new Uint8Array(COLS * ROWS);
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) zoneGrid[r * COLS + c] = ZONE_IDS[LW.Sim.zoneOf(state, c, r)];
      yield;

      // 1) A flat "texture" of the Moon: zone colours, dust, small craters and ice sparkles, as if it were flat.
      const tex = document.createElement('canvas');
      tex.width = W; tex.height = H;
      const g = tex.getContext('2d');
      yield; // (making a picture this big takes a moment by itself)
      let seed = 1234;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const diamond = (path, c, r) => {
        const a = P(c, r), b = P(c + 1, r), d = P(c + 1, r + 1), e = P(c, r + 1);
        path.moveTo(a.x, a.y); path.lineTo(b.x, b.y); path.lineTo(d.x, d.y); path.lineTo(e.x, e.y); path.closePath();
      };
      // The whole map is one big diamond (its outer edge); only the ice squares need their own outline
      // (it keeps the ice sparkles on the ice). Outlining all 4480 squares one by one was slow.
      const all = new Path2D();
      { const a = P(0, 0), b = P(COLS, 0), d = P(COLS, ROWS), e = P(0, ROWS); all.moveTo(a.x, a.y); all.lineTo(b.x, b.y); all.lineTo(d.x, d.y); all.lineTo(e.x, e.y); all.closePath(); }
      const paths = { ice: new Path2D() };
      for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (zoneAt(c, r) === 'ice') diamond(paths.ice, c, r);
      yield;
      // Plain is most of the Moon: one quick rectangle (only the squares are used later, so the corners don't matter).
      g.fillStyle = C.zones.plain.color; g.fillRect(0, 0, W, H);
      yield;
      // Hills and ice craters on top, a band of 7 rows at a time (one big fill would freeze the game for a moment).
      for (const z of ['ridge', 'ice']) {
        for (let r0 = 0; r0 < ROWS; r0 += 7) {
          const band = new Path2D();
          let any = false;
          for (let r = r0; r < Math.min(ROWS, r0 + 7); r++) for (let c = 0; c < COLS; c++) if (zoneAt(c, r) === z) { diamond(band, c, r); any = true; }
          if (any) { g.fillStyle = C.zones[z].color; g.fill(band); g.strokeStyle = C.zones[z].color; g.lineWidth = 1; g.stroke(band); }
          yield;
        }
      }

      // Dust speckles and craters, only on the Moon (not in the empty corners of the picture).
      g.save(); g.clip(all);
      const area = (COLS * ROWS) / (20 * 14);
      for (let i = 0; i < 1300 * area; i++) {
        const p = P(rand() * COLS, rand() * ROWS), s = rand() * 2 + 0.5;
        g.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
        g.fillRect(p.x, p.y, s, s);
        if (i % 3000 === 2999) yield;
      }
      yield;
      const base = document.createElement('canvas'); // the ground before craters (see drawCrater in render.js)
      base.width = W; base.height = H; base.getContext('2d').drawImage(tex, 0, 0);
      craters = [];
      for (let i = 0; i < 23 * area; i++) { const p = P(rand() * COLS, rand() * ROWS); craters.push({ x: p.x, y: p.y, r: (4 + rand() ** 2 * 30) * 1.25 }); }
      craters.sort((a, b) => b.r - a.r); // big (old) craters first, so small ones land on top of them
      for (let i = 0; i < craters.length; i++) { // same crater as render.js, squashed flat
        const k = craters[i];
        LW.drawCrater(g, k.x, k.y, k.r, 0.5, base);
        if (i % 20 === 19) yield;
      }
      base.width = 0; // free the copy's memory now
      g.restore();
      g.save(); g.clip(paths.ice);
      for (let i = 0; i < 260 * area; i++) {
        const p = P(rand() * COLS, rand() * ROWS);
        g.fillStyle = `rgba(170,210,255,${0.15 + rand() * 0.35})`;
        g.fillRect(p.x, p.y, 1.5, 1.5);
      }
      g.restore();

      // 2) The real ground: every square from the back of the map to the front, its piece of the texture
      //    raised (hill) or sunk (crater) to its terrace level, with block walls down to any lower square in
      //    front of it. Squares drawn later are nearer, so they cover the ones behind.
      const out = document.createElement('canvas');
      out.width = W; out.height = H;
      const o = out.getContext('2d');
      // Terrain-shadow masks (see draw): each zone's visible ground, half size to save memory.
      masks = {};
      for (const z of ZONE_NAMES) {
        const m = document.createElement('canvas');
        m.width = Math.ceil(W / 2); m.height = Math.ceil(H / 2);
        const mc = m.getContext('2d'); mc.scale(0.5, 0.5); mc.fillStyle = z === 'ice' ? 'rgb(5,8,25)' : 'rgb(5,8,20)';
        masks[z] = { canvas: m, ctx: mc };
      }
      const darken = (hex, k) => { const n = parseInt(hex.slice(1), 16); return rgb([(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v * k)); };
      const wallL = {}, wallR = {}; // left walls face away from the light more, so they are darker
      for (const z of ZONE_NAMES) { wallL[z] = darken(C.zones[z].color, 0.55); wallR[z] = darken(C.zones[z].color, 0.75); }
      for (let s = 0; s <= COLS + ROWS - 2; s++) {
        yield; // one diagonal row of squares at a time
        for (let c = Math.max(0, s - ROWS + 1); c <= Math.min(COLS - 1, s); c++) {
          const r = s - c, z = hgt[r * COLS + c] * STEP, zone = zoneAt(c, r);
          const t = P(c, r), L = P(c, r + 1), B = P(c + 1, r + 1), R = P(c + 1, r);
          // top: grown by a hair so neighbours overlap and no seams show
          const top = new Path2D();
          top.moveTo(t.x, t.y - z - 0.6); top.lineTo(R.x + 1.2, R.y - z); top.lineTo(B.x, B.y - z + 0.6); top.lineTo(L.x - 1.2, L.y - z); top.closePath();
          const sx = Math.max(0, L.x - 2), sy = Math.max(0, t.y - 1), sw = Math.min(W, R.x + 2) - sx, sh = Math.min(H, B.y + 1) - sy;
          o.save(); o.clip(top); o.drawImage(tex, sx, sy, sw, sh, sx, sy - z, sw, sh); o.restore();
          const shapes = [top]; // everything this square covers on screen (top + walls), for the masks
          // walls: the front-left edge (L→B) faces square (c, r + 1), the front-right edge (B→R) faces (c + 1, r)
          for (const [a, b, nz, col] of [[L, B, liftAt(c, r + 1), wallL[zone]], [B, R, liftAt(c + 1, r), wallR[zone]]]) {
            if (nz >= z) continue;
            const wall = new Path2D();
            wall.moveTo(a.x, a.y - z); wall.lineTo(b.x, b.y - z); wall.lineTo(b.x, b.y - nz); wall.lineTo(a.x, a.y - nz); wall.closePath();
            o.fillStyle = col; o.fill(wall);
            o.strokeStyle = 'rgba(0,0,0,0.2)'; o.lineWidth = 1; o.beginPath(); // a line between stacked blocks
            for (let k = z - STEP; k > nz; k -= STEP) { o.moveTo(a.x, a.y - k); o.lineTo(b.x, b.y - k); }
            o.stroke();
            o.strokeStyle = 'rgba(255,255,255,0.22)'; o.lineWidth = 1.5; // light edge along the top of the step
            o.beginPath(); o.moveTo(a.x, a.y - z); o.lineTo(b.x, b.y - z); o.stroke();
            shapes.push(wall);
          }
          // faint grid line around the top
          o.strokeStyle = 'rgba(255,255,255,0.045)'; o.lineWidth = 1;
          o.beginPath(); o.moveTo(t.x, t.y - z); o.lineTo(R.x, R.y - z); o.lineTo(B.x, B.y - z); o.lineTo(L.x, L.y - z); o.closePath(); o.stroke();
          // masks: this square's zone gets it; the other zones lose whatever it covers
          for (const zz of ZONE_NAMES) { const mc = masks[zz].ctx; mc.globalCompositeOperation = zz === zone ? 'source-over' : 'destination-out'; for (const sh of shapes) mc.fill(sh); }
        }
      }
      tex.width = 0; // free the texture's memory now

      o.font = 'bold 13px system-ui, sans-serif'; o.textAlign = 'center';
      for (const f of C.features) {
        const p = up(P(f.u * COLS, f.v * ROWS), liftAt(f.u * COLS, f.v * ROWS));
        o.fillStyle = f.zone === 'ice' ? 'rgba(170,210,255,0.75)' : 'rgba(255,255,255,0.6)';
        o.fillText(f.label, p.x, p.y);
      }
      ground = out;
      crew = {};
    }

    // ---------- particles (object pool, no new objects per frame) ----------
    function spawn(kind, x, y, vx, vy, life, color) {
      y -= lift; // a building on a hill draws raised, so its particles start raised too
      for (const p of pool) if (!p.alive) { p.alive = true; p.kind = kind; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.life = 0; p.max = life; p.color = color; return p; }
      return null;
    }

    // Direction the sunlight comes FROM, in grid squares (unit length). Smooth between game hours.
    const sunGrid = (state) => {
      const a = (LW.Sim.sunAz(state, state.hour + frac) * Math.PI) / 180;
      return { c: Math.cos(a), r: Math.sin(a) };
    };
    const lightAt = (state, m) => LW.Sim.zoneLight(state, LW.Sim.zoneOf(state, m.c, m.r), state.hour + frac);

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

    // How long each building's shadow is (squares, before the low-Sun stretch): taller things cast longer shadows.
    const SHADOW_LEN = { hab: 1.1, solar: 1.1, drill: 1.0, tower: 0.9, lab: 0.7, battery: 0.6, o2gen: 0.6 };
    // How tall each building is drawn (pixels). Used for the block, labels and status icons.
    const HEIGHT = { hab: 26, solar: 52, battery: 28, o2gen: 26, greenhouse: 16, drill: 48, shelter: 18, gym: 26, tower: 36, lab: 34, pad: 3 };

    // ---------- buildings ----------
    // Buildings are drawn as if on flat ground, moved up (or down into a crater) to their terrace.
    function drawModuleOnGround(state, m, blink) {
      lift = liftOf(m);
      ctx.save(); ctx.translate(0, -lift);
      drawModule(state, m, blink);
      ctx.restore();
      lift = 0;
    }
    function drawModule(state, m, blink) {
      const on = m.built && m.on && m.powered;
      const ctr = mid(m), ht = HEIGHT[m.type] || 16;
      ctx.save();
      if (!m.built) ctx.globalAlpha = 0.45;
      ctx.lineWidth = 1;
      switch (m.type) {
        case 'hab': {
          const BM = m.berm || { built: false, building: false }; // each HAB has its own moon-dirt shield
          if (BM.built || BM.building) { // moon-dirt shield piled around the habitat
            const f = BM.built ? 1 : BM.progress / C.bermWork;
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
          const win = on ? ((m.temp != null ? m.temp : state.habTemp) < 15 ? '#7fb4ff' : '#ffd36b') : '#39404b';
          ctx.fillStyle = win;
          for (const t of [0.3, 0.7]) {
            const a = { x: f[3].x + (f[2].x - f[3].x) * t, y: f[3].y + (f[2].y - f[3].y) * t };
            const b = { x: f[2].x + (f[1].x - f[2].x) * t, y: f[2].y + (f[1].y - f[2].y) * t };
            ctx.fillRect(a.x - 3, a.y - 12, 6, 6); ctx.fillRect(b.x - 3, b.y - 12, 6, 6);
          }
          ctx.fillStyle = '#5b6576'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
          ctx.fillText(LW.Sim.habs(state).length > 1 && m.built ? LW.Sim.habName(state, m) : 'HAB', ctr.x, ctr.y - ht + 2);
          break;
        }
        case 'solar': {
          // Tall panel on a mast (like NASA's VSAT arrays). It turns to face the Sun, which is always low at the pole.
          const L = lightAt(state, m), s = sunGrid(state);
          ctx.strokeStyle = '#7f8896'; ctx.lineWidth = 2;
          for (const [dc, dr] of [[-0.3, -0.3], [0.32, 0.02], [0.02, 0.32]]) { // tripod
            const f = P(m.c + 0.5 + dc, m.r + 0.5 + dr); ctx.beginPath(); ctx.moveTo(ctr.x, ctr.y - 9); ctx.lineTo(f.x, f.y); ctx.stroke();
          }
          ctx.fillStyle = '#c4cad4'; ctx.fillRect(ctr.x - 1.6, ctr.y - 50, 3.2, 50); // mast
          ctx.fillStyle = '#596273'; ctx.fillRect(ctr.x - 3, ctr.y - 17, 6, 4); // gimbal (turns the panel)
          const half = gridDir(-s.r * 0.44, s.c * 0.44), lo = 17, hi = 47; // half the panel width, sideways to the Sun
          const a = { x: ctr.x - half.x, y: ctr.y - half.y }, b = { x: ctr.x + half.x, y: ctr.y + half.y };
          const facing = gridDir(s.c, s.r).y > 0; // we see the sunny side when the Sun is "in front"
          ctx.beginPath(); ctx.moveTo(a.x, a.y - lo); ctx.lineTo(b.x, b.y - lo); ctx.lineTo(b.x, b.y - hi); ctx.lineTo(a.x, a.y - hi); ctx.closePath();
          ctx.fillStyle = facing ? rgb(mix([29, 44, 72], [47, 111, 214], L)) : '#5a6170'; ctx.fill();
          ctx.lineWidth = 1.5; ctx.strokeStyle = facing ? '#dfe5ec' : '#8f96a3'; ctx.stroke(); // white frame
          if (facing) {
            ctx.lineWidth = 0.8; ctx.strokeStyle = rgb(mix([58, 74, 102], [140, 180, 245], L)); ctx.beginPath(); // cells: 4 x 3
            for (let i = 1; i < 4; i++) { const t = i / 4, px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t; ctx.moveTo(px, py - lo); ctx.lineTo(px, py - hi); }
            for (const z of [lo + (hi - lo) / 3, lo + (2 * (hi - lo)) / 3]) { ctx.moveTo(a.x, a.y - z); ctx.lineTo(b.x, b.y - z); }
            ctx.stroke();
            if (L > 0.3 && m.built && m.on) {
              ctx.fillStyle = `rgba(255,255,255,${(0.25 + 0.2 * Math.sin(time * 3 + m.id)) * L})`;
              ctx.beginPath(); ctx.moveTo(a.x, a.y - hi); ctx.lineTo(a.x + (b.x - a.x) * 0.22, a.y + (b.y - a.y) * 0.22 - hi); ctx.lineTo(a.x, a.y - hi + 12); ctx.closePath(); ctx.fill();
            }
          } else { ctx.fillStyle = '#c4cad4'; ctx.fillRect(ctr.x - 1.6, ctr.y - hi, 3.2, hi - lo); } // mast in front of the panel's back
          ctx.fillStyle = '#dfe5ec'; ctx.fillRect(ctr.x - 2, ctr.y - 52, 4, 3); // mast tip
          break;
        }
        case 'battery': {
          // Dark battery box on a skid, two white heat radiators on top, 4 charge lights on the left wall.
          const cap = LW.Sim.batteryCap(state) || 1;
          const fr = Math.max(0, Math.min(1, state.res.battery / cap));
          prism(footprint(m.c, m.r, 1, 1, 0.15), 3, '#596273', '#3f4652', '#4b5361', '#6f7888');
          const f = footprint(m.c, m.r, 1, 1, 0.25), z0 = 3, bh = 14;
          prism(f, bh, '#3a414d', '#22272f', '#2a2f38', '#8a93a3', z0);
          const lit = m.built ? Math.ceil(fr * 4 - 0.01) : 0, col = LW.Shapes.chargeColor(fr);
          const e = (t) => ({ x: f[3].x + (f[2].x - f[3].x) * t, y: f[3].y + (f[2].y - f[3].y) * t });
          for (let i = 0; i < 4; i++) {
            const p0 = e(0.14 + i * 0.19), p1 = e(0.28 + i * 0.19);
            ctx.beginPath(); ctx.moveTo(p0.x, p0.y - z0 - 4); ctx.lineTo(p1.x, p1.y - z0 - 4); ctx.lineTo(p1.x, p1.y - z0 - 8); ctx.lineTo(p0.x, p0.y - z0 - 8); ctx.closePath();
            ctx.fillStyle = i < lit ? col : '#3a414d'; ctx.fill();
          }
          LW.Shapes.bolt(ctx, (f[2].x + f[1].x) / 2, (f[2].y + f[1].y) / 2 - z0 - bh / 2, 1.1, '#ffd36b');
          ctx.lineWidth = 1;
          for (const c of [0.4, 0.6]) { // radiator fins
            const p0 = P(m.c + c, m.r + 0.3), p1 = P(m.c + c, m.r + 0.7), z = z0 + bh, up = 11;
            ctx.beginPath(); ctx.moveTo(p0.x, p0.y - z); ctx.lineTo(p1.x, p1.y - z); ctx.lineTo(p1.x, p1.y - z - up); ctx.lineTo(p0.x, p0.y - z - up); ctx.closePath();
            ctx.fillStyle = '#e9edf2'; ctx.fill(); ctx.strokeStyle = '#9aa2af'; ctx.stroke();
          }
          break;
        }
        case 'o2gen': {
          // Water splitter (like the ISS oxygen generator) + round O2 tank on legs. Blue pipe/band = water coming in.
          const wet = on && !m.noWater;
          prism(footprint(m.c, m.r, 1, 1, 0.13), 3, '#596273', '#3f4652', '#4b5361', '#6f7888');
          const cy = P(m.c + 0.36, m.r + 0.62), tk = P(m.c + 0.72, m.r + 0.3);
          const e = P(m.c + 0.12, m.r + 0.92); ctx.strokeStyle = wet ? '#58c4ff' : '#59636f'; ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.moveTo(e.x, e.y - 3); ctx.lineTo(cy.x - 4, cy.y - 5); ctx.stroke();
          ctx.strokeStyle = '#7f8b99'; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(tk.x - 4, tk.y - 3); ctx.lineTo(tk.x - 3, tk.y - 12); ctx.moveTo(tk.x + 4, tk.y - 3); ctx.lineTo(tk.x + 3, tk.y - 12); ctx.stroke();
          ctx.beginPath(); ctx.arc(tk.x, tk.y - 17, 8, 0, Math.PI * 2); ctx.fillStyle = '#f2f4f7'; ctx.fill(); ctx.strokeStyle = '#7f8b99'; ctx.lineWidth = 1; ctx.stroke();
          ctx.beginPath(); ctx.arc(tk.x - 2.5, tk.y - 20, 2.4, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
          ctx.fillStyle = wet ? '#2f8fd0' : '#59636f'; ctx.font = 'bold 7px system-ui'; ctx.textAlign = 'center'; ctx.fillText('O₂', tk.x, tk.y - 14.5);
          ctx.strokeStyle = '#9aa2af'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cy.x + 4, cy.y - 20); ctx.lineTo(tk.x - 6, tk.y - 22); ctx.stroke(); // gas pipe
          ctx.lineWidth = 1;
          vcyl(cy.x, cy.y - 3, 8, 21, '#d6dee8', '#eef1f5', '#7f8b99');
          band(cy.x, cy.y - 3, 8, 13, 16.5, wet ? '#58c4ff' : '#59636f');
          ctx.fillStyle = '#9aa2af'; ctx.beginPath(); ctx.ellipse(cy.x, cy.y - 24, 3.5, 1.75, 0, 0, Math.PI * 2); ctx.fill(); // vent
          if (wet && Math.random() < 0.15) spawn(2, cy.x + (Math.random() - 0.5) * 5, cy.y - 26, 0, -12, 1.2, '#9fe0ff');
          break;
        }
        case 'greenhouse': {
          // Inflatable tunnel with rounded ends (the same outline as the top-down view) and pink-purple grow lights.
          // Built from upright half-ovals along the c axis: full size in the middle, shrinking to a point at each end.
          const g = 0.275, R = 13, rr = m.r + 0.5, s0 = m.c + 0.35, s1 = m.c + 0.65;
          const secs = [];
          for (const d of [1, 0.9, 0.7, 0.4]) secs.push([s0 - g * d, Math.sqrt(1 - d * d)]);
          secs.push([s0, 1], [s1, 1]);
          for (const d of [0.4, 0.7, 0.9, 1]) secs.push([s1 + g * d, Math.sqrt(1 - d * d)]);
          const shell = [], floor = [];
          for (const [c, k] of secs) { const pts = ring(c, rr, 0, 'c', g * k, R * k, 0, Math.PI, 8); shell.push(...pts); floor.push(pts[0], pts[pts.length - 1]); }
          LW.Shapes.pathOf(ctx, hull(floor)); ctx.fillStyle = '#3a3f46'; ctx.fill();
          for (const dr of [-0.12, 0.12]) for (const c of [0.3, 0.43, 0.57, 0.7]) { // plants
            const p = P(m.c + c, rr + dr);
            ctx.fillStyle = on ? '#4fdc6a' : '#3c6b45';
            ctx.beginPath(); ctx.ellipse(p.x, p.y - 3.2, on ? 3 + Math.sin(time * 2 + c * 7 + dr) * 0.3 : 2.3, on ? 3.8 : 2.8, 0, 0, Math.PI * 2); ctx.fill();
          }
          LW.Shapes.pathOf(ctx, hull(shell));
          ctx.fillStyle = on ? 'rgba(255,120,220,0.2)' : 'rgba(80,90,100,0.32)'; ctx.fill();
          ctx.strokeStyle = on ? '#ff9de8' : '#6b7480'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.lineWidth = 1; ctx.strokeStyle = on ? 'rgba(255,170,235,0.75)' : 'rgba(140,150,160,0.6)';
          for (const c of [s0, m.c + 0.5, s1]) { // ribs
            const p = ring(c, rr, 0, 'c', g, R, 0, Math.PI, 8);
            ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]); for (const q of p) ctx.lineTo(q[0], q[1]); ctx.stroke();
          }
          const d = P(m.c + 0.9, rr); // airlock door on the front end
          ctx.fillStyle = '#aeb5c1'; ctx.beginPath(); ctx.roundRect(d.x - 3.5, d.y - 8, 7, 8, [3, 3, 0, 0]); ctx.fill(); ctx.strokeStyle = '#6f7888'; ctx.stroke();
          break;
        }
        case 'drill': {
          // Tracked drill rig (like the TRIDENT ice drill): braced mast on the right-hand side, drill head sliding up
          // and down while it runs, auger into a hole with ice chips, small blue tank for the melted ice.
          prism(footprint(m.c, m.r, 1, 1, 0.16), 4, '#3a3f46', '#272b31', '#30343b', '#555c67'); // tracks
          prism(footprint(m.c, m.r, 1, 1, 0.22), 7, '#e0b860', '#b8913f', '#c9a14d', '#8a6d2c', 4); // body
          const tank = P(m.c + 0.36, m.r + 0.4);
          vcyl(tank.x, tank.y - 11, 5.5, 8, '#3f8fd0', '#7fc4ff', '#2b5f8a');
          const r0 = P(m.c + 0.86, m.r + 0.3), r1 = P(m.c + 0.86, m.r + 0.62), top = 46;
          const hole = P(m.c + 0.98, m.r + 0.46);
          ctx.fillStyle = 'rgba(205,228,255,0.85)'; ctx.beginPath(); ctx.ellipse(hole.x + 2, hole.y + 1, 9, 4.2, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#141a26'; ctx.beginPath(); ctx.ellipse(hole.x, hole.y, 3.5, 1.7, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#e0b860'; ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.moveTo(r0.x, r0.y - 3); ctx.lineTo(r0.x, r0.y - top); ctx.moveTo(r1.x, r1.y - 3); ctx.lineTo(r1.x, r1.y - top); ctx.stroke();
          ctx.lineWidth = 1; ctx.strokeStyle = '#8a6d2c'; ctx.beginPath(); // zig-zag bracing
          for (let z = 8, k = 0; z < top - 4; z += 7, k++) { const A = k % 2 ? r0 : r1, B = k % 2 ? r1 : r0; ctx.moveTo(A.x, A.y - z); ctx.lineTo(B.x, B.y - z - 7); }
          ctx.stroke();
          ctx.fillStyle = '#dfe5ec'; ctx.beginPath(); ctx.moveTo(r0.x - 2, r0.y - top - 1); ctx.lineTo(r1.x + 2, r1.y - top - 1); ctx.lineTo(r1.x + 2, r1.y - top - 4); ctx.lineTo(r0.x - 2, r0.y - top - 4); ctx.closePath(); ctx.fill(); // crown
          const hm = { x: (r0.x + r1.x) / 2 + 3, y: (r0.y + r1.y) / 2 + 1.5 };
          const hz = on ? 24 + Math.sin(time * 1.6 + m.id) * 8 : 32;
          ctx.strokeStyle = '#c9d3df'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(hm.x, hm.y - hz); ctx.lineTo(hole.x, hole.y); ctx.stroke(); // auger
          ctx.strokeStyle = '#7f8b99'; ctx.lineWidth = 1; ctx.beginPath();
          const spin = on ? (time * 6) % 1 : 0; // the auger's thread marks run down while it turns
          for (let i = 0; i < 3; i++) { const t = (i + 1 - spin) / 4, px = hm.x + (hole.x - hm.x) * t, py = hm.y - hz + (hole.y - (hm.y - hz)) * t; ctx.moveTo(px - 2.5, py + 1.5); ctx.lineTo(px + 2.5, py - 1.5); }
          ctx.stroke();
          ctx.fillStyle = '#4b5361'; ctx.fillRect(hm.x - 5, hm.y - hz - 7, 10, 8); ctx.strokeStyle = '#1b1f27'; ctx.strokeRect(hm.x - 5, hm.y - hz - 7, 10, 8);
          ctx.fillStyle = on ? '#5fe08a' : '#59636f'; ctx.fillRect(hm.x + 0.5, hm.y - hz - 5, 2.5, 2.5);
          if (on && Math.random() < 0.25) spawn(1, hole.x, hole.y, (Math.random() - 0.5) * 30, -Math.random() * 15, 0.9, 'rgba(190,220,255,0.8)');
          break;
        }
        case 'shelter': {
          // Bunker under piled moon dirt and regolith bags, entered through a short tunnel; radiation sign on top.
          const sc = P(m.c + 0.5, m.r + 0.45), sh = 18;
          ctx.beginPath(); ctx.ellipse(sc.x, sc.y, HW * 0.8, HH * 0.8, 0, 0, Math.PI); ctx.ellipse(sc.x, sc.y, HW * 0.8, sh + HH * 0.2, 0, Math.PI, 0);
          ctx.fillStyle = '#8a7558'; ctx.fill(); ctx.strokeStyle = '#b39a77'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.lineWidth = 0.8;
          for (const [row, n, y0, rx] of [[0, 6, 1, 0.78], [1, 5, -5, 0.66]]) for (let i = 0; i < n; i++) { // two rows of bags
            const t = Math.PI * (0.12 + (0.76 * (i + 0.5)) / n), bx = sc.x - Math.cos(t) * HW * rx, by = sc.y + Math.sin(t) * HH * rx * 0.9 + y0 - row * 2;
            ctx.fillStyle = row ? '#a3896a' : '#9a8061'; ctx.beginPath(); ctx.ellipse(bx, by - 2, 4.6, 2.6, 0, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#6f5c43'; ctx.stroke();
          }
          ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.ellipse(sc.x - 2, sc.y - sh * 0.6, HW * 0.5, sh * 0.45, 0, Math.PI * 1.15, Math.PI * 1.6); ctx.stroke();
          LW.Shapes.trefoil(ctx, sc.x + 9, sc.y - sh + 1, 3.6);
          const t0 = ring(m.c + 0.42, m.r + 0.62, 6, 'r', 6 / 28, 6, 0, Math.PI * 2, 12), t1 = ring(m.c + 0.42, m.r + 0.98, 6, 'r', 6 / 28, 6, 0, Math.PI * 2, 12);
          LW.Shapes.pathOf(ctx, hull(t0.concat(t1))); ctx.fillStyle = '#aeb5c1'; ctx.fill(); ctx.strokeStyle = '#6f7888'; ctx.stroke(); // tunnel
          LW.Shapes.pathOf(ctx, t1); ctx.fillStyle = '#c4cad4'; ctx.fill(); ctx.stroke();
          const hp = P(m.c + 0.42, m.r + 0.98); ctx.fillStyle = '#2b2b2b'; ctx.beginPath(); ctx.ellipse(hp.x, hp.y - 6, 3, 3.6, 0.45, 0, Math.PI * 2); ctx.fill(); // hatch
          if (state.sheltering) { ctx.fillStyle = '#7dff9a'; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'; ctx.fillText('CREW', sc.x, sc.y - sh - 8); }
          break;
        }
        case 'gym': {
          // Pressurized module lying on two cradles; the window band lights up and the dumbbell turns orange while
          // someone trains.
          const training = state.crew.some((a) => a.where === 'gym' && a.gymId === m.id);
          const R = 10.5, z = 14, cc = m.c + 0.5, g = R / 28;
          for (const r of [0.28, 0.72]) prism(footprint(m.c + 0.3, m.r + r - 0.07, 0.4, 0.14, 0), 6, '#4b5361', '#30353f', '#3a414d', '#596273');
          const a = ring(cc, m.r + 0.1, z, 'r', g, R, 0, Math.PI * 2, 14), b = ring(cc, m.r + 0.9, z, 'r', g, R, 0, Math.PI * 2, 14);
          LW.Shapes.pathOf(ctx, hull(a.concat(b))); ctx.fillStyle = '#d9dde4'; ctx.fill(); ctx.strokeStyle = '#8f96a3'; ctx.lineWidth = 1; ctx.stroke();
          const along = (t, w) => { const p = ring(cc, m.r + 0.16, z, 'r', g, R, t, t, 1)[0], q = ring(cc, m.r + 0.84, z, 'r', g, R, t, t, 1)[0]; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); };
          ctx.strokeStyle = on && !m.damaged ? '#7fb4ff' : '#59636f'; along(Math.PI * 0.55, 3); // roof stripe
          ctx.strokeStyle = training ? '#ffd36b' : '#26303f'; along(Math.PI * 0.12, 3.5); // window band
          LW.Shapes.pathOf(ctx, b); ctx.fillStyle = '#eef1f5'; ctx.fill(); ctx.strokeStyle = '#8f96a3'; ctx.lineWidth = 1; ctx.stroke(); // near end
          const e = P(cc, m.r + 0.9), lift = training ? Math.abs(Math.sin(time * 4)) * 1.5 : 0;
          LW.Shapes.dumbbell(ctx, e.x, e.y - z - lift, 0.85, training ? '#ffb35c' : '#7fb4ff');
          break;
        }
        case 'tower': {
          // Small observatory: round drum with a door, white dome with an open slit, telescope that sweeps the sky.
          vcyl(ctr.x, ctr.y, 12.5, 17, '#4b5361', '#5b6371', '#6f7888');
          ctx.fillStyle = '#2b313c'; ctx.beginPath(); ctx.roundRect(ctr.x - 3.5, ctr.y - 11, 7, 11, [3.5, 3.5, 0, 0]); ctx.fill(); // door
          ctx.fillStyle = '#ffd36b'; ctx.fillRect(ctr.x - 1, ctr.y - 14.5, 2, 2);
          const dy = ctr.y - 17, sweep = m.built ? Math.sin(time * 0.6 + m.id) * 0.5 : 0;
          ctx.save();
          ctx.beginPath(); ctx.ellipse(ctr.x, dy, 13.5, 6.75, 0, 0, Math.PI); ctx.ellipse(ctr.x, dy, 13.5, 14, 0, Math.PI, 0);
          ctx.fillStyle = '#e4e8ee'; ctx.fill(); ctx.strokeStyle = '#9aa2af'; ctx.lineWidth = 1; ctx.stroke();
          ctx.clip();
          ctx.translate(ctr.x, dy + 2); ctx.rotate(sweep);
          ctx.fillStyle = '#1b2230'; ctx.fillRect(-3, -18, 6, 18); // open slit
          ctx.restore();
          ctx.save(); ctx.translate(ctr.x, dy + 2); ctx.rotate(sweep);
          ctx.fillStyle = '#f2f4f7'; ctx.fillRect(-2, -20, 4, 10); ctx.fillStyle = '#ffd36b'; ctx.fillRect(-2, -21, 4, 2.5); // telescope
          ctx.restore();
          if (m.built && blink && !LW.Sim.towerReadyIn(state, m)) { ctx.fillStyle = '#7fb4ff'; ctx.beginPath(); ctx.arc(ctr.x + 10, ctr.y - 6, 2.2, 0, Math.PI * 2); ctx.fill(); } // ready to use
          break;
        }
        case 'pad': {
          // Landing Pad of baked moon dirt: blast berm on the side facing the nearest HAB, scorch mark, target ring,
          // beacons on posts (blinking green = ready for a spaceship).
          const ready = m.built && LW.Sim.landingSpots(state).some((sp) => sp.pad === m);
          const pc = { c: m.c + 1, r: m.r + 1 }, E = (R) => [R * Math.SQRT2 * HW, R * Math.SQRT2 * HH];
          const H = LW.Sim.habs(state).reduce((b, h) => { const d = Math.hypot(h.c + 1 - pc.c, h.r + 1 - pc.r); return !b || d < b.d ? { h, d } : b; }, null);
          const dc = H ? H.h.c + 1 - pc.c : 0, dr = H ? H.h.r + 1 - pc.r : -1;
          const face = Math.atan2(dc + dr, dc - dr); // grid direction → angle on the squashed (iso) circle
          const berm = () => {
            const [bx, by] = E(1.0);
            ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y, bx, by, 0, face - Math.PI * 0.42, face + Math.PI * 0.42); ctx.strokeStyle = '#6f5c43'; ctx.lineWidth = 9; ctx.stroke();
            ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y - 3, bx, by, 0, face - Math.PI * 0.4, face + Math.PI * 0.4); ctx.strokeStyle = '#8a7558'; ctx.lineWidth = 6; ctx.stroke();
          };
          const behind = Math.sin(face) < 0; // the berm is on the far side: draw it first
          if (behind) berm();
          let [rx, ry] = E(0.86);
          ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = '#45474d'; ctx.fill(); // slab edge
          ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y - 3, rx, ry, 0, 0, Math.PI * 2); ctx.fillStyle = '#5d5f66'; ctx.fill(); ctx.strokeStyle = '#9aa2af'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.fillStyle = 'rgba(20,20,26,0.28)';
          for (const R of [0.5, 0.3]) { [rx, ry] = E(R); ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y - 3, rx, ry, 0, 0, Math.PI * 2); ctx.fill(); } // scorch
          [rx, ry] = E(0.7); ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y - 3, rx, ry, 0, 0, Math.PI * 2); ctx.setLineDash([6, 5]); ctx.strokeStyle = '#d9dde4'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]);
          [rx, ry] = E(0.36); ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y - 3, rx, ry, 0, 0, Math.PI * 2); ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2.5; ctx.stroke();
          ctx.beginPath(); // target ticks along the grid axes
          for (const [tc, tr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const p = P(pc.c + tc * 0.42, pc.r + tr * 0.42), q = P(pc.c + tc * 0.6, pc.r + tr * 0.6); ctx.moveTo(p.x, p.y - 3); ctx.lineTo(q.x, q.y - 3); }
          ctx.stroke();
          ctx.fillStyle = '#ffd36b'; ctx.beginPath(); ctx.ellipse(ctr.x, ctr.y - 3, 2.5, 1.25, 0, 0, Math.PI * 2); ctx.fill();
          for (const [bc, br] of [[-0.62, -0.62], [0.62, -0.62], [-0.62, 0.62], [0.62, 0.62]]) { // beacons on short posts
            const p = P(pc.c + bc, pc.r + br);
            ctx.fillStyle = '#9aa2af'; ctx.fillRect(p.x - 1, p.y - 9, 2, 6);
            ctx.fillStyle = ready ? (blink ? '#5fe08a' : '#2e6b43') : '#59636f'; ctx.beginPath(); ctx.arc(p.x, p.y - 10, 2.6, 0, Math.PI * 2); ctx.fill();
          }
          if (!behind) berm();
          ctx.lineWidth = 1;
          break;
        }
        case 'lab': {
          // Research Bay: lab block with a stepped roof, porthole and flask (cyan while the Scientist works),
          // dish antenna and a sensor mast.
          const busy = state.crew.some((a) => !a.medbay && a.task && a.task.kind === 'lab' && a.task.id === m.id);
          const f = footprint(m.c, m.r, 1, 1, 0.16), bh = 16;
          prism(f, bh, '#dfe5ec', '#aab4c1', '#c1c9d4', '#7f8b99');
          prism(footprint(m.c, m.r, 1, 1, 0.27), 3, '#eef1f5', '#c1c9d4', '#d3d9e1', '#9aa2af', bh);
          const lw = { x: f[3].x + (f[2].x - f[3].x) * 0.42, y: f[3].y + (f[2].y - f[3].y) * 0.42 - bh * 0.55 };
          ctx.fillStyle = busy ? '#6fd3ff' : '#26303f'; ctx.beginPath(); ctx.ellipse(lw.x, lw.y, 3.6, 4.2, 0, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#7f8b99'; ctx.lineWidth = 1.2; ctx.stroke();
          const rw = { x: (f[2].x + f[1].x) / 2, y: (f[2].y + f[1].y) / 2 - bh * 0.5 };
          LW.Shapes.flask(ctx, rw.x, rw.y, 1.25, busy ? '#6fd3ff' : '#6f7888');
          const d = P(m.c + 0.36, m.r + 0.34), dz = bh + 3;
          ctx.fillStyle = '#7f8b99'; ctx.fillRect(d.x - 1, d.y - dz - 6, 2, 6);
          ctx.save(); ctx.translate(d.x, d.y - dz - 9); ctx.rotate(-0.55); // dish antenna
          ctx.beginPath(); ctx.ellipse(0, 0, 7, 3.6, 0, 0, Math.PI * 2); ctx.fillStyle = '#f2f4f7'; ctx.fill(); ctx.strokeStyle = '#7f8b99'; ctx.lineWidth = 1; ctx.stroke();
          ctx.fillStyle = '#7f8b99'; ctx.beginPath(); ctx.arc(0, -3.5, 1.2, 0, Math.PI * 2); ctx.fill();
          ctx.restore();
          const sm = P(m.c + 0.72, m.r + 0.44); // sensor mast
          ctx.strokeStyle = '#9aa2af'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(sm.x, sm.y - dz); ctx.lineTo(sm.x, sm.y - dz - 14); ctx.moveTo(sm.x - 4, sm.y - dz - 11); ctx.lineTo(sm.x + 4, sm.y - dz - 11); ctx.stroke();
          ctx.fillStyle = '#ff5d5d'; ctx.beginPath(); ctx.arc(sm.x, sm.y - dz - 15, 1.6, 0, Math.PI * 2); ctx.fill();
          ctx.lineWidth = 1;
          if (busy && Math.random() < 0.12) spawn(2, rw.x + (Math.random() - 0.5) * 4, rw.y - 6, 0, -14, 1, '#bdf0ff');
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
      } else if (LW.Sim.needOf(state, m) > 0 && m.type !== 'solar' && !m.powered) {
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
        const b = LW.Sim.boostOf(state, m);
        if (b > 1) {
          const x = ctr.x - HW * 0.5, y = ctr.y - ht - 10;
          ctx.fillStyle = 'rgba(10,14,22,0.85)'; ctx.beginPath(); ctx.roundRect(x - 10, y - 8, 20, 11, 3); ctx.fill();
          ctx.fillStyle = '#6fd3ff'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText(b + 'x', x, y + 0.5);
        }
      }
      ctx.restore();
    }

    // Swing in a vertical plane along the grid's c axis, then project to the same 2:1 view as buildings.
    function drawBuildingHammer(a, m) {
      const cycle = (motion.workTime() * 1.4 + a.id * 0.17) % 1;
      const strikeAngle = 1;
      const lift = (1 - Math.sin(cycle * Math.PI)) * strikeAngle;
      const contactC = m.c + m.w - 0.12;
      const handleLength = 5, halfLength = 0.12, halfDepth = 0.05, halfHeight = 1.5;
      // The handle sits beneath the middle of the broad head and pivots from the astronaut's grip.
      const gripC = contactC + halfLength * Math.cos(strikeAngle) + (handleLength / HW) * Math.sin(strikeAngle);
      const gripZ = 6;
      const headC = gripC - (handleLength / HW) * Math.sin(lift);
      const headZ = gripZ + handleLength * Math.cos(lift);
      const shoulder = P(a.c, a.r), grip = P(gripC, a.r), socket = P(headC + (halfHeight / HW) * Math.sin(lift), a.r);
      shoulder.y -= 8; grip.y -= gripZ; socket.y -= headZ - halfHeight * Math.cos(lift);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#8c96a5'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(shoulder.x, shoulder.y); ctx.lineTo(grip.x, grip.y); ctx.stroke();
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.strokeStyle = '#725234'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(grip.x, grip.y); ctx.lineTo(socket.x, socket.y); ctx.stroke();
      ctx.strokeStyle = '#c59862'; ctx.lineWidth = 0.8; ctx.stroke();
      // The long axis points into the wall. Rotate the solid head in grid space before projection.
      const cos = Math.cos(lift), sin = Math.sin(lift);
      const corners = [[-halfLength, -halfDepth], [halfLength, -halfDepth], [halfLength, halfDepth], [-halfLength, halfDepth]];
      const layer = (height) => corners.map(([dc, dr]) => {
        const point = P(headC + dc * cos - (height / HW) * sin, a.r + dr);
        point.y -= headZ + dc * HW * sin + height * cos;
        return point;
      });
      const base = layer(-halfHeight), lid = layer(halfHeight);
      ctx.strokeStyle = '#4a5566'; ctx.lineWidth = 0.6; ctx.lineJoin = 'round';
      poly([base[3], base[2], lid[2], lid[3]]);
      ctx.fillStyle = '#7d8b9e'; ctx.fill(); ctx.stroke();
      poly([base[2], base[1], lid[1], lid[2]]);
      ctx.fillStyle = '#9aa9bb'; ctx.fill(); ctx.stroke();
      // When raised past the camera, the underside becomes visible in place of the top.
      poly(cos >= sin ? lid : base);
      ctx.fillStyle = '#c6d0dd'; ctx.fill(); ctx.stroke();
      if (cycle < 0.1) {
        const hit = P(contactC, a.r);
        hit.y -= gripZ + handleLength * Math.cos(strikeAngle) - halfLength * HW * Math.sin(strikeAngle);
        ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(hit.x - 4, hit.y - 5); ctx.lineTo(hit.x - 8, hit.y - 7);
        ctx.moveTo(hit.x - 4, hit.y + 2); ctx.lineTo(hit.x - 8, hit.y + 4);
        ctx.stroke();
      }
      ctx.restore();
    }

    // ---------- astronauts ----------
    function drawAstronaut(A, a, exposed, danger, blink, sel) {
      const p = up(P(a.c, a.r), a.z); // standing on their terrace
      a.x = p.x; a.y = p.y; // remembered for clicks (crewAt)
      // While walking they hop (like Apollo crews did in the Moon's low gravity); the shadow stays on the ground.
      const hop = Math.abs(Math.sin(time * 9 + A.id)) * 4 * (a.walk || 0), y = p.y - hop, sh = 1 - hop / 10;
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(p.x, p.y, 5.5 * sh, 2.7 * sh, 0, 0, Math.PI * 2); ctx.fill();
      if (sel) { // picked: pulsing gold ring on the ground
        const k = 1 + Math.sin(time * 5) * 0.15;
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 11 * k, 5.5 * k, 0, 0, Math.PI * 2); ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2; ctx.stroke();
      }
      const body = exposed && danger && blink ? '#ff5d5d' : LW.Sim.isSlow(A) ? '#ffc04d' : '#ffffff';
      ctx.fillStyle = body; ctx.strokeStyle = SUIT_LINE; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(p.x - 3.5, y - 12, 7, 11, 3.5); ctx.fill(); ctx.stroke(); // suit
      const hy = y - 15;
      ctx.beginPath(); ctx.arc(p.x, hy, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); // helmet
      const s = a.face === 1 ? -1 : 1; // the visor is drawn on the left (facing left); mirrored when walking right
      ctx.save(); ctx.clip(); // visor: blue window on the front of the helmet
      // a big round window: an oval that reaches just past the middle, its far side cut off by the helmet edge
      ctx.fillStyle = VISOR; ctx.beginPath(); ctx.ellipse(p.x - 2.2 * s, hy, 3.5, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
      ctx.beginPath(); ctx.arc(p.x, hy, 5, 0, Math.PI * 2); ctx.stroke(); // helmet outline back on top of the visor
      if (a.building) { ctx.save(); ctx.translate(0, -a.z); drawBuildingHammer(a, a.building); ctx.restore(); } // mallet on the same terrace as its astronaut
      // number tag (border = role colour) so you can match the astronaut to the AMS list
      ctx.fillStyle = 'rgba(10,14,22,0.85)'; ctx.beginPath(); ctx.roundRect(p.x - 6, p.y - 35, 12, 10, 3); ctx.fill();
      ctx.strokeStyle = C.astro.roleInfo[A.role].color; ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = '#ffd36b'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText(String(A.id), p.x, p.y - 27.5);
    }

    // ---------- the rover (TEMPORARY model: a small box on 4 wheels, to be replaced with better art later) ----------
    // Position in grid squares: parked next to its HAB, or on the way between two HABs.
    function roverAt(state) {
      return LW.Sim.roverPosition(state, frac);
    }

    function craterDepthAt(x, y) {
      let depth = 0;
      // Follow the paint order, blending overlapping rims so the rover descends smoothly.
      for (const crater of craters) {
        const dx = (x - crater.x) / crater.r, dy = (y - crater.y) / (crater.r * 0.5);
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > 1.15 * 1.15) continue;
        const bowl = Math.max(0, 1 - distanceSquared);
        const floor = Math.min(7, crater.r * 0.22) * bowl * bowl;
        const rim = Math.min(1, (1.15 - Math.sqrt(distanceSquared)) / 0.15);
        const blend = rim * rim * (3 - 2 * rim);
        depth += (floor - depth) * blend;
      }
      return depth;
    }

    function drawRover(p) {
      const g = P(p.c, p.r), fw = gridDir(p.dir.c * 0.28, p.dir.r * 0.28), sd = gridDir(-p.dir.r * 0.17, p.dir.c * 0.17);
      const depth = craterDepthAt(g.x, g.y);
      const pitch = (craterDepthAt(g.x + fw.x, g.y + fw.y) - craterDepthAt(g.x - fw.x, g.y - fw.y)) * 0.5;
      const roll = (craterDepthAt(g.x + sd.x, g.y + sd.y) - craterDepthAt(g.x - sd.x, g.y - sd.y)) * 0.5;
      g.y += depth - liftAt(p.c, p.r);
      if (p.moving && Math.random() < 0.5) spawn(1, g.x - fw.x * 1.4, g.y - fw.y * 1.4, (Math.random() - 0.5) * 20, -Math.random() * 10, 0.6, 'rgba(200,200,205,0.7)');
      const f = [
        { x: g.x + fw.x + sd.x, y: g.y + fw.y + sd.y + pitch + roll },
        { x: g.x + fw.x - sd.x, y: g.y + fw.y - sd.y + pitch - roll },
        { x: g.x - fw.x - sd.x, y: g.y - fw.y - sd.y - pitch - roll },
        { x: g.x - fw.x + sd.x, y: g.y - fw.y + sd.y - pitch + roll },
      ];
      ctx.fillStyle = 'rgba(0,0,0,0.3)'; ctx.beginPath(); ctx.ellipse(g.x, g.y + 2, 12, 5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#2b2f36'; for (const q of f) { ctx.beginPath(); ctx.arc(q.x, q.y, 2.6, 0, Math.PI * 2); ctx.fill(); } // wheels
      ctx.beginPath(); ctx.moveTo(f[0].x, f[0].y - 3); for (let k = 1; k < 4; k++) ctx.lineTo(f[k].x, f[k].y - 3); ctx.closePath();
      ctx.fillStyle = '#c9a63a'; ctx.fill(); // chassis
      ctx.beginPath(); ctx.moveTo(f[0].x, f[0].y - 8); for (let k = 1; k < 4; k++) ctx.lineTo(f[k].x, f[k].y - 8); ctx.closePath();
      ctx.fillStyle = '#e8c547'; ctx.fill(); ctx.strokeStyle = '#8a7a2e'; ctx.lineWidth = 1; ctx.stroke(); // roof
      ctx.fillStyle = '#7fd0ff'; ctx.beginPath(); ctx.arc(g.x + fw.x * 0.6, g.y + fw.y * 0.6 - 8, 2.2, 0, Math.PI * 2); ctx.fill(); // window
      ctx.strokeStyle = '#c9d1dc'; ctx.beginPath(); ctx.moveTo(g.x - fw.x * 0.6, g.y - fw.y * 0.6 - 8); ctx.lineTo(g.x - fw.x * 0.6, g.y - fw.y * 0.6 - 16); ctx.stroke(); // antenna
      if (p.riders) { ctx.fillStyle = '#ffd36b'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText('👩‍🚀' + p.riders, g.x, g.y - 20); }
    }

    // Moon dust kicked up by the spaceship's exhaust near the ground (sq: 1 = flat circle, 0.5 = squashed for 2.5D).
    function shipDust(f, x, y, sq) {
      const n = f.burst ? 26 : f.dust > 0 && Math.random() < f.dust ? 2 : 0;
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2, sp = 50 + Math.random() * 70, r0 = 14 + Math.random() * 6;
        spawn(1, x + Math.cos(a) * r0, y + Math.sin(a) * r0 * sq, Math.cos(a) * sp, Math.sin(a) * sp * sq, 0.7 + Math.random() * 0.5, 'rgba(200,200,205,0.75)');
      }
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
      const v = toGrid(cam.x + vw() / 2, cam.y + vh() / 2);
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
      if (!ground) buildGround(state);
      if (needCenter) { centerOnBase(state, false); needCenter = false; }
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
      const hc = up(mid(habM), liftOf(habM));

      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.fillStyle = '#0b0e15'; ctx.fillRect(0, 0, VW, VH);
      const S = DPR * zoom; // world pixels → device pixels
      ctx.setTransform(S, 0, 0, S, -Math.round(cam.x * S), -Math.round(cam.y * S));
      const gx = Math.max(0, Math.floor(cam.x)), gy = Math.max(0, Math.floor(cam.y));
      const gw = Math.min(W - gx, Math.ceil(vw()) + 2), gh = Math.min(H - gy, Math.ceil(vh()) + 2);
      if (gw > 0 && gh > 0) ctx.drawImage(ground, gx, gy, gw, gh, gx, gy, gw, gh);
      const VWz = vw(), VHz = vh(); // the part of the world on screen, in world pixels

      // Terrain shadow: each zone gets darker as the Sun slides behind the hills. The masks (made in
      // buildGround) hold exactly where each zone shows, terrace walls included, so nearer hills stay right.
      const shadeOf = {
        ridge: 0.75 * (1 - LW.Sim.zoneLight(state, 'ridge', state.hour + frac)),
        plain: 0.75 * (1 - LW.Sim.zoneLight(state, 'plain', state.hour + frac)),
        ice: 0.35,
      };
      if (gw > 0 && gh > 0) {
        for (const z of ZONE_NAMES) {
          if (shadeOf[z] < 0.005) continue;
          ctx.globalAlpha = shadeOf[z];
          ctx.drawImage(masks[z].canvas, gx / 2, gy / 2, gw / 2, gh / 2, gx, gy, gw, gh);
        }
        ctx.globalAlpha = 1;
      }

      // Object shadows point AWAY from the Sun, long and soft because the Sun is always low at the pole.
      // Only draw what the camera can see (+ a margin for tall buildings, long shadows and labels), so a big base stays fast.
      // A building on a terrace is drawn raised (or sunk) by its lift, so that is included.
      const MARGIN = 140, vx0 = cam.x - MARGIN, vy0 = cam.y - MARGIN, vx1 = cam.x + VWz + MARGIN, vy1 = cam.y + VHz + MARGIN;
      const onScreen = (m) => {
        const z = liftOf(m), a = P(m.c, m.r), b = P(m.c + m.w, m.r), d = P(m.c + m.w, m.r + m.h), e = P(m.c, m.r + m.h);
        return Math.max(a.x, b.x, d.x, e.x) >= vx0 && Math.min(a.x, b.x, d.x, e.x) <= vx1 && Math.max(a.y, b.y, d.y, e.y) - z >= vy0 && Math.min(a.y, b.y, d.y, e.y) - z <= vy1;
      };
      const lineOnScreen = (a, b) => Math.max(a.x, b.x) >= vx0 && Math.min(a.x, b.x) <= vx1 && Math.max(a.y, b.y) >= vy0 && Math.min(a.y, b.y) <= vy1;
      const habMids = LW.Sim.habs(state).map((h) => up(mid(h), liftOf(h))); // worked out once per frame (not once per building)
      const sg = sunGrid(state);
      for (const m of state.modules) {
        if (!m.built || m.type === 'pad' || !onScreen(m)) continue; // (flat pads cast no shadow)
        const L = lightAt(state, m);
        if (L < 0.02) continue;
        const len = (SHADOW_LEN[m.type] || 0.5) * (1 + (1 - L) * 1.5);
        const f = footprint(m.c, m.r, m.w, m.h, m.type === 'hab' ? 0.3 : 0.25), z = liftOf(m);
        const off = gridDir(-sg.c * len, -sg.r * len);
        const pts = f.map((p) => [p.x, p.y - z]);
        const hp = hull(pts.concat(pts.map(([px, py]) => [px + off.x, py + off.y])));
        ctx.fillStyle = `rgba(0,0,0,${(0.28 * L).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(hp[0][0], hp[0][1]);
        for (let i = 1; i < hp.length; i++) ctx.lineTo(hp[i][0], hp[i][1]);
        ctx.closePath(); ctx.fill();
      }

      // power cables on the ground: yellow moving dashes = power flowing, red = no power
      ctx.lineWidth = 2;
      for (const m of state.modules) {
        if (!m.built || m === habM) continue; // (extra HABs get a cable to HAB 1)
        const c = up(mid(m), liftOf(m));
        let color, flow = 0;
        if (m.type === 'solar') { const lit = m.light > 0.02 && m.on; color = lit ? '#ffd36b' : '#4a4f5a'; flow = lit ? 1 : 0; }
        else if (m.type === 'battery') {
          const charging = state.power.supply > state.power.use;
          color = state.res.battery > 0.01 || charging ? '#7de0a0' : '#4a4f5a'; flow = charging ? 1 : state.res.battery > 0.01 ? -1 : 0;
        } else if (m.type === 'shelter' || !LW.Sim.needOf(state, m)) { color = m.type === 'shelter' ? '#6b5b45' : '#5a6170'; } // walkways, no power cable
        else { color = !m.on ? '#4a4f5a' : m.powered ? '#ffd36b' : '#ff5d5d'; flow = m.on && m.powered ? -1 : 0; }
        ctx.strokeStyle = color;
        ctx.setLineDash(flow ? [6, 6] : (m.type === 'shelter' || !LW.Sim.needOf(state, m)) ? [2, 4] : [3, 5]);
        ctx.lineDashOffset = flow * dashOffset;
        const to = m.type === 'hab' ? hc : habMids.reduce((b, p) => (Math.hypot(p.x - c.x, p.y - c.y) < Math.hypot(b.x - c.x, b.y - c.y) ? p : b), hc); // nearest HAB
        if (!lineOnScreen(c, to)) continue; // a cable can cross the screen even if both ends are off it
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.lineDashOffset = 0;

      // Research Bay reach (dashed ring on the ground): while placing one, hovering one, or with the Scientist
      // picked. A circle of R squares on the grid is an ellipse √2·R·HW wide and √2·R·HH tall on screen.
      const picked = ui.selectedCrew ? state.crew.find((a) => a.id === ui.selectedCrew && !a.medbay) : null;
      const hoverM = ui.hover && !ui.buildType && Iso.inMap(ui.hover.c, ui.hover.r, COLS, ROWS) ? LW.Sim.moduleAt(state, ui.hover.c, ui.hover.r) : null;
      const rings = [];
      if (ui.buildType === 'lab' && ui.hover) rings.push(up(P(ui.hover.c + 0.5, ui.hover.r + 0.5), liftAt(ui.hover.c, ui.hover.r)));
      for (const l of LW.Sim.built(state, 'lab')) {
        if ((picked && picked.role === 'scientist') || hoverM === l || (hoverM && C.research.targets.includes(hoverM.type))) rings.push({ ...up(mid(l), liftOf(l)), dead: l.damaged });
      }
      // Placing a Landing Pad: gold rings show how close to a HAB it must be.
      if (ui.buildType === 'pad') {
        ctx.setLineDash([8, 6]); ctx.lineDashOffset = dashOffset * 0.5; ctx.lineWidth = 2;
        for (const H of state.modules) if (H.type === 'hab') {
          const p = up(mid(H), liftOf(H)), R = C.pad.radius * Math.SQRT2;
          ctx.beginPath(); ctx.ellipse(p.x, p.y, R * HW, R * HH, 0, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,211,107,0.06)'; ctx.fill(); ctx.strokeStyle = 'rgba(255,211,107,0.8)'; ctx.stroke();
        }
        // Red rings: no new pad may go inside another pad's area.
        for (const P2 of state.modules) if (P2.type === 'pad') {
          const p = up(mid(P2), liftOf(P2)), R = C.pad.radius * Math.SQRT2;
          ctx.beginPath(); ctx.ellipse(p.x, p.y, R * HW, R * HH, 0, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,93,93,0.07)'; ctx.fill(); ctx.strokeStyle = 'rgba(255,93,93,0.8)'; ctx.stroke();
        }
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
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
      const jobs = LW.Sim.jobList(state);
      if (picked) {
        ctx.strokeStyle = C.astro.roleInfo[picked.role].color; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
        for (const j of jobs) if (j.assignee === picked.id) { const m = j.m || habM; poly(footprint(m.c, m.r, m.w, m.h, -0.06), liftOf(m)); ctx.stroke(); }
        ctx.setLineDash([]);
      }

      // Astronauts: where they stand comes from the shared crew motion (js/crew_motion.js, grid squares),
      // so they keep walking from the same spot when the player switches views.
      if (ownMotion) motion.update(state, dt, ui.paused, ui.frac);
      const danger = state.stormRate > C.rad.stormOn || !!state.meteorOn;
      const people = [];
      // The rover (TEMPORARY model): drawn in depth order with everything else.
      const rp = roverAt(state);
      if (rp) people.push({ depth: rp.c + rp.r, draw: () => drawRover(rp) });
      for (const k in crew) crew[k].shown = false; // astronauts sent home to Earth are no longer in state.crew
      state.crew.forEach((A) => {
        const p = motion.get(A.id);
        if (!p || A.trip) { if (crew[A.id]) crew[A.id].z = null; return; } // inside the rover: new terrace when they get out
        const a = crew[A.id] || (crew[A.id] = { c: 0, r: 0, z: null });
        a.c = p.c; a.r = p.r; a.face = p.face; a.walk = p.walk; // face = which way they look, walk = hop strength
        const zT = liftAt(a.c, a.r); // terrace under their feet: step up/down to it quickly instead of popping
        a.z = a.z == null ? zT : a.z + (zT - a.z) * Math.min(1, dt * 12);
        // Hammering a building site: face the building (Gerardo's mallet is drawn in drawAstronaut).
        a.building = p.building ? state.modules.find((m) => m.id === p.building) || null : null;
        if (a.building) {
          const target = mid(a.building), position = P(a.c, a.r);
          a.face = target.x < position.x ? -1 : 1;
        }
        const sel = picked === A;
        a.id = A.id;
        a.shown = !A.medbay && (p.visible || p.dist * PX_PER_TILE >= 1 || sel); // the picked astronaut is always shown, even inside
        if (!a.shown) return; // inside the habitat (or medbay): hidden
        people.push({ depth: a.c + a.r, draw: () => drawAstronaut(A, a, LW.Sim.isExposed(A), danger, blink, sel) });
      });

      // The crew spaceship (js/ship.js): a small 3D lander coming straight down onto its Landing Pad, drawn just
      // after the pad in depth order. It is drawn on the map, so it lands on the pad wherever the camera is.
      const ship = ui.ship;
      let shipAt = null;
      if (ship) {
        const pad = state.modules.find((m) => m.id === ship.padId);
        const g = up(P(ship.c, ship.r), pad ? liftOf(pad) : liftAt(ship.c, ship.r));
        shipAt = { x: g.x, y: g.y - HEIGHT.pad }; // on top of the pad's slab
        const L = pad ? lightAt(state, pad) : 1, len = 1.2 * (1 + (1 - L) * 1.5); // squares, like the buildings' shadows
        const d = gridDir(-sg.c * len, -sg.r * len), sh = { dx: d.x, dy: d.y, light: L };
        people.push({ depth: ship.c + ship.r + 0.01, draw: () => { LW.Ship.drawIso(ctx, shipAt.x, shipAt.y, ship, sh, time); shipDust(ship, shipAt.x, shipAt.y, 0.5); } });
      }

      // Draw buildings and people from the back of the map to the front, so nearer things cover farther ones.
      const things = state.modules.filter(onScreen).map((m) => ({ depth: m.c + m.w / 2 + m.r + m.h / 2, draw: () => drawModuleOnGround(state, m, blink) }));
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
          const ok = LW.Sim.canPlace(state, ui.buildType, c, r).ok;
          const f = footprint(c, r, d.w, d.h, 0), z = liftOfRect(c, r, d.w, d.h);
          poly(f, z); ctx.fillStyle = ok ? 'rgba(95,224,138,0.25)' : 'rgba(255,93,93,0.25)'; ctx.fill();
          ctx.strokeStyle = ok ? '#5fe08a' : '#ff5d5d'; ctx.lineWidth = 2; ctx.stroke();
          const p = up(P(c + d.w / 2, r + d.h / 2), z);
          ctx.font = '20px system-ui'; ctx.textAlign = 'center'; ctx.fillText(d.icon, p.x, p.y + 7);
        } else {
          const m = LW.Sim.moduleAt(state, c, r);
          ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5;
          poly(m ? footprint(m.c, m.r, m.w, m.h, 0) : footprint(c, r, 1, 1, 0), m ? liftOf(m) : liftAt(c, r)); ctx.stroke();
        }
      }

      if (shipAt) LW.Ship.label(ctx, shipAt.x, shipAt.y - 100, ship.text, ship.label, zoom); // "Your crew has landed!", above the ship

      // screen-space overlays
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      if (state.stormRate > C.rad.stormOn) { ctx.fillStyle = `rgba(255,40,40,${Math.min(0.14, state.stormRate * 0.01)})`; ctx.fillRect(0, 0, VW, VH); }
      if (state.meteorOn) { ctx.fillStyle = 'rgba(40,20,70,0.12)'; ctx.fillRect(0, 0, VW, VH); }
      drawBaseTag(hc, habM);
    }

    // New game. The ground picture is kept: the terrain is the same in every game (it comes from the config),
    // and painting it again takes long enough to freeze the game. Call rebuildGround() if the map ever changes.
    function reset() { tagRect = null; zoom = 1; needCenter = true; crew = {}; if (ownMotion) motion.reset(); for (const p of pool) p.alive = false; }
    function rebuildGround() { ground = null; painting = null; }
    /** Paint the ground picture now (if not done yet), so showing this view later does not freeze the game. */
    function prepare(state) { if (!ground && state) buildGround(state); }
    /** The astronaut drawn under the mouse (id), or null. Checks the body and the number tag above it. */
    function crewAt(evt) {
      const p = toCanvas(evt), wx = cam.x + p.x / zoom, wy = cam.y + p.y / zoom; // mouse → world pixels
      let best = null, bd = 12;
      for (const a of Object.values(crew)) {
        if (!a.shown || a.x == null) continue;
        const d = Math.min(Math.hypot(a.x - wx, a.y - 11 - wy), Math.hypot(a.x - wx, a.y - 30 - wy)); // the body or its number tag
        if (d < bd) { bd = d; best = a.id; }
      }
      return best;
    }

    return {
      draw, tileAt, toCanvas, hitTag, crewAt, reset, rebuildGround, prepare, prepareStep, centerOnBase, centerOnTile, screenOf, resize, setSafeArea, zoomAt,

      panStart: () => ({ x: cam.x, y: cam.y }),
      debug: () => ({ cam: { ...cam }, zoom, tag: tagRect, view: [VW, VH], world: [W, H] }),
      panTo: (x, y) => moveTo(x, y),
    };
  }

  LW.IsoRenderer = IsoRenderer;
})(window);
