// Written with help from Claude Code (AI); reviewed and tested by the team.
// The crew spaceship that touches down on a Landing Pad. Shared by both map views:
//  - LW.ShipLanding(): the animation clock. view.js runs it every frame and hands the current frame to
//    whichever renderer is showing, so the ship stays on the pad wherever the camera is (and across a
//    view switch).
//  - LW.Ship.drawFlat / drawIso: the two looks (flat, seen from straight above, for the top-down map;
//    a small 3D lander for the 2.5D map). Flat fills only, so they stay cheap to draw every frame.
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});
  const TAU = Math.PI * 2;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));

  // Timeline (seconds). The game waits until DONE (then the clock starts or the new-crew pop-up opens);
  // the ship then sits on the pad a moment longer and flies back up, so it never just vanishes.
  const TL = { land: 2.6, done: 3.6, ignite: 5.0, lift: 5.4, gone: 7.6 };
  // With "reduce motion" switched on: the ship is simply there, then fades away.
  const RD = { done: 0.9, fade: 1.4, gone: 1.8 };

  /** What the ship looks like t seconds into the landing. alt: 1 = high in the sky, 0 = on the pad. */
  function frameAt(t, reduce) {
    if (reduce) {
      return { alt: 0, flame: 0, squash: 0, dust: 0, label: 1, alpha: t < RD.fade ? 1 : clamp01((RD.gone - t) / (RD.gone - RD.fade)), done: t >= RD.done, over: t >= RD.gone };
    }
    let alt = 0, flame = 0;
    if (t < TL.land) { alt = Math.pow(1 - t / TL.land, 2.4); flame = 1; } // slows down to a soft touchdown
    else if (t < TL.land + 0.25) flame = 1 - (t - TL.land) / 0.25; // engine off
    else if (t >= TL.lift) { alt = Math.pow((t - TL.lift) / (TL.gone - TL.lift), 2.2); flame = 1; } // speeds up as it leaves
    else if (t >= TL.ignite) flame = (t - TL.ignite) / (TL.lift - TL.ignite); // engine spools up on the pad
    const s = (t - TL.land) / 0.45; // the legs give a little at touchdown
    return {
      alt: Math.min(1, alt),
      flame,
      squash: s > 0 && s < 1 ? Math.sin(s * Math.PI) * (1 - s) : 0,
      dust: flame * clamp01(1 - alt / 0.2), // the exhaust only kicks up moon dust close to the ground
      label: clamp01((t - 2.5) / 0.4) * clamp01((5.2 - t) / 0.4),
      alpha: clamp01(t / 0.35) * clamp01((TL.gone - t) / 0.4),
      done: t >= TL.done,
      over: t >= TL.gone,
    };
  }

  /** The landing clock: play() one landing at a time; update(dt) every frame returns what to draw (or null). */
  function ShipLanding() {
    let cur = null; // { c, r, padId, text, t, onDone, fired, landed, reduce }
    function fire() { if (cur && !cur.fired) { cur.fired = true; if (cur.onDone) cur.onDone(); } }
    return {
      /** pad = the Landing Pad module it touches down on (null: nothing to show, onDone runs right away). */
      play(pad, text, onDone) {
        fire(); // a landing still playing finishes first, so its game never stays stuck waiting
        if (!pad) { cur = null; if (onDone) setTimeout(onDone, 0); return; }
        const reduce = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
        cur = { c: pad.c + pad.w / 2, r: pad.r + pad.h / 2, padId: pad.id, text: text || '🚀 The crew spaceship has landed!', t: 0, onDone, fired: false, landed: false, reduce };
      },
      update(dt) {
        const me = cur;
        if (!me) return null;
        me.t += dt;
        const f = frameAt(me.t, me.reduce);
        f.burst = !me.reduce && !me.landed && me.t >= TL.land; // the frame it touches down: a puff of dust
        if (f.burst) me.landed = true;
        f.c = me.c; f.r = me.r; f.padId = me.padId; f.text = me.text; f.t = me.t;
        if (f.done) fire(); // (may start the clock or open a pop-up)
        if (cur !== me) return null; // that started another landing: it shows from the next frame
        if (f.over) { cur = null; return null; }
        return f;
      },
      active: () => !!cur,
      clear() { cur = null; }, // new game: drop it (the new game plays its own landing)
    };
  }

  // ---------- the looks ----------
  const HULL = '#e6ebf1', HULL_HI = '#f7f9fb', HULL_LO = '#c9d1dc', EDGE = '#7f8b99';
  const RED = '#ff6b5d', RED_LO = '#b5463c', GLASS = '#7fd0ff', GLASS_RIM = '#5b6576';
  const FOIL = '#d9b04a', METAL = '#8f96a3', ENGINE = '#4a515e', FLAME = '#ffb347', FLAME_CORE = '#fff1c1';

  function disc(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }

  /**
   * The ship's shadow on the ground around (x, y), an oval rx by ry. High up it is a bigger, fainter blob right
   * under the ship (so you can see where it will land); on the pad it stretches away from the Sun like the
   * buildings' shadows. sh = { dx, dy: the shadow's length and direction in pixels, light: 0..1 sunlight }.
   */
  function shadow(ctx, x, y, rx, ry, f, sh) {
    const grow = 1 + f.alt * 0.8, k = sh.light > 0.02 ? 1 - f.alt : 0, pts = [];
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * TAU, px = x + Math.cos(t) * rx * grow, py = y + Math.sin(t) * ry * grow;
      pts.push([px, py], [px + sh.dx * k, py + sh.dy * k]);
    }
    LW.Shapes.pathOf(ctx, LW.Shapes.hull(pts));
    ctx.fillStyle = '#000'; ctx.globalAlpha = f.alpha * (0.14 + 0.18 * (1 - f.alt)) * (0.5 + 0.5 * sh.light);
    ctx.fill();
  }
  function oval(ctx, x, y, rx, ry) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, TAU); ctx.fill(); }

  /**
   * Top-down (flat) ship at world point (x, y) = the middle of the pad. Seen from straight above, it comes
   * down towards the ground: big and blurry-shadowed high up, shrinking onto its shadow as it lands.
   * sh = its shadow (see shadow()); time = seconds (for the flicker).
   */
  function drawFlat(ctx, x, y, f, sh, time) {
    const s = 1.15 + f.alt * 2.6, a = f.alpha;
    if (a <= 0) return;
    ctx.save();
    shadow(ctx, x, y, 19, 19, f, sh);
    // Exhaust lighting up the pad around the ship.
    if (f.flame > 0 && f.alt < 0.5) {
      const g = f.flame * (1 - f.alt * 2), fl = Math.sin(time * 47) * 2;
      ctx.fillStyle = FLAME; ctx.globalAlpha = a * 0.3 * g; disc(ctx, x, y, 26 + fl);
      ctx.fillStyle = FLAME_CORE; ctx.globalAlpha = a * 0.55 * g; disc(ctx, x, y, 17 + fl * 0.5);
    }
    ctx.globalAlpha = a;
    ctx.translate(x, y); ctx.scale(s, s);
    // 4 landing legs with round foot pads (along the grid lines, clear of the pad's corner beacons)
    ctx.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const ang = (k * Math.PI) / 2, cx = Math.cos(ang), cy = Math.sin(ang);
      ctx.strokeStyle = METAL; ctx.lineWidth = 2.6;
      ctx.beginPath(); ctx.moveTo(cx * 10, cy * 10); ctx.lineTo(cx * 24, cy * 24); ctx.stroke();
      ctx.fillStyle = HULL_LO; disc(ctx, cx * 25, cy * 25, 3.6);
      ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.lineCap = 'butt';
    // hull: gold-foil skirt, white body, nose cone with a red tip
    ctx.fillStyle = FOIL; disc(ctx, 0, 0, 15.5);
    ctx.fillStyle = HULL_LO; disc(ctx, 0, 0, 13.5);
    ctx.strokeStyle = EDGE; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = HULL; disc(ctx, 0.8, -0.8, 11.5);
    ctx.fillStyle = HULL_HI; disc(ctx, 1.6, -1.6, 7.5);
    ctx.fillStyle = RED; disc(ctx, 0.8, -0.8, 4.2);
    ctx.fillStyle = RED_LO; disc(ctx, 0.8, -0.8, 1.5);
    // thruster pods and a window on the side
    ctx.fillStyle = ENGINE;
    for (const [px, py] of [[9.5, -9.5], [-9.5, -9.5], [-9.5, 9.5]]) ctx.fillRect(px - 1.6, py - 1.6, 3.2, 3.2);
    ctx.fillStyle = GLASS; ctx.beginPath(); ctx.ellipse(8, 8, 2.8, 1.9, -Math.PI / 4, 0, TAU); ctx.fill();
    ctx.strokeStyle = GLASS_RIM; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }

  // An upright cylinder side (and its front outline) standing at (x, yb), ht pixels tall, as a path.
  function cylPath(ctx, x, yb, rx, ht) {
    const ry = rx * 0.5;
    ctx.beginPath(); ctx.moveTo(x - rx, yb - ht); ctx.lineTo(x - rx, yb);
    ctx.ellipse(x, yb, rx, ry, 0, Math.PI, 0, true); ctx.lineTo(x + rx, yb - ht); ctx.closePath();
  }
  // Round-shape shading: darker on the left, a highlight on the right (light comes from the right, like the buildings).
  function shade(ctx, x, rx, y0, y1) {
    ctx.fillStyle = 'rgba(40,50,70,0.2)'; ctx.fillRect(x - rx - 1, y0, rx * 0.75, y1 - y0);
    ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillRect(x + rx * 0.15, y0, rx * 0.4, y1 - y0);
  }

  /**
   * 2.5D ship at world point (x, y) = the middle of the pad's top. A white lander on 4 legs: engine bell,
   * gold-foil skirt, body with a red band and a window, nose cone with a red tip.
   * It comes straight down; its shadow sits on the pad the whole time, so you can see where it lands.
   * sh = its shadow (see shadow()); time = seconds (for the flicker).
   */
  function drawIso(ctx, x, y, f, sh, time) {
    const a = f.alpha;
    if (a <= 0) return;
    const z = f.alt * 460, sq = f.squash * 3, by = y - z, bb = by + sq; // bb: the body sinks a little at touchdown
    const RX = 12, RY = RX / 2, FEET = 25;
    ctx.save();
    shadow(ctx, x, y, 20, 10, f, sh);
    // exhaust lighting up the pad
    if (f.flame > 0 && f.alt < 0.4) {
      const g = f.flame * (1 - f.alt * 2.5), fl = Math.sin(time * 47) * 2;
      ctx.fillStyle = FLAME; ctx.globalAlpha = a * 0.3 * g; oval(ctx, x, y, 30 + fl, 15 + fl / 2);
      ctx.fillStyle = FLAME_CORE; ctx.globalAlpha = a * 0.5 * g; oval(ctx, x, y, 16, 8);
    }
    ctx.globalAlpha = a;
    // legs: from the side of the body down to foot pads on a circle around it (the back two go behind the body)
    const leg = (ang) => {
      const cx = Math.cos(ang), cy = Math.sin(ang);
      const fx = x + cx * FEET, fy = by + cy * FEET * 0.5;
      ctx.strokeStyle = METAL; ctx.lineWidth = 2.4; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x + cx * RX * 0.9, bb + cy * RY * 0.9 - 24); ctx.lineTo(fx, fy - 2); ctx.stroke();
      ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(x + cx * RX * 0.9, bb + cy * RY * 0.9 - 14); ctx.lineTo(x + cx * FEET * 0.7, by + cy * FEET * 0.35 - 3); ctx.stroke(); // brace
      ctx.lineCap = 'butt';
      ctx.fillStyle = HULL_LO; ctx.beginPath(); ctx.ellipse(fx, fy - 1, 4, 2, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.stroke();
    };
    const legs = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
    for (const ang of legs) if (Math.sin(ang) < 0) leg(ang);
    // flame out of the engine bell (squashed flat where it hits the pad)
    if (f.flame > 0) {
      const flick = 0.85 + 0.15 * Math.sin(time * 61), len = Math.min(34 * f.flame * flick, z + 7), w = 6.5 * Math.min(1, f.flame * 1.5);
      const top = bb - 7;
      ctx.fillStyle = FLAME; ctx.beginPath(); ctx.moveTo(x - w, top); ctx.quadraticCurveTo(x, top + len * 1.6, x + w, top); ctx.closePath(); ctx.fill();
      ctx.fillStyle = FLAME_CORE; ctx.beginPath(); ctx.moveTo(x - w * 0.5, top); ctx.quadraticCurveTo(x, top + len * 0.9, x + w * 0.5, top); ctx.closePath(); ctx.fill();
    }
    // engine bell: wider at the bottom
    ctx.fillStyle = ENGINE; ctx.beginPath();
    ctx.moveTo(x - 5, bb - 16); ctx.lineTo(x - 8, bb - 7); ctx.ellipse(x, bb - 7, 8, 4, 0, Math.PI, 0, true); ctx.lineTo(x + 5, bb - 16); ctx.closePath(); ctx.fill();
    // body: gold-foil skirt at the bottom, white hull above, red band, window
    const b0 = bb - 14, BH = 40, top = b0 - BH;
    ctx.save();
    cylPath(ctx, x, b0, RX, BH); ctx.fillStyle = HULL; ctx.fill();
    ctx.clip();
    ctx.fillStyle = FOIL; ctx.fillRect(x - RX - 1, b0 - 6, RX * 2 + 2, 6 + RY + 1);
    ctx.fillStyle = RED; ctx.beginPath(); ctx.ellipse(x, b0 - 24, RX, RY, 0, 0, Math.PI); ctx.lineTo(x - RX, b0 - 28); ctx.ellipse(x, b0 - 28, RX, RY, 0, Math.PI, 0, true); ctx.closePath(); ctx.fill();
    shade(ctx, x, RX, top - RY, b0 + RY + 1);
    ctx.restore();
    cylPath(ctx, x, b0, RX, BH); ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = GLASS; ctx.beginPath(); ctx.ellipse(x + 3.5, top + 9, 3.2, 3.8, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = GLASS_RIM; ctx.lineWidth = 1.2; ctx.stroke();
    // nose cone with a red tip
    const nose = () => {
      ctx.beginPath(); ctx.moveTo(x - RX, top);
      ctx.bezierCurveTo(x - RX, top - 13, x - 4, top - 23, x, top - 25);
      ctx.bezierCurveTo(x + 4, top - 23, x + RX, top - 13, x + RX, top);
      ctx.ellipse(x, top, RX, RY, 0, 0, Math.PI, false); ctx.closePath();
    };
    ctx.save();
    nose(); ctx.fillStyle = HULL; ctx.fill(); ctx.clip();
    ctx.fillStyle = RED; ctx.fillRect(x - RX, top - 26, RX * 2, 10);
    shade(ctx, x, RX, top - 26, top + RY + 1);
    ctx.restore();
    nose(); ctx.strokeStyle = EDGE; ctx.lineWidth = 1; ctx.stroke();
    for (const ang of legs) if (Math.sin(ang) >= 0) leg(ang);
    ctx.restore();
  }

  /** "Your crew has landed!" tag at world point (x, y), the same size on screen at any zoom. */
  function label(ctx, x, y, text, alpha, zoom) {
    if (!(alpha > 0) || !text) return;
    ctx.save();
    ctx.translate(x, y); ctx.scale(1 / zoom, 1 / zoom);
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 14px system-ui, -apple-system, "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 28, h = 28;
    ctx.fillStyle = 'rgba(12,16,26,0.92)'; ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, h / 2); ctx.fill();
    ctx.strokeStyle = '#ffd36b'; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = '#ffd36b'; ctx.fillText(text, 0, 1);
    ctx.restore();
  }

  LW.Ship = { frameAt, drawFlat, drawIso, label, TIMELINE: TL };
  LW.ShipLanding = ShipLanding;
})(typeof window !== 'undefined' ? window : globalThis);
