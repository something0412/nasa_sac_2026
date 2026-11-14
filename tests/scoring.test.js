// Run with:  node --test tests/
// Checks the scoring math and the data files. No browser needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

global.window = {};
require(path.join(__dirname, '../web/js/config.js'));
require(path.join(__dirname, '../web/data/targets.js'));
require(path.join(__dirname, '../web/data/earth_sites.js'));
const S = require(path.join(__dirname, '../web/js/scoring.js'));
const cfg = window.ANALOG_CONFIG;
const SITES = window.EARTH_SITES;
const TARGETS = window.TARGETS;
const W = cfg.presets[0].weights;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

// ---------------------------------------------------------------- math ----
test('exact match scores 1, one sigma off scores exp(-0.5)', () => {
  const f = { sigma: 4 };
  close(S.featureScore(f, 10, 10, [-100, 100]).score, 1);
  close(S.featureScore(f, 14, 10, [-100, 100]).score, Math.exp(-0.5));
});

test('targets beyond Earth are scored against the closest Earth can reach, and flagged', () => {
  const f = { sigma: 15 };
  const r = S.featureScore(f, -70, -190, [-70, 30]); // Moon night vs Earth's coldest site
  close(r.score, 1);
  assert.equal(r.beyond, true);
  close(r.reach, -70);
  assert.equal(S.featureScore(f, -60, -65, [-70, 30]).beyond, false);
});

test('log features compare ratios: 100 m vs 200 m relief is about one sigma (0.3)', () => {
  const f = { sigma: 0.3, scale: 'log' };
  const r = S.featureScore(f, 100, 200, [0, 4]);
  close(r.score, Math.exp(-0.5 * Math.pow(Math.log10(2) / 0.3, 2)));
});

test('missing Earth values count as neutral 0.5 and are marked', () => {
  const r = S.featureScore({ sigma: 1 }, null, 5, [0, 10]);
  assert.equal(r.score, 0.5);
  assert.equal(r.missing, true);
});

test('rock similarity: primary, secondary and unrelated rocks', () => {
  const t = ['anorthosite', 'impact'];
  close(S.rockScore({ rock: 'anorthosite' }, t, cfg).score, 1);
  close(S.rockScore({ rock: 'granitic', rock2: 'anorthosite' }, t, cfg).score, 0.8);
  close(S.rockScore({ rock: 'impact' }, t, cfg).score, Math.max(0.6, 0.85));
  close(S.rockScore({ rock: 'ice' }, t, cfg).score, 0);
});

test('scan cells with unknown rock and vegetation score neutral 0.5 on those', () => {
  const t = TARGETS.find(x => x.id === 'mars-jezero');
  const cell = Object.assign({}, SITES.find(s => s.id === 'atacama'), { id: 'scan-x', status: 'scan', rock: '', rock2: '', ndvi: null });
  const r = S.scoreSite(cell, t, W, cfg, S.earthEnvelope(SITES, cfg));
  const geo = r.dims.surface.features;
  assert.equal(geo.find(f => f.key === 'rock').score, 0.5);
  assert.equal(geo.find(f => f.key === 'ndvi').score, 0.5);
  assert.equal(S.formatValue(cfg, 'rock', ['', '']), 'no data');
});

test('sun height comes from latitude; pressure falls with altitude', () => {
  close(S.sunElevation(-89.45), 0.55);
  close(S.sunElevation(75), 15);
  assert.ok(S.pressureKpa(0) > 100 && S.pressureKpa(0) < 102);
  assert.ok(S.pressureKpa(5500) < 55);
});

test('a target only scores the features it lists (caves have no sunlight dimension)', () => {
  const pit = TARGETS.find(t => t.id === 'moon-tranq-pit');
  const dims = S.activeDims(pit, cfg);
  assert.ok(!dims.includes('light'));
  const r = S.scoreSite(SITES[0], pit, W, cfg, S.earthEnvelope(SITES, cfg));
  assert.equal(r.dims.light.score, null);
  assert.ok(r.dims.terrain.features.every(f => f.key === 'lava_tube'));
});

test('zero-weight dimensions do not change the total', () => {
  const t = TARGETS[0], env = S.earthEnvelope(SITES, cfg);
  const a = S.scoreSite(SITES[3], t, { terrain: 3, thermal: 0, surface: 0, water: 0, light: 0 }, cfg, env);
  close(a.total, a.dims.terrain.score);
});

// ------------------------------------------------------- ranking & extras ----
test('ranking: sorted, controls unranked, ranks 1..N', () => {
  const R = S.rankSites(SITES, TARGETS[0], W, cfg);
  for (let i = 1; i < R.results.length; i++) assert.ok(R.results[i - 1].total >= R.results[i].total);
  const ranked = R.results.filter(r => r.rank !== null);
  assert.deepEqual(ranked.map(r => r.rank), ranked.map((_, i) => i + 1));
  assert.ok(R.results.filter(r => r.site.status === 'control').every(r => r.rank === null));
});

