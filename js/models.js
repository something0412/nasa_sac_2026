// Building models for the 2.5D view, in the "Clean NASA" style: white modules, gold foil, crisp outlines.
// Every building is put together from a few simple 3D shapes (box, cylinder, dome...). Each face is lit by
// the low south-pole Sun, so the sunny side of the base slowly moves around as the Sun circles the horizon.
//
// Positions: c, r = grid squares (fractions allowed, like the game rules use), z = height above the ground.
// 1 unit of height = VZ world pixels (half a square's width), so a 1-unit box is about as tall as it is wide.
//
// render_iso.js draws the ground, cables, astronauts and effects; this file only draws the buildings.
(function (root) {
  'use strict';
  const MT = (root.MT = root.MT || {});

  const VZ = 32;
  // REAL: at the lunar south pole the Sun never climbs more than ~1.5° above the horizon.
  // GAME: we use 10° so walls facing away from the Sun still look like walls, not black holes.
  const SUN_ELEVATION = (10 * Math.PI) / 180;

  // ---------- the Clean NASA palette ----------
  const PALETTE = {
    hull: '#eef1f5',      // white module skin
    trim: '#b8c0cb',      // light grey frames, end caps, bases
    metal: '#8f98a6',     // legs, masts, pipes
    dark: '#3b424e',      // battery casing
    foil: '#d9a93a',      // gold insulation foil (like on real spacecraft)
    accent: '#e8742a',    // orange safety marks
    panel: '#2f63c2',     // solar cells
    panelBack: '#5b6270', // back of a solar panel
    regolith: '#8a7558',  // moon dirt piled up as a radiation shield
    sandbag: '#9c8768',   // bags of moon dirt
    soil: '#4a2c44',      // greenhouse growing beds (lit by pink LEDs)
    window: '#ffd36b',    // warm, heated
    windowCold: '#7fb4ff',// cold inside
    windowOff: '#262c36', // no power
    glassDark: '#1d2533', // window glass seen from outside with the lights off
    water: '#58c4ff',
    ok: '#5fe08a', warn: '#ffc04d', bad: '#ff5d5d',
    glass: [255, 150, 225], glassOff: [150, 160, 175],
    outline: 'rgba(20,26,38,0.45)',
    seam: 'rgba(20,26,38,0.22)',
    scaffold: '#ffd36b',
  };

  // How tall each building is (height units). Used for shadows and for where status badges go.
  const HEIGHT = { hab: 1.35, solar: 1.8, battery: 0.6, o2gen: 0.9, greenhouse: 0.5, drill: 1.5, shelter: 0.65, gym: 0.75, tower: 1.15 };
  const height = (type) => HEIGHT[type] || 0.6;

  // ---------- light ----------
  // Direction the sunlight comes FROM, as (c, r, up). Same azimuth the game rules use (MT.Sim.sunAz).
  function sunVector(azDeg) {
    const a = (azDeg * Math.PI) / 180;
    return [Math.cos(a) * Math.cos(SUN_ELEVATION), Math.sin(a) * Math.cos(SUN_ELEVATION), Math.sin(SUN_ELEVATION)];
  }
  // The camera looks from the +c, +r side and from above, so a face is seen when its normal points that way.
  const facesCamera = (n) => n[0] + n[1] + n[2] > 1e-6;
  // How bright a face is (about 0.3 to 1.1). n = the face's direction, L = how much sunlight reaches the spot (0..1).
  function brightness(n, sun, L) {
    const amb = 0.36 + 0.1 * L;
    const d = Math.max(0, n[0] * sun[0] + n[1] * sun[1] + n[2] * sun[2]);
    return amb + (1 - amb) * d * L + 0.12 * Math.max(0, n[2]);
  }

  const rgbCache = {};
  const toRGB = (c) => (Array.isArray(c) ? c : rgbCache[c] || (rgbCache[c] = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]));
  const ch = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const clamp01 = (v) => Math.max(0, Math.min(1, v || 0));
  const mixRGB = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  // the part of a circle the camera can see on a cylinder or ring: from -45° to 135°
  const FRONT_FROM = -Math.PI / 4, FRONT_TO = (3 * Math.PI) / 4;

  function hull(pts) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }

  // ---------- the toolkit: 3D shapes drawn on the 2.5D map ----------
  // ctx = canvas, P(c, r) = grid point → world pixel (from js/iso.js).
  function Toolkit(ctx, P) {
    let sun = sunVector(45), L = 1, dimK = 1;
    const NONE = {};
    const P3 = (c, r, z) => { const p = P(c, r); return { x: p.x, y: p.y - (z || 0) * VZ }; };

    // sun = from sunVector(), light = sunlight at this building (0..1), dim < 1 makes it darker (e.g. switched off)
    function setLight(sunVec, light, dim) { sun = sunVec; L = clamp01(light); dimK = dim == null ? 1 : dim; }

    function path(pts) {
      ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    }
    // One flat face. pts3 = corners [c, r, z], n = which way it faces. Options: alpha, flat (no sun shading),
    // force (draw even if it faces away), noLine (no outline).
    function face(pts3, n, color, opt) {
      const o = opt || NONE;
      if (!o.force && !facesCamera(n)) return;
      path(pts3.map((p) => P3(p[0], p[1], p[2])));
      const c = toRGB(color), k = (o.flat ? 1 : brightness(n, sun, L)) * dimK;
      ctx.fillStyle = `rgba(${ch(c[0] * k)},${ch(c[1] * k)},${ch(c[2] * k)},${o.alpha == null ? 1 : o.alpha})`;
      ctx.fill();
      if (!o.noLine) { ctx.strokeStyle = PALETTE.outline; ctx.lineWidth = 1; ctx.lineJoin = 'round'; ctx.stroke(); }
    }
    function outline(pts3) { // stroke around a round shape (its outer edge on screen)
      const hp = hull(pts3.map((p) => { const q = P3(p[0], p[1], p[2]); return [q.x, q.y]; }));
      ctx.beginPath(); ctx.moveTo(hp[0][0], hp[0][1]);
      for (let i = 1; i < hp.length; i++) ctx.lineTo(hp[i][0], hp[i][1]);
      ctx.closePath(); ctx.strokeStyle = PALETTE.outline; ctx.lineWidth = 1; ctx.stroke();
    }
    function polyline(pts3, color, w) {
      ctx.strokeStyle = color; ctx.lineWidth = w || 1; ctx.lineJoin = 'round';
      ctx.beginPath();
      pts3.forEach((p, i) => { const q = P3(p[0], p[1], p[2]); i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); });
      ctx.stroke();
    }

    // Box: corner (c0, r0, z0), size (dc, dr, dz). Only the 3 faces the camera can see are drawn.
    function box(c0, r0, z0, dc, dr, dz, color, opt) {
      const c1 = c0 + dc, r1 = r0 + dr, z1 = z0 + dz;
      face([[c1, r0, z0], [c1, r1, z0], [c1, r1, z1], [c1, r0, z1]], [1, 0, 0], color, opt);
      face([[c0, r1, z0], [c1, r1, z0], [c1, r1, z1], [c0, r1, z1]], [0, 1, 0], color, opt);
      face([[c0, r0, z1], [c1, r0, z1], [c1, r1, z1], [c0, r1, z1]], [0, 0, 1], color, opt);
    }

    // Cylinder lying along the c direction (like an Artemis habitat module). Its axis is at (rc, zc).
    // Options: from/to (part of the circle, in radians; 0 = facing +r, π/2 = up), back (draw the far half, for glass),
    // capColor, noCap, noOutline, alpha.
    function cylC(c0, c1, rc, zc, R, color, opt) {
      const o = opt || NONE, N = 24, a0 = o.from == null ? 0 : o.from, a1 = o.to == null ? Math.PI * 2 : o.to;
      const at = (c, t) => [c, rc + R * Math.cos(t), zc + R * Math.sin(t)];
      const strip = { alpha: o.alpha, noLine: true, force: !!o.back };
      for (let i = 0; i < N; i++) {
        const t0 = a0 + ((a1 - a0) * i) / N, t1 = a0 + ((a1 - a0) * (i + 1)) / N, tm = (t0 + t1) / 2;
        const n = [0, Math.cos(tm), Math.sin(tm)];
        if (o.back ? facesCamera(n) : !facesCamera(n)) continue;
        face([at(c0, t0), at(c1, t0), at(c1, t1), at(c0, t1)], n, color, strip);
      }
      if (o.back) return;
      const cap = [];
      for (let i = 0; i <= N; i++) cap.push(at(c1, a0 + ((a1 - a0) * i) / N));
      if (!o.noCap) face(cap, [1, 0, 0], o.capColor || color, { alpha: o.alpha });
      if (!o.noOutline) {
        const all = [];
        for (let i = 0; i <= N; i++) { const t = a0 + ((a1 - a0) * i) / N; all.push(at(c0, t), at(c1, t)); }
        outline(all);
      }
    }
    // A thin line wrapped around a lying cylinder at position c (panel seams, bands).
    function ringC(c, rc, zc, R, color, w) {
      const pts = [];
      for (let i = 0; i <= 12; i++) { const t = FRONT_FROM + ((FRONT_TO - FRONT_FROM) * i) / 12; pts.push([c, rc + R * Math.cos(t), zc + R * Math.sin(t)]); }
      polyline(pts, color, w);
    }

    // Upright cylinder (tanks, masts). Options: noTop, noOutline, alpha.
    function cylZ(cc, rc, z0, h, R, color, opt) {
      const o = opt || NONE, N = 18, at = (t, z) => [cc + R * Math.cos(t), rc + R * Math.sin(t), z];
      for (let i = 0; i < N; i++) {
        const t0 = (Math.PI * 2 * i) / N, t1 = (Math.PI * 2 * (i + 1)) / N, tm = (t0 + t1) / 2;
        const n = [Math.cos(tm), Math.sin(tm), 0];
        if (!facesCamera(n)) continue;
        face([at(t0, z0), at(t1, z0), at(t1, z0 + h), at(t0, z0 + h)], n, color, { alpha: o.alpha, noLine: true });
      }
      const top = [], all = [];
      for (let i = 0; i < N; i++) { const t = (Math.PI * 2 * i) / N; top.push(at(t, z0 + h)); all.push(at(t, z0), at(t, z0 + h)); }
      if (!o.noTop) face(top, [0, 0, 1], o.topColor || color, { alpha: o.alpha, noLine: true });
      if (!o.noOutline) outline(all);
    }
    // A thin line around an upright cylinder at height z (bands, railings).
    function ringZ(cc, rc, z, R, color, w) {
      const pts = [];
      for (let i = 0; i <= 12; i++) { const t = FRONT_FROM + ((FRONT_TO - FRONT_FROM) * i) / 12; pts.push([cc + R * Math.cos(t), rc + R * Math.sin(t), z]); }
      polyline(pts, color, w);
    }
    // A flat round plate (decks, fan covers).
    function disc(cc, rc, z, R, color, opt) {
      const pts = [];
      for (let i = 0; i < 20; i++) { const t = (Math.PI * 2 * i) / 20; pts.push([cc + R * Math.cos(t), rc + R * Math.sin(t), z]); }
      face(pts, [0, 0, 1], color, opt);
    }
    // A rectangle on the front of an upright cylinder, facing the camera (doors, level windows).
    function cylPanel(cc, rc, R, z0, z1, halfAngle, color, opt) {
      const a0 = Math.PI / 4 - halfAngle, a1 = Math.PI / 4 + halfAngle, Rr = R + 0.006;
      const pt = (a, z) => [cc + Rr * Math.cos(a), rc + Rr * Math.sin(a), z];
      face([pt(a0, z0), pt(a1, z0), pt(a1, z1), pt(a0, z1)], [Math.SQRT1_2, Math.SQRT1_2, 0], color, { flat: true, noLine: true, ...(opt || NONE) });
    }

    // Dome (half a ball) sitting at height z0. Option zs < 1 squashes it (a low mound of moon dirt).
    function dome(cc, rc, z0, R, color, opt) {
      const o = opt || NONE, zs = o.zs || 1, LAT = 5, LON = 16, all = [];
      const pt = (la, lo) => [cc + R * Math.cos(la) * Math.cos(lo), rc + R * Math.cos(la) * Math.sin(lo), z0 + R * zs * Math.sin(la)];
      for (let i = 0; i < LAT; i++) for (let j = 0; j < LON; j++) {
        const la0 = (Math.PI / 2) * (i / LAT), la1 = (Math.PI / 2) * ((i + 1) / LAT);
        const lo0 = (Math.PI * 2 * j) / LON, lo1 = (Math.PI * 2 * (j + 1)) / LON;
        const lm = (la0 + la1) / 2, om = (lo0 + lo1) / 2;
        const nx = Math.cos(lm) * Math.cos(om), ny = Math.cos(lm) * Math.sin(om), nz = Math.sin(lm) / zs, nl = Math.hypot(nx, ny, nz);
        face([pt(la0, lo0), pt(la0, lo1), pt(la1, lo1), pt(la1, lo0)], [nx / nl, ny / nl, nz / nl], color, { alpha: o.alpha, noLine: true });
        if (i === 0) all.push(pt(0, lo0));
      }
      all.push(pt(Math.PI / 2, 0));
      for (let j = 0; j < LON; j++) all.push(pt(Math.PI / 4, (Math.PI * 2 * j) / LON));
      if (!o.noOutline) outline(all);
    }
    // A line running over a dome from its rim to near its top, at angle lon (panel seams).
    function domeSeam(cc, rc, z0, R, lon, color, w) {
      const pts = [];
      for (let j = 0; j <= 8; j++) { const la = (1.45 * j) / 8; pts.push([cc + R * Math.cos(la) * Math.cos(lon), rc + R * Math.cos(la) * Math.sin(lon), z0 + R * Math.sin(la)]); }
      polyline(pts, color, w);
    }

    function line3(a, b, color, w) {
      const p = P3(a[0], a[1], a[2]), q = P3(b[0], b[1], b[2]);
      ctx.strokeStyle = color; ctx.lineWidth = w || 1; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      ctx.lineCap = 'butt';
    }
    function glow(c, r, z, color, radius) {
      const p = P3(c, r, z), g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, radius);
      g.addColorStop(0, color); g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill();
    }
    function dot(c, r, z, color, radius) {
      const p = P3(c, r, z);
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(p.x, p.y, radius, 0, Math.PI * 2); ctx.fill();
    }
    // A coloured rectangle painted flat onto a wall that faces +c (side 'c') or +r (side 'r').
    function decal(side, at, a0, a1, z0, z1, color, alpha) {
      const pts = side === 'c' ? [[at, a0, z0], [at, a1, z0], [at, a1, z1], [at, a0, z1]] : [[a0, at, z0], [a1, at, z0], [a1, at, z1], [a0, at, z1]];
      face(pts, side === 'c' ? [1, 0, 0] : [0, 1, 0], color, { flat: true, noLine: true, force: true, alpha });
    }
    // Yellow and black safety stripes along the bottom of a wall.
    function hazard(side, at, a0, a1, z0, z1) {
      const n = Math.max(2, Math.round((a1 - a0) / 0.07));
      for (let i = 0; i < n; i++) decal(side, at, a0 + ((a1 - a0) * i) / n, a0 + ((a1 - a0) * (i + 1)) / n, z0, z1, i % 2 ? '#22262d' : '#f2c230');
    }
    // Level window on the front of an upright tank: dark slot, filled up to `frac` with colour.
    function tankLevel(cc, rc, R, z0, z1, frac, color) {
      cylPanel(cc, rc, R, z0, z1, 0.38, '#1e2530');
      const zf = z0 + (z1 - z0) * clamp01(frac);
      if (frac > 0.01) cylPanel(cc, rc, R + 0.002, z0, zf, 0.38, color);
    }

    return { ctx, P3, setLight, face, polyline, box, cylC, ringC, cylZ, ringZ, disc, cylPanel, dome, domeSeam, line3, glow, dot, decal, hazard, tankLevel };
  }

  // ---------- the buildings ----------
  // Each model gets k = toolkit, m = the building (c, r, w, h, on, powered, damaged...), e = what it needs to know:
  //   e.state, e.t (seconds, for animation), e.blink, e.sun, e.L (sunlight here), e.on (built + on + powered),
  //   e.charge (battery 0..1), e.water (water tank 0..1), e.growth (plants 0..1), e.training (gym in use),
  //   e.spawn(kind, x, y, vx, vy, life, color) for little particles (1 = dust, 2 = vapour).
  const MODELS = {
    // HABITAT: an Artemis-style cylinder module on legs, with an airlock, portholes, a radiator and an antenna.
    hab(k, m, e) {
      const C = MT.CONFIG, s = e.state, ctx = k.ctx;
      const R = 0.52, c0 = m.c + 0.22, c1 = m.c + 1.56, rc = m.r + 1, zc = R + 0.12;
      for (const c of [c0 + 0.28, c1 - 0.28]) for (const d of [-0.3, 0.3]) { // landing legs with foot pads
        k.line3([c, rc + d * 1.25, 0.03], [c, rc + d * 0.6, zc - R * 0.6], PALETTE.metal, 2);
        k.box(c - 0.07, rc + d * 1.25 - 0.07, 0, 0.14, 0.14, 0.03, PALETTE.trim);
      }
      k.cylC(c0, c1, rc, zc, R, PALETTE.hull, { capColor: PALETTE.trim });
      for (const c of [c0 + 0.3, c0 + 1.0, c1 - 0.1]) k.ringC(c, rc, zc, R + 0.004, PALETTE.seam, 1); // panel seams
      k.cylC(c0 + 0.52, c0 + 0.68, rc, zc, R + 0.012, PALETTE.foil, { noCap: true, noOutline: true });
      // handrail along the top (astronauts hold it during spacewalk-style repairs)
      const tR = 1.2, rail = [], posts = [];
      for (let i = 0; i <= 4; i++) {
        const c = c0 + 0.15 + ((c1 - c0 - 0.3) * i) / 4;
        rail.push([c, rc + (R + 0.07) * Math.cos(tR), zc + (R + 0.07) * Math.sin(tR)]);
        posts.push([[c, rc + R * Math.cos(tR), zc + R * Math.sin(tR)], rail[i]]);
      }
      // radiator panel on top: gets rid of the habitat's extra heat
      const rz = zc + R + 0.1;
      k.line3([c0 + 0.85, rc - 0.05, zc + R - 0.02], [c0 + 0.85, rc - 0.05, rz], PALETTE.metal, 1.5);
      k.line3([c0 + 1.2, rc - 0.05, zc + R - 0.02], [c0 + 1.2, rc - 0.05, rz], PALETTE.metal, 1.5);
      k.box(c0 + 0.78, rc - 0.36, rz, 0.5, 0.55, 0.025, '#f7f8fa');
      for (let i = 1; i < 6; i++) { const c = c0 + 0.78 + (0.5 * i) / 6; k.line3([c, rc - 0.36, rz + 0.026], [c, rc + 0.19, rz + 0.026], PALETTE.seam, 1); }
      for (const p of posts) k.line3(p[0], p[1], PALETTE.trim, 1.2);
      k.polyline(rail, PALETTE.trim, 1.4);
      // portholes: warm when heated, blue when the habitat is cold, dark with no power
      const win = e.on ? (s.habTemp < 15 ? PALETTE.windowCold : PALETTE.window) : PALETTE.windowOff;
      for (const c of [c0 + 0.16, c0 + 0.88, c0 + 1.1]) {
        const t = 0.34, p = k.P3(c, rc + (R + 0.01) * Math.cos(t), zc + (R + 0.01) * Math.sin(t));
        if (e.on) k.glow(c, rc + R + 0.1, zc + 0.12, win === PALETTE.window ? 'rgba(255,211,107,0.28)' : 'rgba(127,180,255,0.28)', 12);
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 5.6, 4.7, -0.46, 0, Math.PI * 2); ctx.fillStyle = PALETTE.trim; ctx.fill();
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 4.2, 3.4, -0.46, 0, Math.PI * 2); ctx.fillStyle = win; ctx.fill();
        ctx.strokeStyle = PALETTE.outline; ctx.lineWidth = 1; ctx.stroke();
        if (e.on) { ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillRect(p.x - 2, p.y - 2, 1.5, 1.5); }
      }
      // name stencil
      const lab = k.P3(c0 + 0.45, rc + R * Math.cos(-0.2) + 0.01, zc + R * Math.sin(-0.2));
      ctx.fillStyle = 'rgba(40,48,62,0.55)'; ctx.font = 'bold 6px system-ui'; ctx.textAlign = 'center'; ctx.fillText('HAB-1', lab.x, lab.y);
      // moon-dirt shield: piles up over the module while the crew builds it
      if (s.berm && (s.berm.built || s.berm.building)) {
        const f = s.berm.built ? 1 : clamp01(s.berm.progress / C.bermWork);
        if (f > 0.01) {
          const a = c0 - 0.06, b = a + (c1 - c0 + 0.12) * f;
          k.cylC(a, b, rc, zc - 0.04, R + 0.17, PALETTE.regolith, { from: -0.85, to: Math.PI + 0.85, capColor: '#7a6650' });
          for (let i = 0; i < 9; i++) { const c = a + ((b - a) * (i + 0.5)) / 9; k.dot(c, rc + 0.36 + (i % 3) * 0.06, zc + 0.2 + (i % 2) * 0.16, 'rgba(0,0,0,0.2)', 1.7); k.dot(c + 0.04, rc + 0.3, zc + 0.5, 'rgba(255,255,255,0.12)', 1.2); }
        }
      }
      // airlock on the front end, with a hatch, handle and a light over the door
      k.cylC(c1, c1 + 0.3, rc, 0.4, 0.27, PALETTE.trim, { capColor: PALETTE.hull });
      k.ringC(c1 + 0.15, rc, 0.4, 0.274, PALETTE.seam, 1);
      const d = k.P3(c1 + 0.3, rc, 0.4);
      ctx.fillStyle = PALETTE.trim; ctx.beginPath(); ctx.ellipse(d.x, d.y, 6.5, 9.5, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = e.on ? '#2c3442' : '#1c2028'; ctx.beginPath(); ctx.ellipse(d.x, d.y, 5, 8, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = PALETTE.accent; ctx.fillRect(d.x + 2, d.y - 1, 2, 3);
      if (e.on) k.glow(c1 + 0.31, rc, 0.72, 'rgba(255,220,150,0.7)', 5);
      // antenna mast with a small dish and a beacon: blue = all good, red = no power
      const ax = c0 + 0.3, ar = rc - 0.12, az = zc + R - 0.03;
      k.line3([ax, ar, az], [ax, ar, az + 0.55], PALETTE.metal, 1.5);
      const top = k.P3(ax, ar, az + 0.56);
      ctx.strokeStyle = PALETTE.trim; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(top.x + 4, top.y + 4, 5, 2.5, -0.6, 0, Math.PI); ctx.stroke();
      if (m.built && m.on && !m.powered) { if (e.blink) k.glow(ax, ar, az + 0.58, 'rgba(255,70,70,0.95)', 9); }
      else if (e.on && e.blink) k.glow(ax, ar, az + 0.58, 'rgba(120,200,255,0.9)', 6);
    },

    // SOLAR: a tall vertical panel on a mast that turns to face the Sun, like NASA's VSAT design for the south pole.
    solar(k, m, e) {
      const cc = m.c + 0.5, rc = m.r + 0.5, ctx = k.ctx;
      k.box(cc - 0.22, rc - 0.22, 0, 0.44, 0.44, 0.07, PALETTE.trim); // base plate
      k.box(cc + 0.06, rc - 0.18, 0.07, 0.12, 0.1, 0.1, PALETTE.dark); // motor that turns the panel
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) k.line3([cc + a * 0.18, rc + b * 0.18, 0.07], [cc, rc, 0.42], PALETTE.metal, 1.2); // struts
      k.cylZ(cc, rc, 0.07, 0.56, 0.05, PALETTE.metal);
      const az = Math.atan2(e.sun[1], e.sun[0]), n = [Math.cos(az), Math.sin(az), 0];
      const wc = -Math.sin(az) * 0.42, wr = Math.cos(az) * 0.42, z0 = 0.62, z1 = 1.8;
      const quad = [[cc - wc, rc - wr, z0], [cc + wc, rc + wr, z0], [cc + wc, rc + wr, z1], [cc - wc, rc - wr, z1]];
      const front = (n[0] + n[1]) > 0; // we see the cells when the Sun is on our side
      const L = m.built && m.on ? e.L : e.L * 0.4;
      const color = front ? mixRGB([29, 44, 72], [47, 111, 214], L) : toRGB(PALETTE.panelBack);
      k.face(quad, front ? n : [-n[0], -n[1], 0], color, { force: true, flat: true });
      const lerp = (t, z) => [cc - wc + 2 * wc * t, rc - wr + 2 * wr * t, z];
      if (front) {
        ctx.strokeStyle = 'rgba(200,225,255,0.32)'; ctx.lineWidth = 0.8;
        for (let i = 1; i < 4; i++) k.polyline([lerp(i / 4, z0), lerp(i / 4, z1)], 'rgba(200,225,255,0.32)', 0.8);
        for (let j = 1; j < 6; j++) { const z = z0 + ((z1 - z0) * j) / 6; k.polyline([lerp(0, z), lerp(1, z)], 'rgba(200,225,255,0.32)', 0.8); }
        if (e.L > 0.3 && m.built && m.on && !m.damaged) { // moving glint of sunlight
          const g = (0.18 + 0.16 * Math.sin(e.t * 2.2 + m.id)) * e.L;
          k.face([quad[0], lerp(0.28, z0), lerp(0.28, z1), quad[3]], n, [255, 255, 255], { force: true, flat: true, noLine: true, alpha: g });
        }
      } else { // back of the panel: the support truss
        k.polyline([lerp(0, z0), lerp(1, z1)], '#7d8594', 1); k.polyline([lerp(1, z0), lerp(0, z1)], '#7d8594', 1);
        k.polyline([lerp(0.5, z0), lerp(0.5, z1)], '#7d8594', 1.5);
      }
      // aluminium frame and the hinge where it meets the mast
      k.polyline([quad[0], quad[1], quad[2], quad[3], quad[0]], PALETTE.trim, 1.6);
      k.dot(cc, rc, z0, PALETTE.dark, 2.4);
      k.cylZ(cc, rc, z1, 0.05, 0.04, PALETTE.trim, { noOutline: true });
      if (m.damaged) { // cracked cell
        const a = k.P3(cc, rc, 1.5), b = k.P3(cc + wc * 0.5, rc + wr * 0.5, 1.15);
        ctx.strokeStyle = 'rgba(255,190,120,0.95)'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(b.x + 4, b.y + 6); ctx.stroke();
      }
    },

    // BATTERY: a dark container with cooling fins, terminals on top and an LED bar that shows how full it is.
    battery(k, m, e) {
      const c0 = m.c + 0.16, r0 = m.r + 0.24, dc = 0.68, dr = 0.52, h = 0.46;
      k.box(c0 - 0.03, r0 - 0.03, 0, dc + 0.06, dr + 0.06, 0.04, PALETTE.trim); // pad
      k.box(c0, r0, 0.04, dc, dr, h, PALETTE.dark);
      k.box(c0 - 0.01, r0 - 0.01, h + 0.04, dc + 0.02, dr + 0.02, 0.035, PALETTE.trim); // lid
      k.hazard('r', r0 + dr + 0.003, c0, c0 + dc, 0.05, 0.1);
      for (let i = 0; i < 7; i++) { // cooling fins on the side
        const a = r0 + 0.06 + i * 0.058;
        k.decal('c', c0 + dc + 0.003, a, a + 0.022, 0.12, 0.44, '#565e6c');
      }
      const fr = m.built ? clamp01(e.charge) : 0;
      const color = fr < 0.2 ? PALETTE.bad : fr < 0.5 ? PALETTE.warn : PALETTE.ok;
      k.decal('r', r0 + dr + 0.003, c0 + 0.05, c0 + dc - 0.05, 0.17, 0.39, '#151a22');
      for (let i = 0; i < 6; i++) { // LED bar on the front
        const a = c0 + 0.08 + i * 0.093, lit = i / 6 < fr - 0.001;
        k.decal('r', r0 + dr + 0.004, a, a + 0.07, 0.2, 0.36, lit ? color : '#232a35');
      }
      if (fr < 0.2 && m.built && e.blink) k.glow(c0 + 0.1, r0 + dr, 0.28, 'rgba(255,80,80,0.6)', 8);
      for (let i = 0; i < 3; i++) k.dot(c0 + 0.3 + i * 0.1, r0 + 0.38, h + 0.08, 'rgba(20,26,38,0.45)', 1.2); // vents
      k.cylZ(c0 + 0.17, r0 + 0.17, h + 0.075, 0.07, 0.05, PALETTE.accent);
      k.cylZ(c0 + 0.5, r0 + 0.17, h + 0.075, 0.07, 0.05, '#2a2f38');
    },

    // O₂ GENERATOR: a water tank, an electrolysis unit and an oxygen tank, joined by a pipe with a valve.
    o2gen(k, m, e) {
      const ctx = k.ctx, running = e.on && !m.noWater;
      k.box(m.c + 0.06, m.r + 0.06, 0, 0.88, 0.88, 0.03, PALETTE.trim); // pad
      const wc = m.c + 0.3, wr = m.r + 0.3;
      k.cylZ(wc, wr, 0.03, 0.74, 0.19, PALETTE.hull);
      k.ringZ(wc, wr, 0.2, 0.192, PALETTE.seam, 1); k.ringZ(wc, wr, 0.62, 0.192, PALETTE.seam, 1);
      k.tankLevel(wc, wr, 0.19, 0.12, 0.6, m.noWater ? 0 : e.water, PALETTE.water);
      k.box(m.c + 0.5, m.r + 0.1, 0.03, 0.36, 0.3, 0.34, PALETTE.trim);
      k.cylZ(m.c + 0.6, m.r + 0.2, 0.37, 0.16, 0.035, PALETTE.metal); // vent pipe
      k.decal('c', m.c + 0.862, m.r + 0.14, m.r + 0.36, 0.1, 0.3, '#2a3140');
      const g = k.P3(m.c + 0.863, m.r + 0.21, 0.22); // pressure gauge
      ctx.fillStyle = '#f4f6f9'; ctx.beginPath(); ctx.arc(g.x, g.y, 2.8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = PALETTE.bad; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(g.x, g.y); ctx.lineTo(g.x + (running ? 2 : -1), g.y - 2); ctx.stroke();
      k.dot(m.c + 0.863, m.r + 0.3, 0.16, !m.built ? '#555' : running ? PALETTE.ok : m.on && !m.powered ? PALETTE.bad : m.noWater ? PALETTE.water : '#555', 2);
      k.line3([wc + 0.13, wr + 0.13, 0.3], [m.c + 0.6, m.r + 0.58, 0.3], PALETTE.metal, 2.5);
      const v = k.P3(m.c + 0.5, m.r + 0.47, 0.3); // valve wheel
      ctx.strokeStyle = PALETTE.bad; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.ellipse(v.x, v.y - 2, 3, 1.6, 0, 0, Math.PI * 2); ctx.stroke();
      const oc = m.c + 0.67, or = m.r + 0.67;
      k.cylZ(oc, or, 0.03, 0.54, 0.17, PALETTE.hull, { noTop: true });
      k.cylZ(oc, or, 0.34, 0.07, 0.176, PALETTE.accent, { noTop: true, noOutline: true });
      k.ringZ(oc, or, 0.14, 0.172, PALETTE.seam, 1);
      k.dome(oc, or, 0.57, 0.17, PALETTE.hull, { zs: 0.55 });
      k.cylZ(oc, or, 0.66, 0.05, 0.04, PALETTE.metal, { noOutline: true });
      const lab = k.P3(oc + 0.12, or + 0.12, 0.22);
      ctx.fillStyle = '#2c3442'; ctx.font = 'bold 8px system-ui'; ctx.textAlign = 'center'; ctx.fillText('O₂', lab.x, lab.y);
      if (running && Math.random() < 0.12) { const p = k.P3(oc, or, 0.72); e.spawn(2, p.x + (Math.random() - 0.5) * 6, p.y, (Math.random() - 0.5) * 6, -14, 1.4, 'rgba(210,240,255,0.85)'); }
    },

    // GREENHOUSE: a glass tunnel with pink LED grow lights; the plants grow during the mission and droop without power.
    greenhouse(k, m, e) {
      const ctx = k.ctx, c0 = m.c + 0.08, c1 = m.c + 0.92, rc = m.r + 0.5, R = 0.4, zb = 0.05;
      const lit = e.on && !m.damaged, grown = clamp01(e.growth);
      const glass = lit ? PALETTE.glass : PALETTE.glassOff;
      k.box(c0 - 0.03, rc - R - 0.03, 0, c1 - c0 + 0.06, 2 * R + 0.06, zb, PALETTE.trim);
      k.face([[c0, rc - R, zb], [c1, rc - R, zb], [c1, rc + R, zb], [c0, rc + R, zb]], [0, 0, 1], lit ? PALETTE.soil : '#2e3138', { flat: true, noLine: true });
      k.face([[c0, rc - 0.03, zb + 0.001], [c1, rc - 0.03, zb + 0.001], [c1, rc + 0.03, zb + 0.001], [c0, rc + 0.03, zb + 0.001]], [0, 0, 1], '#7c8392', { flat: true, noLine: true }); // walkway
      if (lit) k.glow((c0 + c1) / 2, rc, 0.15, 'rgba(255,110,220,0.32)', 34);
      k.cylC(c0, c1, rc, zb, R, glass, { from: 0, to: Math.PI, back: true, alpha: 0.18 });
      for (let row = 0; row < 2; row++) for (let i = 0; i < 3; i++) { // plants in two beds
        const c = c0 + 0.15 + i * 0.27, r = rc - 0.17 + row * 0.34;
        const p = k.P3(c, r, zb), sway = lit ? Math.sin(e.t * 1.7 + i + row * 2 + m.id) * 0.6 : 1.5;
        const hgt = (lit ? 11 : 7) * (0.45 + 0.55 * grown);
        ctx.strokeStyle = lit ? '#3fae4e' : '#4d5a45'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.quadraticCurveTo(p.x, p.y - hgt * 0.6, p.x + sway, p.y - hgt); ctx.stroke();
        ctx.fillStyle = lit ? '#5fe07a' : '#5b6b4a';
        ctx.beginPath(); ctx.ellipse(p.x + sway, p.y - hgt, lit ? 3.6 : 2.6, lit ? 2.8 : 1.8, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(p.x - 2, p.y - hgt * 0.5, 2.2, 1.4, -0.5, 0, Math.PI * 2); ctx.fill();
        if (lit && grown > 0.55 && (i + row) % 2 === 0) { ctx.fillStyle = '#ff5a4a'; ctx.beginPath(); ctx.arc(p.x + sway + 2, p.y - hgt + 2, 1.5, 0, Math.PI * 2); ctx.fill(); } // tomatoes
      }
      k.line3([c0 + 0.04, rc + R - 0.05, zb + 0.02], [c1 - 0.04, rc + R - 0.05, zb + 0.02], PALETTE.water, 1.4); // drip-irrigation hose
      k.cylC(c0, c1, rc, zb, R, glass, { from: 0, to: Math.PI, alpha: lit ? 0.24 : 0.34 });
      ctx.strokeStyle = 'rgba(238,241,245,0.75)'; ctx.lineWidth = 1;
      for (let i = 0; i <= 3; i++) { // white frame ribs
        const c = c0 + ((c1 - c0) * i) / 3;
        ctx.beginPath();
        for (let j = 0; j <= 12; j++) { const t = (Math.PI * j) / 12, p = k.P3(c, rc + R * Math.cos(t), zb + R * Math.sin(t)); j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }
        ctx.stroke();
      }
      k.decal('c', c1 + 0.003, rc - 0.1, rc + 0.1, zb, zb + 0.3, PALETTE.trim); // door in the end wall
      k.decal('c', c1 + 0.004, rc - 0.07, rc + 0.07, zb + 0.12, zb + 0.27, lit ? '#c98bc0' : PALETTE.glassDark);
      k.line3([c0, rc, zb + R], [c1, rc, zb + R], lit ? '#ff8ee6' : '#59606c', 2); // LED strip along the roof
    },

    // ICE DRILL: an orange drilling tower on a platform over the frozen crater, with a spinning bit and a water tank.
    drill(k, m, e) {
      const ctx = k.ctx, cc = m.c + 0.44, rc = m.r + 0.44, top = 1.25, B = 0.32, T = 0.07;
      k.box(cc - 0.4, rc - 0.4, 0, 0.8, 0.8, 0.06, PALETTE.trim); // platform
      k.hazard('r', rc + 0.403, cc - 0.4, cc + 0.4, 0.005, 0.055);
      k.hazard('c', cc + 0.403, rc - 0.4, rc + 0.4, 0.005, 0.055);
      const leg = (a, b) => k.line3([cc + a * B, rc + b * B, 0.06], [cc + a * T, rc + b * T, top], PALETTE.accent, 2.4);
      const at = (a, b, z) => { const f = z / top; return [cc + a * (B + (T - B) * f), rc + b * (B + (T - B) * f), z]; };
      leg(-1, -1); leg(1, -1); leg(-1, 1);
      for (const z of [0.4, 0.8]) { // cross braces (back sides)
        k.line3(at(-1, -1, z), at(1, -1, z), PALETTE.metal, 1); k.line3(at(-1, -1, z), at(-1, 1, z), PALETTE.metal, 1);
      }
      k.line3([cc, rc, top], [cc, rc, 0.06], PALETTE.metal, 2); // drill pipe
      k.line3([cc + 0.02, rc, top + 0.05], [cc + 0.02, rc, 0.5], '#d6dbe2', 0.8); // hoist cable
      const spin = e.on ? e.t * 8 : 0, b = k.P3(cc, rc, 0.08);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(b.x - Math.cos(spin) * 7, b.y - Math.sin(spin) * 3.5); ctx.lineTo(b.x + Math.cos(spin) * 7, b.y + Math.sin(spin) * 3.5); ctx.stroke();
      for (const z of [0.4, 0.8]) { k.line3(at(1, -1, z), at(1, 1, z), PALETTE.metal, 1); k.line3(at(-1, 1, z), at(1, 1, z), PALETTE.metal, 1); }
      k.line3(at(1, -1, 0.06), at(1, 1, 0.4), PALETTE.metal, 0.8); k.line3(at(-1, 1, 0.06), at(1, 1, 0.4), PALETTE.metal, 0.8); // diagonal braces
      leg(1, 1);
      for (let i = 1; i <= 5; i++) { const z = i * 0.18; k.line3(at(1, 1, z), [at(1, 1, z)[0] + 0.07, at(1, 1, z)[1], z], PALETTE.metal, 1); } // ladder rungs
      k.box(cc - 0.11, rc - 0.11, top - 0.04, 0.22, 0.22, 0.17, PALETTE.hull); // motor head
      k.box(cc - 0.11, rc - 0.11, top + 0.13, 0.22, 0.22, 0.03, PALETTE.accent);
      k.dot(cc + 0.11, rc + 0.02, top + 0.05, e.on ? PALETTE.ok : m.on && m.built && !m.powered ? PALETTE.bad : '#555', 1.8);
      if (e.on && e.blink) k.glow(cc, rc, top + 0.22, 'rgba(255,170,60,0.8)', 5); // working light
      k.cylZ(m.c + 0.86, m.r + 0.18, 0.06, 0.38, 0.12, PALETTE.hull);
      k.ringZ(m.c + 0.86, m.r + 0.18, 0.36, 0.122, PALETTE.seam, 1);
      k.tankLevel(m.c + 0.86, m.r + 0.18, 0.12, 0.1, 0.34, e.water, PALETTE.water);
      if (e.on && Math.random() < 0.25) e.spawn(1, b.x, b.y, (Math.random() - 0.5) * 30, -Math.random() * 15, 0.9, 'rgba(190,220,255,0.85)'); // ice chips
    },

    // STORM SHELTER: a bunker buried under moon dirt and sandbags (the dirt blocks the radiation), with a heavy hatch.
    shelter(k, m, e) {
      const ctx = k.ctx, cc = m.c + 0.46, rc = m.r + 0.46;
      k.dome(cc, rc, 0, 0.44, PALETTE.regolith, { zs: 0.62 });
      for (let i = 0; i < 6; i++) { // rocks on the mound
        const a = i * 1.3 + m.id, d = 0.14 + (i % 3) * 0.07;
        k.dot(cc + Math.cos(a) * d, rc + Math.sin(a) * d, 0.24 - d * 0.35, 'rgba(0,0,0,0.2)', 1.8);
      }
      for (let i = 0; i < 9; i++) { // a ring of sandbags around the front of the mound
        const t = FRONT_FROM + 0.1 + ((FRONT_TO - FRONT_FROM - 0.2) * i) / 8;
        const p = k.P3(cc + 0.47 * Math.cos(t), rc + 0.47 * Math.sin(t), 0.05);
        ctx.fillStyle = PALETTE.sandbag; ctx.beginPath(); ctx.ellipse(p.x, p.y, 5, 3, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(40,30,20,0.45)'; ctx.lineWidth = 0.8; ctx.stroke();
      }
      k.line3([cc - 0.1, rc - 0.15, 0.24], [cc - 0.1, rc - 0.15, 0.62], PALETTE.metal, 1.2); // radio antenna
      if (e.blink) k.glow(cc - 0.1, rc - 0.15, 0.64, e.state.sheltering ? 'rgba(125,255,154,0.9)' : 'rgba(255,90,90,0.7)', 4);
      k.box(m.c + 0.86, m.r + 0.38, 0, 0.1, 0.22, 0.04, PALETTE.trim); // step
      k.box(m.c + 0.72, m.r + 0.32, 0, 0.18, 0.34, 0.32, PALETTE.trim); // hatch frame
      const x = m.c + 0.902;
      k.decal('c', x, m.r + 0.38, m.r + 0.6, 0.04, 0.25, '#20252e');
      k.decal('c', x + 0.001, m.r + 0.38, m.r + 0.6, 0.13, 0.155, PALETTE.accent);
      const sgn = k.P3(x + 0.002, m.r + 0.49, 0.29); // radiation shelter sign
      ctx.fillStyle = '#f2c230'; ctx.beginPath(); ctx.arc(sgn.x, sgn.y, 3.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#22262d';
      for (let i = 0; i < 3; i++) { const a = -Math.PI / 2 + (i * Math.PI * 2) / 3; ctx.beginPath(); ctx.moveTo(sgn.x, sgn.y); ctx.arc(sgn.x, sgn.y, 2.6, a - 0.5, a + 0.5); ctx.closePath(); ctx.fill(); }
      k.glow(x, m.r + 0.62, 0.22, e.state.sheltering ? 'rgba(125,255,154,0.95)' : 'rgba(255,190,90,0.45)', e.state.sheltering ? 7 : 4);
    },

    // ASTRONOMY TOWER: a round observatory with a walkway and railing; the dome's open slit and the white
    // telescope inside slowly sweep the sky. A small weather mast measures the space weather.
    tower(k, m, e) {
      const ctx = k.ctx, cc = m.c + 0.5, rc = m.r + 0.5, zb = 0.4, Rd = 0.27;
      k.disc(cc, rc, 0, 0.42, PALETTE.trim); // foundation
      // weather mast at the back corner, with a spinning wind cup sensor and a red light
      const mc = cc - 0.3, mr = rc - 0.3;
      k.line3([mc, mr, 0], [mc, mr, 1.05], PALETTE.metal, 1.4);
      const spin = m.built ? e.t * 4 : 0, mp = k.P3(mc, mr, 1.05);
      ctx.strokeStyle = PALETTE.trim; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(mp.x - Math.cos(spin) * 5, mp.y - Math.sin(spin) * 2); ctx.lineTo(mp.x + Math.cos(spin) * 5, mp.y + Math.sin(spin) * 2); ctx.stroke();
      if (m.built && e.blink) k.glow(mc, mr, 1.1, 'rgba(255,80,80,0.9)', 4);
      // round base with a door
      k.cylZ(cc, rc, 0, zb, 0.3, PALETTE.hull);
      k.ringZ(cc, rc, 0.2, 0.302, PALETTE.seam, 1);
      k.cylPanel(cc, rc, 0.3, 0.02, 0.28, 0.22, PALETTE.trim);
      k.cylPanel(cc, rc, 0.302, 0.04, 0.26, 0.16, '#2c3442');
      // walkway deck around the dome
      k.disc(cc, rc, zb, 0.4, PALETTE.trim);
      // gold rim, then the dome with its panel seams
      k.cylZ(cc, rc, zb, 0.07, Rd, PALETTE.foil, { noTop: true });
      k.dome(cc, rc, zb + 0.07, Rd, PALETTE.hull);
      for (const lon of [0, Math.PI / 4, Math.PI / 2, -Math.PI / 4, (3 * Math.PI) / 4]) k.domeSeam(cc, rc, zb + 0.07, Rd, lon, 'rgba(20,26,38,0.16)', 0.8);
      // the open slit and the telescope looking out of it
      const phi = Math.PI / 4 + (m.built ? Math.sin(e.t * 0.25 + m.id) * 0.9 : 0);
      if (Math.cos(phi) + Math.sin(phi) > 0.2) {
        const w = 0.2, edge = (lon, la) => k.P3(cc + Rd * Math.cos(la) * Math.cos(lon), rc + Rd * Math.cos(la) * Math.sin(lon), zb + 0.07 + Rd * Math.sin(la));
        const left = [], right = [];
        for (let j = 0; j <= 8; j++) { const la = (1.4 * j) / 8; left.push(edge(phi - w, la)); right.push(edge(phi + w, la)); }
        ctx.beginPath(); left.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); right.reverse().forEach((p) => ctx.lineTo(p.x, p.y)); ctx.closePath();
        ctx.fillStyle = '#141a26'; ctx.fill(); ctx.strokeStyle = PALETTE.trim; ctx.lineWidth = 1; ctx.stroke();
        const el = 1.05, L = 0.4, base = [cc, rc, zb + 0.18]; // tilted up toward the sky
        const tip = [cc + Math.cos(phi) * Math.cos(el) * L, rc + Math.sin(phi) * Math.cos(el) * L, zb + 0.2 + Math.sin(el) * L];
        const mid = [(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2, (base[2] + tip[2]) / 2];
        k.line3(base, tip, '#e9edf2', 5); // white telescope tube
        k.line3(mid, [mid[0] + (tip[0] - base[0]) * 0.08, mid[1] + (tip[1] - base[1]) * 0.08, mid[2] + (tip[2] - base[2]) * 0.08], PALETTE.foil, 5.5); // gold ring
        k.dot(tip[0], tip[1], tip[2], '#2a3550', 1.5); // lens
      }
      // railing around the front of the walkway
      for (let i = 0; i <= 6; i++) { const t = FRONT_FROM + ((FRONT_TO - FRONT_FROM) * i) / 6; k.line3([cc + 0.4 * Math.cos(t), rc + 0.4 * Math.sin(t), zb], [cc + 0.4 * Math.cos(t), rc + 0.4 * Math.sin(t), zb + 0.13], PALETTE.metal, 1); }
      k.ringZ(cc, rc, zb + 0.13, 0.4, PALETTE.metal, 1.2);
      if (m.built && e.blink) k.glow(cc + 0.32, rc - 0.2, zb + 0.15, 'rgba(127,180,255,0.9)', 3);
    },

    // FITNESS CENTER: a small white module with a big window. Inside: a treadmill, an exercise bike and weights.
    // Astronauts need ~2 hours of exercise a day in low gravity to keep their bones and muscles strong.
    gym(k, m, e) {
      const ctx = k.ctx, c0 = m.c + 0.12, r0 = m.r + 0.16, dc = 0.76, dr = 0.66, z0 = 0.04, h = 0.46, zt = z0 + h;
      k.box(c0 - 0.04, r0 - 0.04, 0, dc + 0.08, dr + 0.08, z0, PALETTE.trim); // base plinth
      k.box(c0, r0, z0, dc, dr, h, PALETTE.hull);
      for (const a of [c0, c0 + dc - 0.045]) k.decal('r', r0 + dr + 0.002, a, a + 0.045, z0, zt, PALETTE.trim); // corner posts
      for (const a of [r0, r0 + dr - 0.045]) k.decal('c', c0 + dc + 0.002, a, a + 0.045, z0, zt, PALETTE.trim);
      // big window on the front, split into three panes
      const lit = e.on && !m.damaged;
      const wz0 = 0.16, wz1 = 0.43, wa = c0 + 0.08, wb = c0 + dc - 0.08;
      k.decal('r', r0 + dr + 0.003, wa - 0.02, wb + 0.02, wz0 - 0.02, wz1 + 0.02, PALETTE.trim);
      for (let i = 0; i < 3; i++) {
        const a = wa + ((wb - wa) * i) / 3 + 0.008, b = wa + ((wb - wa) * (i + 1)) / 3 - 0.008;
        k.decal('r', r0 + dr + 0.004, a, b, wz0, wz1, lit ? '#ffe7a8' : PALETTE.glassDark);
      }
      if (lit) k.glow(c0 + dc / 2, r0 + dr + 0.1, 0.3, 'rgba(255,220,140,0.22)', 22);
      // what you see through the window (silhouettes)
      const inside = (c, z) => k.P3(c, r0 + dr + 0.005, z);
      const dark = lit ? 'rgba(70,78,94,0.55)' : 'rgba(90,98,112,0.35)';
      ctx.strokeStyle = dark; ctx.fillStyle = dark; ctx.lineCap = 'round';
      const tm = inside(wa + 0.1, 0.2); // treadmill (left pane)
      ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(tm.x - 6, tm.y - 3); ctx.lineTo(tm.x + 5, tm.y + 2.5); ctx.stroke();
      ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(tm.x + 4, tm.y + 2); ctx.lineTo(tm.x + 5, tm.y - 7); ctx.stroke();
      const bk = inside(c0 + dc / 2, 0.2); // exercise bike (middle pane)
      ctx.lineWidth = 1.2; ctx.beginPath(); ctx.arc(bk.x - 3, bk.y + 1, 2.4, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(bk.x - 3, bk.y + 1); ctx.lineTo(bk.x + 2, bk.y - 6); ctx.lineTo(bk.x + 4, bk.y - 6); ctx.moveTo(bk.x - 3, bk.y + 1); ctx.lineTo(bk.x - 4, bk.y - 5); ctx.stroke();
      const wt = inside(wb - 0.1, 0.2); // weight rack (right pane)
      ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(wt.x - 4, wt.y - 6); ctx.lineTo(wt.x - 4, wt.y + 2); ctx.moveTo(wt.x + 4, wt.y - 2); ctx.lineTo(wt.x + 4, wt.y + 5); ctx.stroke();
      for (const dy of [-3, 0.5]) { ctx.fillRect(wt.x - 3, wt.y + dy - 0.6 + dy * 0.35, 6, 1.2); }
      if (e.training && lit) { // someone running on the treadmill
        const s = Math.sin(e.t * 10) * 2.5, p = { x: tm.x - 1, y: tm.y - 1 };
        ctx.strokeStyle = 'rgba(44,52,66,0.7)'; ctx.fillStyle = 'rgba(44,52,66,0.7)'; ctx.lineWidth = 1.4;
        ctx.beginPath(); ctx.moveTo(p.x, p.y - 3); ctx.lineTo(p.x, p.y - 10);
        ctx.moveTo(p.x, p.y - 3); ctx.lineTo(p.x - 2 + s, p.y + 1); ctx.moveTo(p.x, p.y - 3); ctx.lineTo(p.x + 2 - s, p.y + 1);
        ctx.moveTo(p.x, p.y - 8); ctx.lineTo(p.x + 2 + s * 0.5, p.y - 5); ctx.stroke();
        ctx.beginPath(); ctx.arc(p.x, p.y - 12.5, 2.2, 0, Math.PI * 2); ctx.fill();
      }
      ctx.lineCap = 'butt';
      // side: door with a small window, a step, an orange stripe and a dumbbell sign
      k.box(c0 + dc, r0 + 0.2, 0, 0.08, 0.24, z0, PALETTE.trim);
      k.decal('c', c0 + dc + 0.003, r0 + 0.22, r0 + 0.42, z0, 0.36, '#3b424e');
      k.decal('c', c0 + dc + 0.004, r0 + 0.27, r0 + 0.37, 0.22, 0.31, lit ? '#ffe7a8' : PALETTE.glassDark);
      k.decal('c', c0 + dc + 0.003, r0 + 0.045, r0 + dr - 0.045, zt - 0.08, zt - 0.04, PALETTE.accent);
      if (lit) k.glow(c0 + dc + 0.01, r0 + 0.32, 0.4, 'rgba(255,220,150,0.7)', 5);
      const sg = k.P3(c0 + dc + 0.004, r0 + 0.52, 0.27); // dumbbell sign beside the door
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(sg.x - 3.5, sg.y - 3, 7, 6, 1.5); ctx.fill();
      ctx.fillStyle = PALETTE.accent; ctx.fillRect(sg.x - 2, sg.y - 0.4, 4, 0.8); ctx.fillRect(sg.x - 2.8, sg.y - 1.5, 1.1, 3); ctx.fillRect(sg.x + 1.7, sg.y - 1.5, 1.1, 3);
      // roof: overhang, air-conditioning unit with a spinning fan, and a small skylight
      k.box(c0 - 0.03, r0 - 0.03, zt, dc + 0.06, dr + 0.06, 0.035, PALETTE.trim);
      k.box(c0 + 0.44, r0 + 0.08, zt + 0.035, 0.22, 0.3, 0.025, '#33405a'); // skylight
      k.box(c0 + 0.08, r0 + 0.1, zt + 0.035, 0.26, 0.26, 0.11, PALETTE.hull);
      const fc = k.P3(c0 + 0.21, r0 + 0.23, zt + 0.146);
      ctx.fillStyle = '#4a5160'; ctx.beginPath(); ctx.ellipse(fc.x, fc.y, 6.5, 3.3, 0, 0, Math.PI * 2); ctx.fill();
      const fa = e.on ? e.t * 9 : 0.4;
      ctx.strokeStyle = '#c9d1dc'; ctx.lineWidth = 1.4;
      for (let i = 0; i < 3; i++) { const a = fa + (i * Math.PI * 2) / 3; ctx.beginPath(); ctx.moveTo(fc.x, fc.y); ctx.lineTo(fc.x + Math.cos(a) * 5.5, fc.y + Math.sin(a) * 2.8); ctx.stroke(); }
    },
  };

  function draw(k, m, e) { const f = MODELS[m.type]; if (f) f(k, m, e); }

  // Yellow scaffolding while a building is being built. More floors fill in as the work goes on (frac 0..1).
  function scaffold(k, m, frac) {
    const h = height(m.type), i = 0.06;
    const corners = [[m.c + i, m.r + i], [m.c + m.w - i, m.r + i], [m.c + m.w - i, m.r + m.h - i], [m.c + i, m.r + m.h - i]];
    for (const [c, r] of corners) k.line3([c, r, 0], [c, r, h], PALETTE.scaffold, 1.3);
    const levels = Math.max(2, Math.ceil(h / 0.3));
    for (let j = 1; j <= levels; j++) {
      const z = (h * j) / levels, done = j / levels <= clamp01(frac) + 1e-6;
      for (let q = 0; q < 4; q++) {
        const a = corners[q], b = corners[(q + 1) % 4];
        k.line3([a[0], a[1], z], [b[0], b[1], z], done ? PALETTE.scaffold : 'rgba(255,211,107,0.3)', done ? 1.3 : 1);
      }
    }
    k.line3([corners[1][0], corners[1][1], 0], [corners[2][0], corners[2][1], h * clamp01(frac)], PALETTE.scaffold, 1); // diagonal brace
  }

  // A small label floating above a building (OFF, NO POWER, ...). x, y = world pixels.
  function badge(ctx, x, y, text, color) {
    ctx.font = 'bold 9px system-ui, sans-serif';
    const w = ctx.measureText(text).width + 10;
    ctx.fillStyle = 'rgba(10,13,20,0.88)'; ctx.beginPath(); ctx.roundRect(x - w / 2, y - 8, w, 15, 4); ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, x, y);
    ctx.textBaseline = 'alphabetic';
  }

  MT.Models = { VZ, PALETTE, HEIGHT, height, sunVector, facesCamera, brightness, Toolkit, MODELS, draw, scaffold, badge };
})(typeof window !== 'undefined' ? window : globalThis);
