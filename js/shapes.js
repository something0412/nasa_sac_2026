// Small drawing helpers shared by the top-down (render.js) and 2.5D (render_iso.js) renderers:
// signs drawn on buildings (radiation sign, dumbbell, flask, lightning bolt) and a convex-hull helper.
// Flat fills only (no images, gradients or blur), so they stay cheap to draw every frame.
(function () {
  const MT = (window.MT = window.MT || {});
  const TAU = Math.PI * 2;

  /** Convex hull of [[x, y], ...] (for shadows and round tubes). */
  function hull(pts) {
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  /** Start a closed path through [[x, y], ...]. */
  function pathOf(ctx, pts) {
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }
  /** Radiation sign: yellow disc with three black wedges (Storm Shelter). */
  function trefoil(ctx, x, y, s) {
    ctx.fillStyle = '#ffd36b'; ctx.beginPath(); ctx.arc(x, y, s, 0, TAU); ctx.fill();
    ctx.fillStyle = '#1b1f27';
    for (let k = 0; k < 3; k++) { const a = -Math.PI / 2 + (k * TAU) / 3; ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, s * 0.8, a - 0.5, a + 0.5); ctx.closePath(); ctx.fill(); }
    ctx.fillStyle = '#ffd36b'; ctx.beginPath(); ctx.arc(x, y, s * 0.22, 0, TAU); ctx.fill();
  }
  /** Dumbbell sign (Fitness Center). */
  function dumbbell(ctx, x, y, s, color) {
    ctx.fillStyle = color;
    ctx.fillRect(x - 4 * s, y - 0.7 * s, 8 * s, 1.4 * s);
    ctx.fillRect(x - 6 * s, y - 3 * s, 2.2 * s, 6 * s); ctx.fillRect(x + 3.8 * s, y - 3 * s, 2.2 * s, 6 * s);
  }
  /** Flask sign (Research Bay). */
  function flask(ctx, x, y, s, color) {
    ctx.fillStyle = color; ctx.beginPath();
    ctx.moveTo(x - 1.2 * s, y - 4 * s); ctx.lineTo(x + 1.2 * s, y - 4 * s); ctx.lineTo(x + 1.2 * s, y - 1.5 * s); ctx.lineTo(x + 3.5 * s, y + 3 * s);
    ctx.lineTo(x - 3.5 * s, y + 3 * s); ctx.lineTo(x - 1.2 * s, y - 1.5 * s); ctx.closePath(); ctx.fill();
  }
  /** Lightning bolt (Battery). */
  function bolt(ctx, x, y, s, color) {
    ctx.fillStyle = color; ctx.beginPath();
    ctx.moveTo(x + 1 * s, y - 4 * s); ctx.lineTo(x - 2.2 * s, y + 0.6 * s); ctx.lineTo(x - 0.1 * s, y + 0.6 * s); ctx.lineTo(x - 1 * s, y + 4 * s);
    ctx.lineTo(x + 2.2 * s, y - 0.8 * s); ctx.lineTo(x + 0.1 * s, y - 0.8 * s); ctx.closePath(); ctx.fill();
  }
  /** Battery charge light colour: green, yellow below half, red below 20%. */
  const chargeColor = (f) => (f < 0.2 ? '#ff5d5d' : f < 0.5 ? '#ffc04d' : '#5fe08a');

  MT.Shapes = { hull, pathOf, trefoil, dumbbell, flask, bolt, chargeColor };
})();