test('campaign: first pick is the top site, coverage beats it, picks are spread out', () => {
  for (const t of TARGETS) {
    const R = S.rankSites(SITES, t, W, cfg);
    const P = S.portfolio(R, W, cfg, { k: 3, minKm: 300 });
    assert.equal(P.picks[0], R.results.find(r => r.rank === 1));
    assert.ok(P.coverage >= P.bestSingle - 1e-9);
    for (let i = 0; i < P.picks.length; i++) for (let j = i + 1; j < P.picks.length; j++)
      assert.ok(S.haversineKm(P.picks[i].site, P.picks[j].site) >= 300);
  }
});

test('campaign greedy matches brute force on a small case', () => {
  const t = TARGETS.find(x => x.id === 'mars-jezero');
  const R = S.rankSites(SITES, t, W, cfg);
  const P = S.portfolio(R, W, cfg, { k: 2, minKm: 0 });
  const pool = R.results.filter(r => r.site.status !== 'control');
  const dims = R.dims.filter(d => W[d] > 0), Wsum = dims.reduce((a, d) => a + W[d], 0);
  let best = 0;
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    const v = dims.reduce((a, d) => a + W[d] * Math.max(pool[i].dims[d].score, pool[j].dims[d].score), 0) / Wsum;
    best = Math.max(best, v);
  }
  assert.ok(P.coverage >= 0.63 * best, 'greedy guarantee');
  assert.ok(P.coverage <= best + 1e-9);
});

test('validation AUC: exact on a toy example', () => {
  const toyCfg = Object.assign({}, cfg);
  const mk = (id, status, slope) => ({ id, name: id, status, known_for: ['mars'], lat: 0, lon: 0, slope_deg: slope });
  const sites = [mk('a', 'established', 0), mk('b', 'established', 8), mk('c', 'control', 4), mk('d', 'control', 12)];
  const target = { id: 't', body: 'mars', lat: 0, features: { slope_deg: 0 } };
  const v = S.validate(sites, [target], 'mars', { terrain: 1 }, toyCfg);
  // a beats c and d; b loses to c, beats d  -> 3 wins of 4
  close(v.auc, 0.75);
});

test('validation on the shipped data separates analogs from ordinary places', () => {
  for (const body of ['moon', 'mars']) {
    const v = S.validate(SITES, TARGETS, body, W, cfg);
    assert.ok(v.auc > 0.8, `${body} AUC ${v.auc}`);
  }
});

test('gap report: Moon thermal gaps are flagged with a place to test instead', () => {
  const t = TARGETS.find(x => x.id === 'moon-connecting-ridge');
  const R = S.rankSites(SITES, t, W, cfg);
  const g = S.gapReport(R.results[0], R, cfg);
  const cold = g.items.find(i => i.key === 't_min_c');
  assert.equal(cold.beyond, true);
  assert.match(cold.mitigation, /thermal-vacuum/);
  assert.match(g.universal.find(u => u.key === 'gravity').text, /17%/);
  assert.match(g.universal.find(u => u.key === 'pressure').text, /near-vacuum/);
  assert.equal(g.counts.holds + g.counts.partial + g.counts.breaks, g.items.length);
});

// ------------------------------------------------------------ data checks ----
test('Earth sites: unique ids, valid coordinates, rock classes and statuses', () => {
  const ids = new Set();
  for (const s of SITES) {
    assert.ok(!ids.has(s.id), 'duplicate id ' + s.id); ids.add(s.id);
    assert.ok(Math.abs(s.lat) <= 90 && Math.abs(s.lon) <= 180, s.id);
    assert.ok(cfg.rockLabels[s.rock], `${s.id} rock ${s.rock}`);
    assert.ok(!s.rock2 || cfg.rockLabels[s.rock2], `${s.id} rock2 ${s.rock2}`);
    assert.ok(['established', 'less-studied', 'control'].includes(s.status), s.id);
    for (const k of Object.keys(cfg.features)) {
      if (cfg.features[k].derived || k === 'rock') continue;
      assert.equal(typeof s[k], 'number', `${s.id}.${k}`);
    }
  }
});

test('targets: known features, valid rocks, bodies and coordinates', () => {
  for (const t of TARGETS) {
    assert.ok(['moon', 'mars'].includes(t.body), t.id);
    assert.ok(Math.abs(t.lat) <= 90 && Math.abs(t.lon) <= 180, t.id);
    for (const k of Object.keys(t.features)) assert.ok(cfg.features[k], `${t.id} unknown feature ${k}`);
    for (const r of t.features.rock || []) assert.ok(cfg.rockLabels[r], `${t.id} rock ${r}`);
    assert.ok(t.refs && t.refs.length, `${t.id} needs a source`);
  }
});

test('presets cover every dimension; rock similarity is symmetric', () => {
  for (const p of cfg.presets) for (const d of cfg.dims) assert.equal(typeof p.weights[d.id], 'number', p.id + '.' + d.id);
  const R = cfg.rockSimilarity;
  for (const a of Object.keys(R)) for (const b of Object.keys(R)) close(R[a][b], R[b][a]);
});
