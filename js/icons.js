// Line icons for saving and loading (floppy disk, open folder, upload, download, check), drawn as small inline
// SVGs: rounded 2 px strokes in the text colour (currentColor), so they follow the button or message they sit in.
(function (root) {
  'use strict';
  const LW = (root.LW = root.LW || {});

  const PATHS = {
    // floppy disk: rounded body with the top-right corner cut off, label tab at the top, round hub
    save: '<path d="M7 3h10l4 4v10a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V7a4 4 0 0 1 4-4z"/><path d="M7.5 3v1.5a3 3 0 0 0 3 3h3a3 3 0 0 0 3-3V3"/><circle cx="12" cy="14.5" r="2.5"/>',
    // open folder: back with a tab, front flap leaning forward
    folder: '<path d="M4.2 20.2A2 2 0 0 1 3 18.4V5.5A2.5 2.5 0 0 1 5.5 3h1.7l3 1.6h6.3A2.5 2.5 0 0 1 19 7.1V10"/><path d="M4 20.5l2.5-8.7A2.5 2.5 0 0 1 8.9 10h11.6a1.2 1.2 0 0 1 1.2 1.5l-2 7.1a2.5 2.5 0 0 1-2.4 1.9H4z"/>',
    // arrow up out of a tray
    upload: '<path d="M12 17V3.5M7.5 8L12 3.5 16.5 8"/><path d="M3 15.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3.5"/>',
    // arrow down into a tray
    download: '<path d="M12 3v13.5M7.5 12l4.5 4.5 4.5-4.5"/><path d="M3 15.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-3.5"/>',
    // tick in a circle (save finished)
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12.4l2.8 2.8L16.2 9.6"/>',
  };

  /** Inline SVG for icon `name`. cls: extra CSS classes (e.g. 'ok' for green). Decorative: the text says what it is. */
  function icon(name, cls) {
    return `<svg class="lineIco${cls ? ' ' + cls : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name] || ''}</svg>`;
  }

  LW.Icons = { icon, names: Object.keys(PATHS) };
})(typeof window !== 'undefined' ? window : globalThis);
