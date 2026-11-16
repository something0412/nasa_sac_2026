// Saving and loading games. Saves live only on this device (IndexedDB, database "lunar-world").
// To move a game to another computer, export it to a .json file and import it there.
//
// A save is an "envelope" around the game state:
//   { game: 'lunar-world', saveVersion, mapVersion, mode, name, savedAt, summary, lightLen, state }
// The state is saved WITHOUT things we can rebuild from the config (the map tiles and the sunlight
// forecast), which keeps saves small. pack() makes a save, unpack() checks one and turns it back into a game.
//
// When the game rules change and old saves need fixing, raise SAVE_VERSION and add a step to MIGRATE.
// New fields with a simple default need no migration: unpack() fills every missing field from a fresh game.
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});
  const cfg = () => LW.CONFIG;

  const GAME = 'lunar-world';
  const SAVE_VERSION = 1;
  const DROP = ['tiles', 'light']; // rebuilt on load from the config (they never change during a game)

  // MIGRATE[v] turns a version-v state into a version-(v+1) state. Example for later:
  //   1: (s) => { s.research.gym = 0; },
  const MIGRATE = {};

  const MODE_NAMES = { training: 'Training mission', history: 'Real history: May 2024' };
  const modeName = (scenario) => MODE_NAMES[scenario] || scenario;

  // A short fingerprint of the terrain. If the map changes in a later version, old saves may have
  // buildings in odd places, so the player gets a warning (the game still loads).
  let mapVer = null;
  function mapVersion() {
    if (mapVer) return mapVer;
    const C = cfg();
    let h = 0x811c9dc5; // FNV-1a hash of every square's zone
    const add = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } };
    add(C.map.cols + 'x' + C.map.rows);
    for (let r = 0; r < C.map.rows; r++) for (let c = 0; c < C.map.cols; c++) add(C.zoneAt(c, r) + ',');
    return (mapVer = (h >>> 0).toString(16));
  }

  function summary(state) {
    const S = LW.Sim;
    return {
      day: S.day(state.hour),
      hour: state.hour,
      crew: state.crew.length, // everyone still on the Moon (the medbay too)
      buildings: S.built(state).length,
      parts: Math.floor(state.res.parts),
    };
  }

  /**
   * Make a save from the running game. The result is a separate copy (the game can keep running).
   * opts.name: shown in the load list (default: "Training mission · Day 12").
   */
  function pack(state, opts) {
    const slim = {};
    for (const k of Object.keys(state)) if (!DROP.includes(k)) slim[k] = state[k];
    const sum = summary(state);
    return {
      game: GAME,
      saveVersion: SAVE_VERSION,
      mapVersion: mapVersion(),
      mode: state.scenario,
      name: (opts && opts.name) || `${modeName(state.scenario)} · Day ${sum.day}`,
      savedAt: new Date().toISOString(), // (only for the load list; the game rules never read the clock)
      summary: sum,
      lightLen: state.light ? state.light[Object.keys(state.light)[0]].length : 0,
      state: JSON.parse(JSON.stringify(slim)), // a deep copy that is also proof the state is plain data
    };
  }

  /** Fill fields a save is missing (made by an older version) with the defaults of a fresh game. */
  function fillMissing(target, defaults, depth) {
    for (const k of Object.keys(defaults)) {
      const d = defaults[k];
      if (!(k in target)) target[k] = d && typeof d === 'object' ? JSON.parse(JSON.stringify(d)) : d;
      else if (depth > 0 && d && typeof d === 'object' && !Array.isArray(d) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
        fillMissing(target[k], d, depth - 1);
      }
    }
  }

  function fillDefaults(s) {
    const fresh = LW.Sim.create({ scenario: s.scenario, seed: s.seed });
    for (const k of DROP) delete fresh[k];
    // Top-level fields, plus one level inside plain objects (res, stats, history, research, ...).
    fillMissing(s, fresh, 1);
    // Every astronaut and building gets the fields a new one would have.
    const astro = fresh.crew[0];
    for (const a of s.crew.concat(s.sentHome || [])) fillMissing(a, astro, 0);
    // Buildings: the fields every building has, plus the extra ones of its type (a HAB's temp and berm).
    const byType = {}, common = {};
    for (const m of fresh.modules) byType[m.type] = byType[m.type] || m;
    for (const k of Object.keys(fresh.modules[0])) if (fresh.modules.every((m) => k in m)) common[k] = fresh.modules[0][k];
    for (const m of s.modules) {
      fillMissing(m, common, 0);
      if (byType[m.type]) fillMissing(m, byType[m.type], 1);
    }
  }

  /** Rebuild what pack() left out. */
  function rebuild(s, lightLen) {
    const C = cfg();
    s.tiles = [];
    for (let r = 0; r < C.map.rows; r++) for (let c = 0; c < C.map.cols; c++) s.tiles.push(C.zoneAt(c, r));
    s.light = {};
    for (const z of Object.keys(C.zones)) {
      const L = (s.light[z] = []);
      for (let h = 0; h < lightLen; h++) L.push(LW.Sim.zoneLitAt(s, z, h + 0.5));
    }
    if (!lightLen) LW.Sim.extendWorld(s); // (a save without lightLen: make the forecast the normal length)
    // state.berm is the SAME object as the first HAB's .berm (saving makes two copies: link them again).
    const first = s.modules.find((m) => m.type === 'hab');
    s.berm = first ? first.berm : null;
  }

  /**
   * Check a save and turn it into a game state. Never throws.
   * Returns { ok: true, state, warnings: [] } or { ok: false, why }.
   */
  function unpack(env) {
    try {
      if (typeof env === 'string') env = JSON.parse(env);
    } catch (e) {
      return { ok: false, why: 'This file is not a Lunar World save (it is not valid JSON).' };
    }
    if (!env || typeof env !== 'object') return { ok: false, why: 'This is not a Lunar World save.' };
    if (env.game !== GAME) return { ok: false, why: 'This file is not a Lunar World save.' };
    const v = env.saveVersion;
    if (typeof v !== 'number' || v < 1) return { ok: false, why: 'This save is damaged (no version number).' };
    if (v > SAVE_VERSION) return { ok: false, why: 'This save was made by a newer version of Lunar World. Reload the page (Ctrl+F5) to get the newest version.' };
    const st = env.state;
    if (!st || typeof st !== 'object' || typeof st.hour !== 'number' || !Array.isArray(st.crew) || !Array.isArray(st.modules) || !MODE_NAMES[st.scenario]) {
      return { ok: false, why: 'This save is damaged (the game data is missing or broken).' };
    }
    const warnings = [];
    try {
      const s = JSON.parse(JSON.stringify(st)); // our own copy: the envelope stays untouched
      for (let ver = v; ver < SAVE_VERSION; ver++) if (MIGRATE[ver]) MIGRATE[ver](s);
      fillDefaults(s);
      rebuild(s, env.lightLen || 0);
      if (env.mapVersion && env.mapVersion !== mapVersion()) warnings.push('The map changed since this game was saved, so some buildings may stand in odd places.');
      return { ok: true, state: s, warnings };
    } catch (e) {
      return { ok: false, why: 'This save could not be loaded: ' + e.message };
    }
  }

  // ---------- files (move a game between devices) ----------
  function fileName(env) {
    return `${GAME}-${env.mode}-day-${env.summary.day}.json`;
  }
  function exportFile(env) {
    const blob = new Blob([JSON.stringify(env)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileName(env);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  /** Ask the player for a .json file. onEnv(env) gets the parsed envelope, or onEnv(null, why). */
  function pickFile(onEnv) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', () => {
      const f = input.files && input.files[0];
      if (!f) return;
      if (f.size > 50e6) { onEnv(null, 'This file is too big to be a Lunar World save.'); return; }
      f.text().then((txt) => {
        let env;
        try { env = JSON.parse(txt); } catch (e) { onEnv(null, 'This file is not a Lunar World save (it is not valid JSON).'); return; }
        onEnv(env);
      }, () => onEnv(null, 'The file could not be read.'));
    });
    input.click();
  }

  // ---------- this device: IndexedDB ----------
  // Slots: 'manual' (the Save button) and 'auto-0' / 'auto-1' (autosave takes turns, so if one save
  // goes wrong the other one is still there).
  const DB_NAME = GAME, STORE = 'saves';
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!root.indexedDB) { reject(new Error('This browser cannot store saves.')); return; }
      // Some browsers never answer (a page opened from a file, privacy settings): give up after 4 s.
      setTimeout(() => reject(new Error('Saves are not available in this browser right now. Use "Save to a file" instead.')), 4000);
      let req;
      try { req = root.indexedDB.open(DB_NAME, 1); } catch (e) { reject(new Error('Saves are blocked in this browser. Use "Save to a file" instead.')); return; }
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'slot' }); };
      req.onsuccess = () => {
        const d = req.result;
        // Another tab needs to upgrade or delete the database: let go, so it doesn't wait forever.
        d.onversionchange = () => { d.close(); dbp = null; };
        resolve(d);
      };
      req.onerror = () => reject(req.error || new Error('Saves are blocked in this browser (private window?).'));
      req.onblocked = () => reject(new Error('Close the other Lunar World tabs, then try again.'));
    });
    dbp.catch(() => { dbp = null; }); // try again next time
    return dbp;
  }
  function run(mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const tx = d.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Saving failed.'));
    }));
  }
  /** Store a save in a slot. Returns a promise. */
  const put = (slot, env) => run('readwrite', (s) => s.put({ ...env, slot }));
  const get = (slot) => run('readonly', (s) => s.get(slot));
  const remove = (slot) => run('readwrite', (s) => s.delete(slot));
  /** Every save on this device, newest first (only the small info, not the game data). */
  function list() {
    return run('readonly', (s) => s.getAll()).then((all) => all
      .map((e) => ({ slot: e.slot, name: e.name, mode: e.mode, savedAt: e.savedAt, summary: e.summary, saveVersion: e.saveVersion }))
      .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1)));
  }
  /** Which autosave slot to use at this hour: they take turns. */
  const autoSlot = (hour) => 'auto-' + (Math.floor(hour / cfg().save.autoEveryH) % 2);

  LW.Save = { GAME, SAVE_VERSION, pack, unpack, mapVersion, modeName, fileName, exportFile, pickFile, put, get, remove, list, autoSlot };
})(typeof window !== 'undefined' ? window : globalThis);
