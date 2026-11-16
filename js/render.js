// Drawing the map. Runs every frame (60 fps). Reads the sim state, never changes it.
// The world is bigger than the screen: a camera (cam.x, cam.y = top-left corner in world pixels)
// picks which part we see. Drag the map to move the camera.
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const POOL_SIZE = 420;
  const METERS_PER_TILE = 10; // for the "base is 120 m away" tag
  const SUIT_LINE = '#1b2230', VISOR = '#1ea5e9'; // astronaut outline and helmet visor (same as render_iso.js)

  // A small bowl-shaped crater, lit from the top-left (the ground is drawn once, so the light is fixed).
  // Shared with render_iso.js, which squashes it into an oval (sy = 0.5).
  // base = a copy of the ground before any craters. Where craters overlap, the newer one first puts that
  // plain ground back under itself, so it cleanly covers the older one (like a new impact on an old crater).
  function drawCrater(g, x, y, r, sy, base) {
    const R = r * 1.15, x0 = Math.max(0, Math.floor(x - R)), y0 = Math.max(0, Math.floor(y - R * sy));
    const w = Math.min(base.width, Math.ceil(x + R)) - x0, h = Math.min(base.height, Math.ceil(y + R * sy)) - y0;
    if (w > 0 && h > 0) {
      g.save(); g.beginPath(); g.ellipse(x, y, R, R * sy, 0, 0, Math.PI * 2); g.clip();
      g.drawImage(base, x0, y0, w, h, x0, y0, w, h); g.restore();
    }
    g.save(); g.translate(x, y); g.scale(1, sy);
    craterShape(g, r);
    g.restore();
  }
  function craterShape(g, r) {
    const x = 0, y = 0; // drawn around (0, 0); drawCrater moves (and squashes) it into place
    g.beginPath(); g.arc(x, y, r * 1.15, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.05)'; g.fill(); // raised rim / thrown-out dust
    // bowl: the top-left inner wall faces away from the Sun (dark), the bottom-right one faces it (light)
    const bowl = g.createLinearGradient(x - r * 0.7, y - r * 0.7, x + r * 0.7, y + r * 0.7);
    bowl.addColorStop(0, 'rgba(0,0,0,0.4)'); bowl.addColorStop(0.55, 'rgba(0,0,0,0.14)'); bowl.addColorStop(1, 'rgba(255,255,255,0.1)');
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = bowl; g.fill();
    // shadow the rim casts into the bowl: a dark crescent along the top-left inside edge
    g.save(); g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.clip();
    g.beginPath(); g.rect(x - r, y - r, r * 2, r * 2); g.arc(x + r * 0.3, y + r * 0.3, r * 0.95, 0, Math.PI * 2, true);
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fill(); g.restore();
    // rim edges: sunlit on the top-left, a faint shadow on the far side
    g.lineWidth = Math.max(1, r * 0.08);
    g.beginPath(); g.arc(x, y, r * 1.04, Math.PI * 0.85, Math.PI * 1.65); g.strokeStyle = 'rgba(255,255,255,0.2)'; g.stroke();
    g.beginPath(); g.arc(x, y, r * 1.1, -Math.PI * 0.15, Math.PI * 0.65); g.strokeStyle = 'rgba(0,0,0,0.12)'; g.stroke();
  }
  LW.drawCrater = drawCrater;

  // motion: shared astronaut positions (js/crew_motion.js). view.js passes one shared object to both views;
  // without it this view keeps its own (used by tests and if render.js is used on its own).
  function Renderer(canvas, forecastCanvas, motion) {
    const ownMotion = !motion || typeof motion.update !== 'function';
    if (ownMotion) motion = LW.CrewMotion();
    const C = LW.CONFIG, T = C.map.tile;
    const W = C.map.cols * T, H = C.map.rows * T; // world size
    let VW = C.map.viewCols * T, VH = C.map.viewRows * T, DPR = 1; // what the camera shows (CSS pixels)
    // ZOOM: 1 = normal, 2 = everything twice as big. The camera then sees VW / zoom world pixels across.
    const ZOOM_MIN = 0.5, ZOOM_MAX = 2.5;
    let zoom = 1;
    const vw = () => VW / zoom, vh = () => VH / zoom; // how much of the world fits on screen
    const safe = { left: 0, right: 0, top: 0, bottom: 0 }; // screen edges covered by open panels
    const ctx = canvas.getContext('2d');
    const fctx = forecastCanvas.getContext('2d');

    let needCenter = true; // look at the base on the first frame of a game
    let ground = null, zonePaths = null;
    let crew = {}; // astronaut id -> where their dot is drawn (world pixels), also used to click on them
    const pool = [];
    for (let i = 0; i < POOL_SIZE; i++) pool.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, kind: 0, color: '' });
    let time = 0, dashOffset = 0, frac = 0;
    const cam = { x: 0, y: 0, tx: 0, ty: 0, flying: false };
    let tagRect = null; // where the "back to base" tag was drawn (canvas pixels), for clicks

    // ---------- screen size ----------
    // The canvas fills the window. We draw in CSS pixels and scale by the device pixel ratio so it stays sharp.
    function resize(cssW, cssH) {
      // keep the same spot of the Moon in the middle of the screen when the window changes size
      const midX = cam.x + vw() / 2, midY = cam.y + vh() / 2;
      VW = Math.max(200, Math.round(cssW)); VH = Math.max(200, Math.round(cssH));
      cam.x = midX - vw() / 2; cam.y = midY - vh() / 2;
      DPR = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(VW * DPR); canvas.height = Math.round(VH * DPR);
      moveTo(cam.x, cam.y);
    }
    function setSafeArea(a) { Object.assign(safe, a); }

    // ---------- camera ----------
    const clampX = (x) => (W <= vw() ? (W - vw()) / 2 : Math.max(0, Math.min(W - vw(), x))); // centre the world if the screen is bigger
    const clampY = (y) => (H <= vh() ? (H - vh()) / 2 : Math.max(0, Math.min(H - vh(), y)));
    function moveTo(x, y) { cam.x = clampX(x); cam.y = clampY(y); cam.flying = false; }
    function flyTo(x, y) { cam.tx = clampX(x); cam.ty = clampY(y); cam.flying = true; }
    // Centre a world point in the part of the screen that is NOT covered by panels.
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
    function centerOnTile(c, r, smooth) { centerOn(c * T, r * T, smooth); }
    /** Where a grid point is on the screen right now (pixels from the map's top-left corner). */
    function screenOf(c, r) { return { x: (c * T - cam.x) * zoom, y: (r * T - cam.y) * zoom }; }
    function centerOnBase(state, smooth) {
      const hab = state.modules.find((m) => m.type === 'hab');
      centerOn((hab.c + hab.w / 2) * T, (hab.r + hab.h / 2) * T, smooth);
    }

    // Mouse position → canvas pixels (the canvas is scaled by CSS) → world tile.
    function toCanvas(evt) {
      const rect = canvas.getBoundingClientRect();
      return { x: ((evt.clientX - rect.left) / rect.width) * VW, y: ((evt.clientY - rect.top) / rect.height) * VH, px: evt.clientX - rect.left, py: evt.clientY - rect.top, scale: VW / rect.width / zoom }; // scale: mouse pixels → world pixels (for dragging)
    }
    function tileAt(evt) {
      const p = toCanvas(evt);
      return { c: Math.floor((cam.x + p.x / zoom) / T), r: Math.floor((cam.y + p.y / zoom) / T), px: p.px, py: p.py };
    }
    function hitTag(evt) {
      if (!tagRect) return false;
      const p = toCanvas(evt);
      const pad = 12; // easier to hit than the drawn tag
      return p.x >= tagRect.x - pad && p.x <= tagRect.x + tagRect.w + pad && p.y >= tagRect.y - pad && p.y <= tagRect.y + tagRect.h + pad;
    }

    // ---------- static ground, drawn once ----------
    function buildGround(state) {
      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const g = off.getContext('2d');
      let seed = 1234;
      const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      zonePaths = { ridge: new Path2D(), plain: new Path2D(), ice: new Path2D() };
      for (let r = 0; r < C.map.rows; r++) for (let c = 0; c < C.map.cols; c++) {
        zonePaths[LW.Sim.zoneOf(state, c, r)].rect(c * T, r * T, T, T);
      }
      for (const z of ['plain', 'ridge', 'ice']) { g.fillStyle = C.zones[z].color; g.fill(zonePaths[z]); }
      const area = (W * H) / (800 * 560);
      for (let i = 0; i < 2600 * area; i++) {
        const x = rand() * W, y = rand() * H, s = rand() * 2 + 0.5;
        g.fillStyle = rand() < 0.5 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
        g.fillRect(x, y, s, s);
      }
      const base = document.createElement('canvas'); // the ground before craters (see drawCrater)
      base.width = W; base.height = H; base.getContext('2d').drawImage(off, 0, 0);
      const craters = [];
      for (let i = 0; i < 46 * area; i++) craters.push({ x: rand() * W, y: rand() * H, r: 4 + rand() ** 2 * 30 });
      craters.sort((a, b) => b.r - a.r); // big (old) craters first, so small ones land on top of them
      for (const k of craters) drawCrater(g, k.x, k.y, k.r, 1, base);
      base.width = base.height = 0; // free the big temporary copy (~27 MB) right away
      g.save(); g.clip(zonePaths.ice);
      for (let i = 0; i < 260 * area; i++) {
        g.fillStyle = `rgba(170,210,255,${0.15 + rand() * 0.35})`;
        g.fillRect(rand() * W, rand() * H, 1.5, 1.5);
      }
      g.restore();
      g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 2; g.stroke(zonePaths.ridge);
      g.strokeStyle = 'rgba(255,255,255,0.045)'; g.lineWidth = 1;
      for (let c = 0; c <= C.map.cols; c++) { g.beginPath(); g.moveTo(c * T + 0.5, 0); g.lineTo(c * T + 0.5, H); g.stroke(); }
      for (let r = 0; r <= C.map.rows; r++) { g.beginPath(); g.moveTo(0, r * T + 0.5); g.lineTo(W, r * T + 0.5); g.stroke(); }
      g.font = 'bold 13px system-ui, sans-serif'; g.textAlign = 'center';
      for (const f of C.features) {
        g.fillStyle = f.zone === 'ice' ? 'rgba(170,210,255,0.75)' : 'rgba(255,255,255,0.6)';
        g.fillText(f.label, f.u * W, f.v * H);
      }
      ground = off;
      crew = {};
    }

    // ---------- particles (object pool, no new objects per frame) ----------
    function spawn(kind, x, y, vx, vy, life, color) {
      for (const p of pool) if (!p.alive) { p.alive = true; p.kind = kind; p.x = x; p.y = y; p.vx = vx; p.vy = vy; p.life = 0; p.max = life; p.color = color; return p; }
      return null;
    }

    const center = (m) => ({ x: (m.c + m.w / 2) * T, y: (m.r + m.h / 2) * T });
    // Direction the sunlight comes FROM (unit vector, screen coords). Smooth between game hours.
    const sunVec = (state) => {
      const a = (LW.Sim.sunAz(state, state.hour + frac) * Math.PI) / 180;
      return { x: Math.cos(a), y: Math.sin(a) };
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
    // How long each building's shadow is (pixels, before the low-Sun stretch): taller things cast longer shadows.
    const SHADOW_LEN = { hab: 38, solar: 34, drill: 26, tower: 24, lab: 20 };
    const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
    const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;

    // ---------- module sprites ----------
    function drawModule(state, m, blink) {
      const x = m.c * T, y = m.r * T, w = m.w * T, h = m.h * T, cx = x + w / 2, cy = y + h / 2;
      const on = m.built && m.on && m.powered;
      ctx.save();
      if (!m.built) ctx.globalAlpha = 0.45;
      switch (m.type) {
        case 'hab': {
          const BM = m.berm || { built: false, building: false }; // each HAB has its own moon-dirt shield
          if (BM.built || BM.building) {
            const f = BM.built ? 1 : BM.progress / C.bermWork;
            ctx.beginPath(); ctx.arc(cx, cy, 38, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f);
            ctx.strokeStyle = '#8a7558'; ctx.lineWidth = 9; ctx.stroke();
          }
          ctx.beginPath(); ctx.arc(cx, cy, 31, 0, Math.PI * 2);
          ctx.fillStyle = '#d9dde4'; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = '#8f96a3'; ctx.stroke();
          ctx.beginPath(); ctx.arc(cx, cy, 20, 0, Math.PI * 2); ctx.strokeStyle = '#aab1bd'; ctx.stroke();
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * Math.PI * 2 + 0.3;
            ctx.fillStyle = on ? ((m.temp != null ? m.temp : state.habTemp) < 15 ? '#7fb4ff' : '#ffd36b') : '#39404b';
            ctx.fillRect(cx + Math.cos(a) * 25 - 3, cy + Math.sin(a) * 25 - 3, 6, 6);
          }
          ctx.fillStyle = '#5b6576'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center';
          ctx.fillText(LW.Sim.habs(state).length > 1 && m.built ? LW.Sim.habName(state, m) : 'HAB', cx, cy + 4);
          break;
        }
        case 'solar': {
          // Tall panel on a mast (like NASA's VSAT arrays), seen from above edge-on. It turns to face the low Sun.
          const L = lightAt(state, m), sv = sunVec(state);
          ctx.strokeStyle = '#7f8896'; ctx.fillStyle = '#7f8896'; ctx.lineWidth = 2;
          for (let k = 0; k < 3; k++) { // tripod feet
            const a = 0.5 + (k * Math.PI * 2) / 3, fx = cx + Math.cos(a) * 11, fy = cy + Math.sin(a) * 11;
            ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(fx, fy); ctx.stroke();
            ctx.beginPath(); ctx.arc(fx, fy, 1.8, 0, Math.PI * 2); ctx.fill();
          }
          ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.atan2(sv.y, sv.x) + Math.PI / 2); // local -y = towards the Sun
          ctx.fillStyle = '#5a6170'; ctx.fillRect(-18, -0.5, 36, 3); // back of the panel
          ctx.fillStyle = rgb(mix([29, 44, 72], [47, 111, 214], L)); ctx.fillRect(-18, -4, 36, 3.5); // sunny face
          ctx.strokeStyle = '#dfe5ec'; ctx.lineWidth = 1; ctx.strokeRect(-18, -4, 36, 6.5);
          ctx.strokeStyle = rgb(mix([58, 74, 102], [140, 180, 245], L)); ctx.beginPath();
          for (let i = -9; i <= 9; i += 9) { ctx.moveTo(i, -4); ctx.lineTo(i, -0.5); }
          ctx.stroke();
          if (L > 0.3 && m.built && m.on) { ctx.fillStyle = `rgba(255,255,255,${(0.25 + 0.25 * Math.sin(time * 3 + m.id)) * L})`; ctx.fillRect(-18, -4, 8, 3.5); }
          ctx.restore();
          ctx.fillStyle = '#dfe5ec'; ctx.beginPath(); ctx.arc(cx, cy, 3.2, 0, Math.PI * 2); ctx.fill(); // mast seen from above
          ctx.strokeStyle = '#596273'; ctx.lineWidth = 1; ctx.stroke();
          break;
        }
        case 'battery': {
          // Dark battery box on a skid, two white heat radiators on top, 4 charge lights.
          const cap = LW.Sim.batteryCap(state) || 1;
          const f = Math.max(0, Math.min(1, state.res.battery / cap));
          ctx.fillStyle = '#4b5361'; ctx.beginPath(); ctx.roundRect(x + 5, y + 5, 30, 30, 3); ctx.fill();
          ctx.fillStyle = '#2a2f38'; ctx.fillRect(x + 8, y + 8, 24, 24);
          ctx.strokeStyle = '#8a93a3'; ctx.lineWidth = 1.5; ctx.strokeRect(x + 8, y + 8, 24, 24);
          ctx.fillStyle = '#e9edf2'; ctx.strokeStyle = '#9aa2af'; ctx.lineWidth = 1;
          for (const fx of [14, 23]) { ctx.fillRect(x + fx, y + 6, 3.5, 21); ctx.strokeRect(x + fx, y + 6, 3.5, 21); }
          const lit = m.built ? Math.ceil(f * 4 - 0.01) : 0, col = LW.Shapes.chargeColor(f);
          for (let i = 0; i < 4; i++) { ctx.fillStyle = i < lit ? col : '#3a414d'; ctx.fillRect(x + 10 + i * 5.3, y + 28.5, 4.2, 2.5); }
          LW.Shapes.bolt(ctx, x + 20.2, y + 16.5, 1, '#ffd36b');
          break;
        }
        case 'o2gen': {
          // Water splitter (like the ISS oxygen generator) and a round O2 tank. Blue pipe = water coming in.
          const wet = on && !m.noWater;
          ctx.fillStyle = 'rgba(89,99,115,0.75)'; ctx.beginPath(); ctx.roundRect(x + 5, y + 5, 30, 30, 4); ctx.fill();
          ctx.strokeStyle = wet ? '#58c4ff' : '#59636f'; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(x + 5, y + 33); ctx.lineTo(x + 11, y + 27); ctx.stroke();
          ctx.strokeStyle = '#9aa2af'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + 19, y + 18); ctx.lineTo(x + 25, y + 13); ctx.stroke();
          ctx.beginPath(); ctx.arc(x + 15, y + 23, 9, 0, Math.PI * 2); ctx.fillStyle = '#d6dee8'; ctx.fill(); ctx.strokeStyle = '#7f8b99'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.beginPath(); ctx.arc(x + 15, y + 23, 6, 0, Math.PI * 2); ctx.strokeStyle = wet ? '#58c4ff' : '#59636f'; ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = '#9aa2af'; ctx.beginPath(); ctx.arc(x + 15, y + 23, 2.5, 0, Math.PI * 2); ctx.fill();
          ctx.beginPath(); ctx.arc(x + 28, y + 11, 6.8, 0, Math.PI * 2); ctx.fillStyle = '#f2f4f7'; ctx.fill(); ctx.strokeStyle = '#7f8b99'; ctx.lineWidth = 1; ctx.stroke();
          ctx.fillStyle = wet ? '#2f8fd0' : '#59636f'; ctx.font = 'bold 7px system-ui'; ctx.textAlign = 'center'; ctx.fillText('O₂', x + 28, y + 13.5);
          if (wet && Math.random() < 0.15) spawn(2, x + 15 + (Math.random() - 0.5) * 6, y + 20, 0, -12, 1.2, '#9fe0ff');
          break;
        }
        case 'greenhouse': {
          // Inflatable tunnel with rounded ends and pink-purple grow lights; airlock on the right-hand end.
          ctx.fillStyle = on ? 'rgba(255,120,220,0.22)' : 'rgba(80,90,100,0.4)';
          ctx.beginPath(); ctx.roundRect(x + 3, y + 9, 34, 22, 11); ctx.fill();
          for (const ry of [15.5, 24.5]) for (const rx of [11, 17.5, 24, 30.5]) {
            ctx.fillStyle = on ? '#4fdc6a' : '#3c6b45';
            ctx.beginPath(); ctx.arc(x + rx, y + ry, on ? 2.9 + Math.sin(time * 2 + rx + ry) * 0.3 : 2.2, 0, Math.PI * 2); ctx.fill();
          }
          ctx.strokeStyle = on ? 'rgba(255,170,235,0.8)' : 'rgba(140,150,160,0.7)'; ctx.lineWidth = 1; ctx.beginPath();
          for (const rx of [14, 20, 26]) { ctx.moveTo(x + rx, y + 9); ctx.lineTo(x + rx, y + 31); } // ribs
          ctx.stroke();
          ctx.strokeStyle = on ? '#ff9de8' : '#6b7480'; ctx.lineWidth = 2; ctx.beginPath(); ctx.roundRect(x + 3, y + 9, 34, 22, 11); ctx.stroke();
          ctx.fillStyle = '#aeb5c1'; ctx.fillRect(x + 35, y + 16.5, 4, 7); ctx.strokeStyle = '#6f7888'; ctx.lineWidth = 1; ctx.strokeRect(x + 35, y + 16.5, 4, 7); // airlock
          break;
        }
        case 'drill': {
          // Tracked drill rig (like the TRIDENT ice drill): mast on the right, auger hole with ice chips, water tank.
          ctx.fillStyle = '#30343b'; ctx.fillRect(x + 4, y + 6, 26, 4); ctx.fillRect(x + 4, y + 30, 26, 4); // tracks
          ctx.fillStyle = '#e0b860'; ctx.fillRect(x + 6, y + 9, 22, 22); ctx.strokeStyle = '#8a6d2c'; ctx.lineWidth = 1.5; ctx.strokeRect(x + 6, y + 9, 22, 22);
          ctx.fillStyle = '#3f8fd0'; ctx.beginPath(); ctx.arc(x + 14, y + 17, 5, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#7fc4ff'; ctx.lineWidth = 1; ctx.stroke();
          ctx.fillStyle = 'rgba(205,228,255,0.85)'; ctx.beginPath(); ctx.ellipse(x + 35, y + 21, 4.5, 8, 0, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#4b5361'; ctx.fillRect(x + 24, y + 13, 7, 14); ctx.strokeStyle = '#e0b860'; ctx.strokeRect(x + 24, y + 13, 7, 14);
          ctx.beginPath(); ctx.moveTo(x + 24, y + 13); ctx.lineTo(x + 31, y + 20); ctx.lineTo(x + 24, y + 27); ctx.stroke();
          ctx.translate(x + 35, y + 20); ctx.rotate(on ? time * 8 : 0.4);
          ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(-4, 0); ctx.lineTo(4, 0); ctx.stroke();
          if (on && Math.random() < 0.25) spawn(1, x + 35, y + 20, (Math.random() - 0.5) * 30, -Math.random() * 15, 0.9, 'rgba(190,220,255,0.8)');
          break;
        }
        case 'shelter': {
          // Mound of moon-dirt bags with an entry tunnel and a radiation sign.
          const sy = cy - 2;
          ctx.fillStyle = '#aeb5c1'; ctx.fillRect(cx - 4, sy + 9, 8, 10); ctx.strokeStyle = '#6f7888'; ctx.lineWidth = 1; ctx.strokeRect(cx - 4, sy + 9, 8, 10);
          ctx.fillStyle = '#2b2b2b'; ctx.fillRect(cx - 3, sy + 17, 6, 2.5);
          ctx.fillStyle = '#8a7558'; ctx.beginPath(); ctx.ellipse(cx, sy, 16, 13.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#b39a77'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.setLineDash([5, 2]); ctx.strokeStyle = 'rgba(60,45,30,0.55)'; ctx.lineWidth = 2.5; // rows of bags
          ctx.beginPath(); ctx.ellipse(cx, sy, 12.5, 10, 0, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); ctx.ellipse(cx, sy, 8, 6.3, 0, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
          LW.Shapes.trefoil(ctx, cx, sy, 3.6);
          if (state.sheltering) { ctx.fillStyle = '#7dff9a'; ctx.font = 'bold 9px system-ui'; ctx.textAlign = 'center'; ctx.fillText('CREW', cx, y + 7); }
          break;
        }
        case 'gym': {
          // Pressurized module on two cradles, blue roof stripe, dumbbell sign (bounces, orange, while someone trains).
          const training = state.crew.some((a) => a.where === 'gym' && a.gymId === m.id);
          ctx.fillStyle = '#3a414d'; ctx.fillRect(x + 10, y + 9, 5, 22); ctx.fillRect(x + 25, y + 9, 5, 22); // cradles
          ctx.fillStyle = '#d9dde4'; ctx.beginPath(); ctx.roundRect(x + 3, y + 12, 34, 16, 8); ctx.fill(); ctx.strokeStyle = '#8f96a3'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.fillStyle = on && !m.damaged ? '#7fb4ff' : '#59636f'; ctx.fillRect(x + 8, y + 18.5, 24, 3);
          ctx.strokeStyle = '#8f96a3'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x + 6.5, y + 20, 3, 0, Math.PI * 2); ctx.moveTo(x + 36.5, y + 20); ctx.arc(x + 33.5, y + 20, 3, 0, Math.PI * 2); ctx.stroke(); // end hatches
          const lift = training ? 1 + Math.abs(Math.sin(time * 4)) * 0.25 : 1;
          ctx.fillStyle = 'rgba(10,14,22,0.35)'; ctx.beginPath(); ctx.ellipse(x + 20, y + 20, 8, 3, 0, 0, Math.PI * 2); ctx.fill();
          LW.Shapes.dumbbell(ctx, x + 20, y + 20, 0.9 * lift, training ? '#ffb35c' : '#eef1f5');
          break;
        }
        case 'tower': {
          // Small observatory: round drum, white dome with an open slit, telescope that slowly sweeps the sky.
          ctx.fillStyle = '#2b313c'; ctx.fillRect(cx - 3, cy + 12, 6, 4); // door porch
          ctx.beginPath(); ctx.arc(cx, cy, 14, 0, Math.PI * 2); ctx.fillStyle = '#4b5361'; ctx.fill(); ctx.strokeStyle = '#6f7888'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.beginPath(); ctx.arc(cx, cy, 11.5, 0, Math.PI * 2); ctx.fillStyle = '#e4e8ee'; ctx.fill(); ctx.strokeStyle = '#9aa2af'; ctx.lineWidth = 1; ctx.stroke();
          const sweep = m.built ? Math.sin(time * 0.6 + m.id) * 0.5 : 0;
          ctx.save(); ctx.translate(cx, cy); ctx.rotate(sweep);
          ctx.fillStyle = '#1b2230'; ctx.fillRect(-2.6, -11.5, 5.2, 11.5); // slit
          ctx.fillStyle = '#f2f4f7'; ctx.fillRect(-1.6, -15, 3.2, 9); ctx.fillStyle = '#ffd36b'; ctx.fillRect(-1.6, -16, 3.2, 2.5); // telescope
          ctx.restore();
          if (m.built && blink && !LW.Sim.towerReadyIn(state, m)) { ctx.fillStyle = '#7fb4ff'; ctx.beginPath(); ctx.arc(x + w - 7, y + 7, 2.2, 0, Math.PI * 2); ctx.fill(); } // ready to use
          break;
        }
        case 'pad': {
          // Landing Pad of baked moon dirt: blast berm on the side facing the nearest HAB, scorch mark, target ring,
          // beacons (blinking green = ready for a spaceship).
          const ready = m.built && LW.Sim.landingSpots(state).some((sp) => sp.pad === m);
          const H = LW.Sim.habs(state).map(center).reduce((b, p) => (!b || Math.hypot(p.x - cx, p.y - cy) < Math.hypot(b.x - cx, b.y - cy) ? p : b), null);
          const face = H ? Math.atan2(H.y - cy, H.x - cx) : -Math.PI / 2;
          ctx.beginPath(); ctx.arc(cx, cy, 36, face - Math.PI * 0.42, face + Math.PI * 0.42); ctx.strokeStyle = '#8a7558'; ctx.lineWidth = 6; ctx.stroke();
          ctx.beginPath(); ctx.arc(cx, cy, 36, face - Math.PI * 0.42, face + Math.PI * 0.42); ctx.strokeStyle = '#b39a77'; ctx.lineWidth = 1.2; ctx.stroke();
          ctx.beginPath(); ctx.arc(cx, cy, 32, 0, Math.PI * 2); ctx.fillStyle = '#5d5f66'; ctx.fill(); ctx.strokeStyle = '#9aa2af'; ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = 'rgba(20,20,26,0.28)'; ctx.beginPath(); ctx.arc(cx, cy, 19, 0, Math.PI * 2); ctx.fill(); ctx.beginPath(); ctx.arc(cx, cy, 11, 0, Math.PI * 2); ctx.fill(); // scorch
          ctx.strokeStyle = '#d9dde4'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 5]); ctx.beginPath(); ctx.arc(cx, cy, 26, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
          ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(cx, cy, 13, 0, Math.PI * 2); ctx.stroke();
          ctx.beginPath(); for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(cx + dx * 16, cy + dy * 16); ctx.lineTo(cx + dx * 22, cy + dy * 22); } ctx.stroke();
          ctx.fillStyle = '#ffd36b'; ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
          for (let k = 0; k < 4; k++) {
            const a = Math.PI / 4 + (k * Math.PI) / 2;
            ctx.fillStyle = ready ? (blink ? '#5fe08a' : '#2e6b43') : '#59636f';
            ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 30, cy + Math.sin(a) * 30, 2.8, 0, Math.PI * 2); ctx.fill(); ctx.strokeStyle = '#2b313c'; ctx.lineWidth = 1; ctx.stroke();
          }
          break;
        }
        case 'lab': {
          // Lab block with a stepped roof, dish antenna and sensor mast; the flask glows (and bubbles) while the Scientist works.
          const busy = state.crew.some((a) => !a.medbay && a.task && a.task.kind === 'lab' && a.task.id === m.id);
          ctx.fillStyle = '#dfe5ec'; ctx.beginPath(); ctx.roundRect(x + 6, y + 7, 28, 26, 3); ctx.fill(); ctx.strokeStyle = '#7f8b99'; ctx.lineWidth = 1.5; ctx.stroke();
          ctx.fillStyle = '#eef1f5'; ctx.fillRect(x + 10, y + 11, 20, 18); ctx.strokeStyle = '#9aa2af'; ctx.lineWidth = 1; ctx.strokeRect(x + 10, y + 11, 20, 18);
          LW.Shapes.flask(ctx, x + 18, y + 22, 1.1, busy ? '#6fd3ff' : '#6f7888');
          ctx.beginPath(); ctx.arc(x + 15, y + 14.5, 5.5, 0, Math.PI * 2); ctx.fillStyle = '#f2f4f7'; ctx.fill(); ctx.strokeStyle = '#7f8b99'; ctx.stroke(); // dish
          ctx.beginPath(); ctx.arc(x + 15, y + 14.5, 2.5, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = '#7f8b99'; ctx.beginPath(); ctx.arc(x + 15, y + 14.5, 1, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#9aa2af'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x + 23, y + 14); ctx.lineTo(x + 30, y + 14); ctx.stroke(); // sensor mast
          ctx.fillStyle = '#ff5d5d'; ctx.beginPath(); ctx.arc(x + 26.5, y + 14, 1.8, 0, Math.PI * 2); ctx.fill();
          if (busy && Math.random() < 0.12) spawn(2, x + 18 + (Math.random() - 0.5) * 4, y + 18, 0, -14, 1, '#bdf0ff');
          break;
        }
      }
      ctx.restore();

      // Research boost: small "2x" badge on machines that get an upgrade (close enough to a Research Bay).
      if (m.built && C.research.targets.includes(m.type)) {
        const b = LW.Sim.boostOf(state, m);
        if (b > 1) {
          ctx.fillStyle = 'rgba(10,14,22,0.85)'; ctx.beginPath(); ctx.roundRect(x + 2, y + 2, 20, 11, 3); ctx.fill();
          ctx.fillStyle = '#6fd3ff'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText(b + 'x', x + 12, y + 10.5);
        }
      }
      // Moondust on a solar panel (accident): brown speckles.
      if (m.built && m.type === 'solar' && m.dustLeft > 0) {
        ctx.fillStyle = 'rgba(140,110,70,0.45)'; ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
        ctx.fillStyle = 'rgba(190,160,110,0.9)';
        for (let i = 0; i < 9; i++) ctx.fillRect(x + 6 + ((i * 13 + m.id * 7) % (w - 12)), y + 6 + ((i * 7 + m.id * 3) % (h - 12)), 2, 2);
      }

      if (!m.built) {
        const work = C.modules[m.type].work;
        ctx.strokeStyle = '#ffd36b'; ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x + 4, y + h - 8, w - 8, 5);
        ctx.fillStyle = '#ffd36b'; ctx.fillRect(x + 4, y + h - 8, (w - 8) * (m.progress / work), 5);
      } else if (!m.on) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x, y, w, h);
        ctx.fillStyle = '#ccc'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.fillText('OFF', x + w / 2, y + h / 2 + 4);
      } else if (LW.Sim.needOf(state, m) > 0 && m.type !== 'solar' && !m.powered) {
        ctx.fillStyle = 'rgba(40,0,0,0.45)'; ctx.fillRect(x, y, w, h);
        if (blink) { ctx.font = '16px system-ui'; ctx.textAlign = 'center'; ctx.fillText('⚡', x + w - 9, y + 15); }
        ctx.strokeStyle = '#ff5d5d'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      } else if (m.noWater && blink) {
        ctx.font = '14px system-ui'; ctx.textAlign = 'center'; ctx.fillText('💧', x + w - 9, y + 14);
        ctx.strokeStyle = '#58c4ff'; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      }

      // Damage from storms or meteors: cracks + wrench. A planned repair shows its progress.
      if (m.built && m.damaged) {
        ctx.save();
        ctx.fillStyle = 'rgba(60,20,0,0.35)'; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(255,170,90,0.9)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(x + 6, y + 9); ctx.lineTo(x + 15, y + 17); ctx.lineTo(x + 12, y + 24); ctx.lineTo(x + 21, y + 31);
        ctx.moveTo(x + w - 7, y + h - 8); ctx.lineTo(x + w - 14, y + h - 15); ctx.stroke();
        ctx.font = '13px system-ui'; ctx.textAlign = 'center';
        if (!m.repair && blink) ctx.fillText('🔧', x + w - 9, y + 13);
        if (m.repair) {
          ctx.fillText('🔧', x + w - 9, y + 13);
          ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x + 4, y + h - 8, w - 8, 5);
          ctx.fillStyle = '#ff9f45'; ctx.fillRect(x + 4, y + h - 8, (w - 8) * (m.repair.progress / m.repair.work), 5);
        }
        ctx.restore();
      }
    }

    // Gerardo's construction mallet, swung by an Engineer standing at a building site (top-down).
    function drawBuildingHammer(a, m) {
      const x = a.x - 3, y = a.y - 8; // right-hand side of the left-facing astronaut
      const targetX = (m.c + m.w) * T - 1;
      const reach = x - targetX;
      const cycle = (motion.workTime() * 1.4 + a.id * 0.17) % 1;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI + Math.sin(cycle * Math.PI));
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(reach * 0.4, 0); ctx.stroke();
      ctx.fillStyle = '#b88750'; ctx.fillRect(reach * 0.3, -1.5, reach * 0.7, 3);
      ctx.fillStyle = '#c6d0dd'; ctx.fillRect(reach - 3, -5, 6, 10);
      ctx.strokeStyle = '#4a5566'; ctx.lineWidth = 0.6; ctx.strokeRect(reach - 3, -5, 6, 10);
      ctx.restore();
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
    // Meteors streak in from one direction (a shower's "radiant"), flash where they land and kick up dust.
    function spawnMeteors(dt) {
      const want = 9 * dt; // ~9 meteors per real second across the view
      let n = Math.floor(want) + (Math.random() < want % 1 ? 1 : 0);
      while (n-- > 0) {
        const sp = 380 + Math.random() * 260;
        const vx = -0.78 * sp, vy = 0.62 * sp; // from the upper right, falling down-left
        const life = 0.55 + Math.random() * 0.9;
        // land somewhere in (or just around) the view
        const lx = cam.x - 40 + Math.random() * (vw() + 80), ly = cam.y - 20 + Math.random() * (vh() + 40);
        spawn(3, lx - vx * life, ly - vy * life, vx, vy, life, Math.random() < 0.25 ? '#ffd6a0' : '#f2f6ff');
      }
    }

    // ---------- "back to base" tag on the edge of the view ----------
    function drawBaseTag(hc) {
      const sx = (hc.x - cam.x) * zoom, sy = (hc.y - cam.y) * zoom; // base position on screen
      tagRect = null;
      const L = safe.left, R = VW - safe.right, Tp = safe.top, B = VH - safe.bottom; // visible map area
      if (sx > L + 30 && sx < R - 30 && sy > Tp + 30 && sy < B - 30) return; // base is visible
      const ox = (L + R) / 2, oy = (Tp + B) / 2, dx = sx - ox, dy = sy - oy;
      const mx = Math.max(10, (R - L) / 2 - 64), my = Math.max(10, (B - Tp) / 2 - 26);
      const t = Math.min(mx / Math.max(1e-6, Math.abs(dx)), my / Math.max(1e-6, Math.abs(dy)));
      const px = ox + dx * t, py = oy + dy * t;
      const ang = Math.atan2(dy, dx);
      const dist = Math.round((Math.hypot(sx - VW / 2, sy - VH / 2) / zoom / T) * METERS_PER_TILE / 10) * 10;
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
      const hc = center(habM);
      const habCs = LW.Sim.habs(state).map(center);
      const nearestHab = (p) => habCs.reduce((b, h) => (Math.hypot(h.x - p.x, h.y - p.y) < Math.hypot(b.x - p.x, b.y - p.y) ? h : b), hc);


      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.fillStyle = '#0b0e15'; ctx.fillRect(0, 0, VW, VH);
      const S = DPR * zoom; // world pixels → device pixels
      ctx.setTransform(S, 0, 0, S, -Math.round(cam.x * S), -Math.round(cam.y * S));
      const VWz = vw(), VHz = vh(); // the part of the world on screen, in world pixels
      // only copy the part of the ground image the camera can see
      const gx = Math.max(0, Math.floor(cam.x)), gy = Math.max(0, Math.floor(cam.y));
      const gw = Math.min(W - gx, Math.ceil(VWz) + 2), gh = Math.min(H - gy, Math.ceil(VHz) + 2);
      if (gw > 0 && gh > 0) ctx.drawImage(ground, gx, gy, gw, gh, gx, gy, gw, gh);

      // Terrain shadow: each zone gets darker as the Sun slides behind the hills (smooth, follows game time).
      // Only the tiles the camera can see are drawn, so a big map stays fast.
      const c0 = Math.max(0, Math.floor(cam.x / T)), c1 = Math.min(C.map.cols - 1, Math.floor((cam.x + VWz) / T));
      const r0 = Math.max(0, Math.floor(cam.y / T)), r1 = Math.min(C.map.rows - 1, Math.floor((cam.y + VHz) / T));
      const shadeOf = {
        ridge: 0.75 * (1 - LW.Sim.zoneLight(state, 'ridge', state.hour + frac)),
        plain: 0.75 * (1 - LW.Sim.zoneLight(state, 'plain', state.hour + frac)),
        ice: 0.35,
      };
      for (const z of ['ridge', 'plain', 'ice']) {
        if (shadeOf[z] < 0.005) continue;
        ctx.fillStyle = z === 'ice' ? 'rgba(5,8,25,0.35)' : `rgba(5,8,20,${shadeOf[z].toFixed(3)})`;
        for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
          if (LW.Sim.zoneOf(state, c, r) === z) ctx.fillRect(c * T, r * T, T, T);
        }
      }

      // Object shadows point AWAY from the Sun. The Sun is always low at the pole, so shadows are long;
      // as the Sun sinks behind a hill they stretch and fade out.
      // Only draw what the camera can see (+ a margin for long shadows, labels and icons), so a big base stays fast.
      const MARGIN = 120, vx0 = cam.x - MARGIN, vy0 = cam.y - MARGIN, vx1 = cam.x + VWz + MARGIN, vy1 = cam.y + VHz + MARGIN;
      const onScreen = (m) => (m.c + m.w) * T >= vx0 && m.c * T <= vx1 && (m.r + m.h) * T >= vy0 && m.r * T <= vy1;
      const lineOnScreen = (a, b) => Math.max(a.x, b.x) >= vx0 && Math.min(a.x, b.x) <= vx1 && Math.max(a.y, b.y) >= vy0 && Math.min(a.y, b.y) <= vy1;
      const sv = sunVec(state);
      for (const m of state.modules) {
        if (!m.built || m.type === 'pad' || !onScreen(m)) continue; // (flat pads cast no shadow)
        const L = lightAt(state, m);
        if (L < 0.02) continue;
        const pad = m.type === 'hab' ? 10 : 8;
        const x0 = m.c * T + pad, y0 = m.r * T + pad, x1 = (m.c + m.w) * T - pad, y1 = (m.r + m.h) * T - pad;
        const len = (SHADOW_LEN[m.type] || 18) * (1 + (1 - L) * 1.5);
        const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]];
        const hp = hull(pts.concat(pts.map(([px, py]) => [px - sv.x * len, py - sv.y * len])));
        ctx.fillStyle = `rgba(0,0,0,${(0.28 * L).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(hp[0][0], hp[0][1]);
        for (let i = 1; i < hp.length; i++) ctx.lineTo(hp[i][0], hp[i][1]);
        ctx.closePath(); ctx.fill();
      }

      // power cables: yellow moving dashes = power flowing, red = no power
      ctx.lineWidth = 2;
      for (const m of state.modules) {
        if (!m.built || m === habM) continue; // (extra HABs get a cable to HAB 1)
        const c = center(m);
        let color, flow = 0;
        if (m.type === 'solar') { const on = m.light > 0.02 && m.on; color = on ? '#ffd36b' : '#4a4f5a'; flow = on ? 1 : 0; }
        else if (m.type === 'battery') {
          const charging = state.power.supply > state.power.use;
          color = state.res.battery > 0.01 || charging ? '#7de0a0' : '#4a4f5a'; flow = charging ? 1 : state.res.battery > 0.01 ? -1 : 0;
        } else if (m.type === 'shelter' || !LW.Sim.needOf(state, m)) { color = m.type === 'shelter' ? '#6b5b45' : '#5a6170'; } // walkways, no power cable
        else { color = !m.on ? '#4a4f5a' : m.powered ? '#ffd36b' : '#ff5d5d'; flow = m.on && m.powered ? -1 : 0; }
        ctx.strokeStyle = color;
        ctx.setLineDash(flow ? [6, 6] : (m.type === 'shelter' || !LW.Sim.needOf(state, m)) ? [2, 4] : [3, 5]);
        ctx.lineDashOffset = flow * dashOffset;
        const to = m.type === 'hab' ? hc : nearestHab(c);
        if (!lineOnScreen(c, to)) continue; // a cable can cross the screen even if both ends are off it
        ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      }
      ctx.setLineDash([]); ctx.lineDashOffset = 0;

      for (const m of state.modules) if (onScreen(m)) drawModule(state, m, blink);

      // Research Bay reach (dashed circle): while placing one, hovering one, or with the Scientist picked.
      const picked = ui.selectedCrew ? state.crew.find((a) => a.id === ui.selectedCrew && !a.medbay) : null;
      const hoverM = ui.hover && !ui.buildType ? LW.Sim.moduleAt(state, ui.hover.c, ui.hover.r) : null;
      const rings = [];
      if (ui.buildType === 'lab' && ui.hover) rings.push({ x: (ui.hover.c + 0.5) * T, y: (ui.hover.r + 0.5) * T });
      for (const l of LW.Sim.built(state, 'lab')) {
        if ((picked && picked.role === 'scientist') || hoverM === l || (hoverM && C.research.targets.includes(hoverM.type))) rings.push({ ...center(l), dead: l.damaged });
      }
      // Placing a Landing Pad: gold circles show how close to a HAB it must be.
      if (ui.buildType === 'pad') {
        ctx.setLineDash([8, 6]); ctx.lineDashOffset = dashOffset * 0.5; ctx.lineWidth = 2;
        for (const H of state.modules) if (H.type === 'hab') {
          const c = center(H);
          ctx.beginPath(); ctx.arc(c.x, c.y, C.pad.radius * T, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,211,107,0.06)'; ctx.fill(); ctx.strokeStyle = 'rgba(255,211,107,0.8)'; ctx.stroke();
        }
        // Red circles: no new pad may go inside another pad's area.
        for (const P2 of state.modules) if (P2.type === 'pad') {
          const c = center(P2);
          ctx.beginPath(); ctx.arc(c.x, c.y, C.pad.radius * T, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,93,93,0.07)'; ctx.fill(); ctx.strokeStyle = 'rgba(255,93,93,0.8)'; ctx.stroke();
        }
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      for (const g of rings) {
        ctx.beginPath(); ctx.arc(g.x, g.y, C.research.radius * T, 0, Math.PI * 2);
        ctx.fillStyle = g.dead ? 'rgba(255,93,93,0.04)' : 'rgba(111,211,255,0.06)'; ctx.fill();
        ctx.setLineDash([8, 6]); ctx.lineDashOffset = dashOffset * 0.5;
        ctx.strokeStyle = g.dead ? 'rgba(255,93,93,0.6)' : 'rgba(111,211,255,0.75)'; ctx.lineWidth = 2; ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      // The picked Engineer's job sites get a dashed outline in their role colour.
      const jobs = LW.Sim.jobList(state);
      if (picked) {
        ctx.strokeStyle = C.astro.roleInfo[picked.role].color; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
        for (const j of jobs) if (j.assignee === picked.id) {
          const m = j.m || habM;
          ctx.strokeRect(m.c * T - 2, m.r * T - 2, m.w * T + 4, m.h * T + 4);
        }
        ctx.setLineDash([]);
      }

      drawRover(state);

      // astronauts: where they stand comes from the shared crew motion (js/crew_motion.js, grid squares),
      // so they keep walking from the same spot when the player switches views.
      if (ownMotion) motion.update(state, dt, ui.paused, ui.frac);
      const danger = state.stormRate > C.rad.stormOn || !!state.meteorOn;
      for (const k in crew) crew[k].shown = false; // astronauts sent home to Earth are no longer in state.crew
      state.crew.forEach((A) => {
        const p = motion.get(A.id);
        if (!p || A.trip) return; // inside the rover (they appear at the new HAB when it arrives)
        const a = crew[A.id] || (crew[A.id] = { x: 0, y: 0, dir: -Math.PI / 2 });
        a.x = p.c * T; a.y = p.r * T; a.dir = p.dir; // grid squares -> world pixels; dir = way the visor faces
        // Hammering a building site: face the building. The top-down mallet needs a bit more room than the
        // shared spot (8 px from the wall), so slide out to 15 px, eased in as they stop walking (no jump).
        const building = p.building ? state.modules.find((m) => m.id === p.building) : null;
        if (building) {
          a.x += (15 - 0.2 * T) * (1 - p.walk);
          const target = center(building);
          a.dir = Math.atan2(target.y - a.y, target.x - a.x);
        }
        const sel = picked === A;
        a.id = A.id;
        a.shown = !A.medbay && (p.visible || p.dist * T >= 1 || sel); // the picked astronaut is always shown, even inside
        if (!a.shown) return; // inside the habitat (or medbay): hidden
        const exposed = LW.Sim.isExposed(A);
        if (sel) { // picked: pulsing gold ring
          ctx.beginPath(); ctx.arc(a.x, a.y, 10 + Math.sin(time * 5) * 1.5, 0, Math.PI * 2);
          ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 2; ctx.stroke();
        }
        // helmet seen from above, with the blue visor on the side they are walking towards
        ctx.save(); ctx.translate(a.x, a.y); ctx.rotate(a.dir);
        ctx.beginPath(); ctx.arc(0, 0, 5.5, 0, Math.PI * 2);
        ctx.fillStyle = exposed && danger && blink ? '#ff5d5d' : LW.Sim.isSlow(A) ? '#ffc04d' : '#ffffff'; ctx.fill();
        // visor: a rounded window on the front half, with a white rim of helmet left around it
        ctx.save(); ctx.beginPath(); ctx.arc(0, 0, 4.7, 0, Math.PI * 2); ctx.clip();
        ctx.fillStyle = VISOR; ctx.beginPath(); ctx.roundRect(0.9, -3.9, 4.4, 7.8, 1.5); ctx.fill(); ctx.restore();
        ctx.beginPath(); ctx.arc(0, 0, 5.5, 0, Math.PI * 2); // the helmet outline again (the visor path replaced it)
        ctx.strokeStyle = SUIT_LINE; ctx.lineWidth = 1; ctx.stroke();
        ctx.restore();
        if (building) drawBuildingHammer(a, building);
        // number tag (border = role colour) so you can match the astronaut to the AMS list
        ctx.fillStyle = 'rgba(10,14,22,0.85)'; ctx.beginPath(); ctx.roundRect(a.x - 6, a.y - 17, 12, 10, 3); ctx.fill();
        ctx.strokeStyle = C.astro.roleInfo[A.role].color; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#ffd36b'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText(String(A.id), a.x, a.y - 9.5);
      });

      // The crew spaceship (js/ship.js), seen from straight above, coming down onto its Landing Pad. It is drawn
      // on the map, so it lands on the pad wherever the camera is.
      const ship = ui.ship;
      if (ship) {
        const pad = state.modules.find((m) => m.id === ship.padId), L = pad ? lightAt(state, pad) : 1;
        const len = 40 * (1 + (1 - L) * 1.5); // as tall as the HAB's shadow, longer as the Sun gets low
        LW.Ship.drawFlat(ctx, ship.c * T, ship.r * T, ship, { dx: -sv.x * len, dy: -sv.y * len, light: L }, time);
        shipDust(ship, ship.c * T, ship.r * T, 1);
      }

      // radiation storm particles stream in from the Sun's direction, across what the camera sees
      if (state.stormRate > C.rad.stormOn) {
        const n = Math.min(6, state.stormRate * 0.6 + 0.5);
        const vx = cam.x + VWz / 2, vy = cam.y + VHz / 2;
        for (let k = 0; k < n; k++) {
          if (Math.random() > 0.5) continue;
          const perp = (Math.random() - 0.5) * 1.6 * VWz;
          const sx = vx + sv.x * VWz * 0.65 - sv.y * perp, sy = vy + sv.y * VWz * 0.65 + sv.x * perp;
          const sp = 500 + Math.random() * 300;
          spawn(0, sx, sy, -sv.x * sp, -sv.y * sp, 2.2, Math.random() < 0.5 ? 'rgba(255,90,90,0.7)' : 'rgba(255,220,120,0.7)');
        }
      }
      if (state.meteorOn) spawnMeteors(dt);
      for (const p of pool) {
        if (!p.alive) continue;
        p.life += dt;
        if (p.life >= p.max) {
          p.alive = false;
          if (p.kind === 3) { // meteor lands: flash ring + a puff of moon dust
            spawn(4, p.x, p.y, 0, 0, 0.55, p.color);
            for (let k = 0; k < 5; k++) spawn(1, p.x, p.y, (Math.random() - 0.5) * 60, -Math.random() * 40, 0.7, 'rgba(200,200,205,0.8)');
          }
          continue;
        }
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.kind === 0) {
          ctx.strokeStyle = p.color; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03); ctx.stroke();
        } else if (p.kind === 3) { // meteor: bright head with a fading tail
          const tx = p.x - p.vx * 0.12, ty = p.y - p.vy * 0.12;
          const grad = ctx.createLinearGradient(p.x, p.y, tx, ty);
          grad.addColorStop(0, p.color); grad.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.strokeStyle = grad; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(tx, ty); ctx.stroke(); ctx.lineCap = 'butt';
          ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2); ctx.fill();
        } else if (p.kind === 4) { // impact flash
          const t = p.life / p.max;
          ctx.globalAlpha = 1 - t;
          ctx.strokeStyle = '#ffe2b0'; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(p.x, p.y, 3 + t * 16, 0, Math.PI * 2); ctx.stroke();
          if (t < 0.25) { ctx.fillStyle = '#fff6e0'; ctx.beginPath(); ctx.arc(p.x, p.y, 5 * (1 - t * 4), 0, Math.PI * 2); ctx.fill(); }
          ctx.globalAlpha = 1;
        } else {
          ctx.globalAlpha = 1 - p.life / p.max;
          ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(p.x, p.y, p.kind === 1 ? 2 : 1.6, 0, Math.PI * 2); ctx.fill();
          ctx.globalAlpha = 1;
        }
      }

      // hover / build ghost
      if (ui.hover && !ui.dragging) {
        const { c, r } = ui.hover;
        if (ui.buildType) {
          const d = C.modules[ui.buildType];
          const ok = LW.Sim.canPlace(state, ui.buildType, c, r).ok;
          ctx.fillStyle = ok ? 'rgba(95,224,138,0.25)' : 'rgba(255,93,93,0.25)';
          ctx.fillRect(c * T, r * T, d.w * T, d.h * T);
          ctx.strokeStyle = ok ? '#5fe08a' : '#ff5d5d'; ctx.lineWidth = 2; ctx.strokeRect(c * T + 1, r * T + 1, d.w * T - 2, d.h * T - 2);
          ctx.font = '20px system-ui'; ctx.textAlign = 'center'; ctx.fillText(d.icon, c * T + T / 2, r * T + T / 2 + 7);
        } else {
          const m = LW.Sim.moduleAt(state, c, r);
          ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5;
          if (m) ctx.strokeRect(m.c * T + 1, m.r * T + 1, m.w * T - 2, m.h * T - 2);
          else ctx.strokeRect(c * T + 1, r * T + 1, T - 2, T - 2);
        }
      }

      if (ship) LW.Ship.label(ctx, ship.c * T, ship.r * T - 58, ship.text, ship.label, zoom); // "Your crew has landed!", above the pad

      // screen-space overlays
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      if (state.stormRate > C.rad.stormOn) { ctx.fillStyle = `rgba(255,40,40,${Math.min(0.14, state.stormRate * 0.01)})`; ctx.fillRect(0, 0, VW, VH); }
      if (state.meteorOn) { ctx.fillStyle = 'rgba(40,20,70,0.12)'; ctx.fillRect(0, 0, VW, VH); }
      drawBaseTag(hc);
    }

    // ---------- the rover (TEMPORARY model: a box on 4 wheels, to be replaced with better art later) ----------
    // Parked next to its HAB; while driving it moves smoothly from one HAB to the other.
    function roverAt(state) {
      const p = LW.Sim.roverPosition(state, frac);
      return p ? { x: p.c * T, y: p.r * T, ang: Math.atan2(p.dir.r, p.dir.c), moving: p.moving, riders: p.riders } : null;
    }
    function drawRover(state) {
      const p = roverAt(state);
      if (!p) return;
      if (p.moving && Math.random() < 0.5) spawn(1, p.x - Math.cos(p.ang) * 9, p.y - Math.sin(p.ang) * 9, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 0.6, 'rgba(200,200,205,0.7)');
      ctx.save();
      ctx.translate(p.x, p.y); ctx.rotate(p.ang);
      ctx.fillStyle = '#2b2f36';
      for (const [wx, wy] of [[-6, -6], [3, -6], [-6, 4], [3, 4]]) ctx.fillRect(wx, wy, 4, 2.5); // wheels
      ctx.fillStyle = '#e8c547'; ctx.fillRect(-7, -4, 14, 8); // body
      ctx.fillStyle = '#7fd0ff'; ctx.fillRect(2, -3, 4, 6);    // window
      ctx.strokeStyle = '#c9d1dc'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(-5, -4); ctx.lineTo(-7, -9); ctx.stroke(); // antenna
      ctx.restore();
      if (p.riders) { ctx.fillStyle = '#ffd36b'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText('👩‍🚀' + p.riders, p.x, p.y - 10); }
    }

    // ---------- sunlight forecast strip (redrawn once per game hour) ----------
    // Slim version that lives in the top bar: two 11-px rows + day labels, 40 px tall in total.
    // The game is endless, so the strip shows a 30-day window: 3 days back, the rest ahead.
    function drawForecast(state) {
      const cw = forecastCanvas.width, ch = forecastCanvas.height, left = 70, w = cw - left - 8, total = C.chunkH;
      const ws = Math.max(0, state.hour - 72), X = (h) => left + ((h - ws) / total) * w; // window start, hour → x
      fctx.clearRect(0, 0, cw, ch);
      const rows = [['ridge', 'High ground'], ['plain', 'Plain']];
      const dark = [44, 52, 69], sun = [255, 211, 107];
      const rowH = 11, top = 2, gap = 2;
      rows.forEach(([z, label], i) => {
        const y = top + i * (rowH + gap);
        fctx.fillStyle = '#c9d1dc'; fctx.font = '10px system-ui'; fctx.textAlign = 'left'; fctx.fillText(label, 2, y + 9);
        for (let h = ws; h < ws + total; h++) {
          let c = mix(dark, sun, LW.Sim.zoneLight(state, z, h + 0.5));
          if (h < state.hour) c = mix(c, [16, 20, 28], 0.5); // the past is dimmed
          fctx.fillStyle = rgb(c);
          fctx.fillRect(X(h), y, w / total + 0.6, rowH);
        }
      });
      const rowsBottom = top + 2 * rowH + gap;
      fctx.fillStyle = '#8b93a1'; fctx.font = '9px system-ui'; fctx.textAlign = 'center';
      for (let d = Math.ceil(ws / 24 / 5) * 5; d * 24 <= ws + total; d += 5) {
        const x = X(d * 24);
        fctx.fillRect(x, rowsBottom + 1, 1, 3);
        if (d) fctx.fillText('Day ' + d, Math.min(Math.max(x, left + 14), cw - 18), ch - 3);
      }
      const inWin = (h) => h >= ws && h < ws + total;
      for (const s of state.storms) if (s.warned && inWin(s.h)) {
        fctx.fillStyle = '#ff5d5d'; fctx.fillRect(X(s.h) - 1, top, 2, rowsBottom - top);
      }
      for (const s of state.meteors || []) if (s.warned && inWin(s.h)) { // meteor showers: purple band once forecast
        fctx.fillStyle = 'rgba(190,140,255,0.85)';
        fctx.fillRect(X(s.h), top, Math.max(2, (s.dur / total) * w), rowsBottom - top);
      }
      for (const s of state.ships || []) if (s.warned && inWin(s.h)) { // crew spaceship: gold marker
        fctx.fillStyle = '#ffd36b'; fctx.fillRect(X(s.h) - 1.5, top, 3, rowsBottom - top);
      }
      const nx = X(state.hour);
      fctx.fillStyle = '#ffffff';
      fctx.fillRect(nx - 0.5, top, 1.5, rowsBottom - top);
      fctx.beginPath(); fctx.moveTo(nx, rowsBottom); fctx.lineTo(nx - 4, rowsBottom + 6); fctx.lineTo(nx + 4, rowsBottom + 6); fctx.fill();
    }

    // New game. The ground picture is kept: the terrain is the same in every game (it comes from the config),
    // and painting it again takes long enough to freeze the game. Call rebuildGround() if the map ever changes.
    function reset() { tagRect = null; zoom = 1; needCenter = true; crew = {}; if (ownMotion) motion.reset(); for (const p of pool) p.alive = false; }
    function rebuildGround() { ground = null; }
    /** Paint the ground picture now (if not done yet), so showing this view later does not freeze the game. */
    function prepare(state) { if (!ground && state) buildGround(state); }
    /** The astronaut drawn under the mouse (id), or null. */
    function crewAt(evt) {
      const p = toCanvas(evt), wx = cam.x + p.x / zoom, wy = cam.y + p.y / zoom; // mouse → world pixels
      let best = null, bd = 11;
      for (const a of Object.values(crew)) {
        if (!a.shown) continue;
        const d = Math.min(Math.hypot(a.x - wx, a.y - wy), Math.hypot(a.x - wx, a.y - 12 - wy)); // the dot or its number tag
        if (d < bd) { bd = d; best = a.id; }
      }
      return best;
    }

    return {
      draw, drawForecast, tileAt, toCanvas, hitTag, crewAt, reset, rebuildGround, prepare, centerOnBase, centerOnTile, screenOf, resize, setSafeArea, zoomAt,
      panStart: () => ({ x: cam.x, y: cam.y }),
      debug: () => ({ cam: { ...cam }, zoom, tag: tagRect, view: [VW, VH], world: [W, H] }),
      panTo: (x, y) => moveTo(x, y),
    };
  }

  LW.Renderer = Renderer;
})(window);
