// Shared settings model: parameter metadata, presets, merging and storage helpers.
// Loaded by the content script, the popup and the background worker (classic script, no modules).
(function (root) {
  'use strict';
  const CRT = root.CRT = root.CRT || {};

  // ---- Parameter metadata (drives the popup UI and value clamping) ---------------------------------
  // type: range | select | toggle.  "advanced" params are tucked away in the popup.
  // "display" params describe the user's monitor, not the emulated CRT: they live in state.display, so
  // switching or resetting a preset never touches them.
  const PARAMS = [
    // Raster / scanlines
    { key: 'lines', group: 'Scanlines', label: 'Scanline count', type: 'range', min: 0, max: 600, step: 1,
      hint: 'Virtual CRT lines per picture height. 0 = auto (video height if ≤ 300, else the preset default).' },
    { key: 'autoLines', group: 'Scanlines', label: 'Auto line count', type: 'select', options: [[224, '224'], [240, '240'], [256, '256'], [288, '288 (PAL)'], [480, '480 (TV)'], [576, '576 (PAL TV)']], advanced: true },
    { key: 'snapLines', group: 'Scanlines', label: 'Snap to whole pixels', type: 'toggle',
      hint: 'Nudges the line count so every scanline is a whole number of screen pixels. Great for movies; turn off for pixel-perfect game footage.' },
    { key: 'phase', group: 'Scanlines', label: 'Line phase', type: 'range', min: 0, max: 1, step: 0.01, advanced: true,
      hint: 'Shifts the scanline grid vertically to line it up with the original pixels of game footage.' },
    { key: 'sigmaDark', group: 'Scanlines', label: 'Beam width (dark)', type: 'range', min: 0.12, max: 0.5, step: 0.005 },
    { key: 'sigmaBright', group: 'Scanlines', label: 'Beam width (bright)', type: 'range', min: 0.15, max: 0.6, step: 0.005 },
    { key: 'beamShape', group: 'Scanlines', label: 'Beam edge hardness', type: 'range', min: 2, max: 4, step: 0.05, advanced: true },
    { key: 'sharpX', group: 'Scanlines', label: 'Horizontal softness', type: 'range', min: 0.15, max: 1.2, step: 0.01 },
    { key: 'hRes', group: 'Scanlines', label: 'Horizontal resolution', type: 'range', min: 160, max: 960, step: 8, advanced: true,
      hint: 'Virtual pixels across a 4:3 picture. Softness is measured in these pixels.' },
    { key: 'convergence', group: 'Scanlines', label: 'Convergence error', type: 'range', min: 0, max: 0.6, step: 0.01, advanced: true },

    // Mask
    { key: 'maskType', group: 'Phosphor mask', label: 'Mask type', type: 'select',
      options: [['auto', 'Auto (by preset)'], ['aperture', 'Aperture grille (Trinitron)'], ['slot', 'Slot mask (TV)'], ['shadow', 'Shadow mask (dots)'], ['mono', 'Mono grille (safe)'], ['none', 'Off']] },
    { key: 'maskTVL', group: 'Phosphor mask', label: 'Mask density (TVL)', type: 'range', min: 150, max: 1000, step: 10,
      hint: 'Phosphor triads per picture height. Consumer TVs ≈ 300–400, PVMs ≈ 600+.' },
    { key: 'maskStrength', group: 'Phosphor mask', label: 'Mask strength', type: 'range', min: 0, max: 1, step: 0.01 },
    { key: 'slotStrength', group: 'Phosphor mask', label: 'Slot bar strength', type: 'range', min: 0, max: 1, step: 0.01, advanced: true },
    { key: 'subpixel', group: 'Phosphor mask', label: 'Screen subpixel order', type: 'select', options: [['rgb', 'RGB (most monitors)'], ['bgr', 'BGR']], advanced: true, display: true,
      hint: 'Your monitor’s subpixel layout, so the mask lines up with it. Kept when you change preset.' },

    // Light
    { key: 'boost', group: 'Light & glow', label: 'Brightness', type: 'range', min: 0.8, max: 2, step: 0.01 },
    { key: 'bloom', group: 'Light & glow', label: 'Bloom', type: 'range', min: 0, max: 0.8, step: 0.01,
      hint: 'Bright areas glow and swallow the scanline gaps, like an electron beam at high current.' },
    { key: 'bloomRadius', group: 'Light & glow', label: 'Bloom radius', type: 'range', min: 0.4, max: 3, step: 0.05, advanced: true },
    { key: 'halation', group: 'Light & glow', label: 'Halation', type: 'range', min: 0, max: 0.12, step: 0.002,
      hint: 'Soft wide haze from light bouncing inside the glass.' },
    { key: 'halationRadius', group: 'Light & glow', label: 'Halation radius', type: 'range', min: 0.01, max: 0.1, step: 0.002, advanced: true },
    { key: 'gammaIn', group: 'Light & glow', label: 'CRT gamma', type: 'range', min: 2.0, max: 2.8, step: 0.01, advanced: true },
    { key: 'gammaOut', group: 'Light & glow', label: 'Display gamma', type: 'range', min: 1.8, max: 2.6, step: 0.01, advanced: true, display: true,
      hint: 'Your monitor’s gamma. Kept when you change preset.' },

    // Colour
    { key: 'saturation', group: 'Colour', label: 'Saturation', type: 'range', min: 0, max: 1.6, step: 0.01 },
    { key: 'temperature', group: 'Colour', label: 'White point (K)', type: 'range', min: 5000, max: 11000, step: 50 },
    { key: 'blackLevel', group: 'Colour', label: 'Black level', type: 'range', min: -0.05, max: 0.08, step: 0.002, advanced: true },

    // Signal
    { key: 'signal', group: 'Signal', label: 'Video cable', type: 'select',
      options: [['rgb', 'RGB (clean)'], ['svideo', 'S-Video'], ['composite', 'Composite'], ['rf', 'RF (antenna)']],
      hint: 'Composite blends dithering and bleeds colour — the “free transparency” retro games relied on.' },
    { key: 'artifacts', group: 'Signal', label: 'Composite artifacts', type: 'range', min: 0, max: 1, step: 0.01,
      hint: 'Rainbow / dot-crawl cross-talk. Looks great on pixel art, can look like noise on film.' },
    { key: 'sharpness', group: 'Signal', label: 'TV sharpness', type: 'range', min: 0, max: 1, step: 0.01, advanced: true },
  ];

  // ---- Presets ------------------------------------------------------------------------------------
  const BASE = {
    lines: 0, autoLines: 240, snapLines: false, phase: 0,
    sigmaDark: 0.22, sigmaBright: 0.34, beamShape: 2, sharpX: 0.5, hRes: 320, convergence: 0.12,
    maskType: 'auto', maskTVL: 360, maskStrength: 0.75, slotStrength: 0.55, subpixel: 'rgb',
    boost: 1.2, bloom: 0.3, bloomRadius: 1.0, halation: 0.03, halationRadius: 0.04, gammaIn: 2.4, gammaOut: 2.2,
    saturation: 1.05, temperature: 6500, blackLevel: 0,
    signal: 'composite', artifacts: 0, sharpness: 0.3,
    // Not user-facing: which mask family "auto" resolves to for this preset.
    autoMask: 'slot',
  };

  const PRESETS = [
    { id: 'consumer', name: 'Consumer TV (default)', desc: '90s living-room TV: soft glowing lines, slot mask, composite colour bleed.', params: {} },
    { id: 'trinitron', name: 'Trinitron TV', desc: 'Sony-style aperture grille, S-Video, slightly cool white.',
      params: { autoMask: 'aperture', maskTVL: 400, maskStrength: 0.8, sigmaDark: 0.22, sigmaBright: 0.37, sharpX: 0.42,
        signal: 'svideo', temperature: 8000, saturation: 1.08, bloom: 0.3, convergence: 0.08 } },
    { id: 'pvm', name: 'PVM / BVM monitor', desc: 'Broadcast monitor over RGB: crisp, deep scanline gaps, fine grille.',
      params: { autoMask: 'aperture', maskTVL: 600, maskStrength: 0.85, sigmaDark: 0.17, sigmaBright: 0.29, beamShape: 2.6,
        sharpX: 0.3, signal: 'rgb', bloom: 0.15, bloomRadius: 0.7, halation: 0.015, convergence: 0, saturation: 1.0, boost: 1.3 } },
    { id: 'arcade', name: 'Arcade cabinet', desc: 'Low-res RGB arcade monitor: chunky lines, dot mask, punchy colour.',
      params: { autoMask: 'shadow', maskTVL: 300, maskStrength: 0.8, sigmaDark: 0.2, sigmaBright: 0.4, sharpX: 0.38,
        signal: 'rgb', saturation: 1.12, bloom: 0.45, halation: 0.035, boost: 1.25, convergence: 0.1 } },
    { id: 'composite', name: 'Composite console', desc: 'Cheap composite cable: dithering melts, rainbow artifacts on stripes.',
      params: { signal: 'composite', artifacts: 0.75, sharpness: 0.45, sigmaDark: 0.25, sigmaBright: 0.42, bloom: 0.4, convergence: 0.2 } },
    { id: 'movies', name: 'Living-room TV (movies)', desc: 'For films and TV: 480-line interlaced look, gentle mask, warm glow.',
      params: { autoLines: 480, snapLines: true, sigmaDark: 0.3, sigmaBright: 0.45, sharpX: 0.55, hRes: 440,
        maskTVL: 330, maskStrength: 0.5, bloom: 0.3, halation: 0.04, signal: 'composite', artifacts: 0, gammaIn: 2.35, saturation: 1.0 } },
    { id: 'subtle', name: 'Subtle', desc: 'Just a hint of CRT: light lines and mask, no signal degradation.',
      params: { sigmaDark: 0.3, sigmaBright: 0.45, maskStrength: 0.4, autoMask: 'aperture', signal: 'rgb', bloom: 0.2,
        halation: 0.015, convergence: 0, boost: 1.08, saturation: 1.0, gammaIn: 2.3 } },
  ];

  const PRESET_BY_ID = Object.fromEntries(PRESETS.map(p => [p.id, p]));
  const PARAM_BY_KEY = Object.fromEntries(PARAMS.map(p => [p.key, p]));

  function presetParams(id) {
    const p = PRESET_BY_ID[id] || PRESET_BY_ID.consumer;
    return Object.assign({}, BASE, p.params);
  }

  function clampParam(key, value) {
    const meta = PARAM_BY_KEY[key];
    if (!meta) return value;
    if (meta.type === 'range') {
      const v = Number(value);
      if (!Number.isFinite(v)) return undefined;
      return Math.min(meta.max, Math.max(meta.min, v));
    }
    if (meta.type === 'toggle') return !!value;
    if (meta.type === 'select') {
      const ok = meta.options.some(([v]) => String(v) === String(value));
      if (!ok) return undefined;
      return typeof meta.options[0][0] === 'number' ? Number(value) : String(value);
    }
    return value;
  }

  // Stored state shape (chrome.storage.local, key STORAGE_KEY):
  //   { enabled: bool, preset: id, overrides: {key: value}, display: {subpixel, gammaOut},
  //     disabledSites: [host], compare: bool }
  // overrides are tweaks on top of the preset (cleared on preset change / reset); display is per-monitor.
  const STORAGE_KEY = 'crt:state';
  const DISPLAY_KEYS = PARAMS.filter(p => p.display).map(p => p.key);
  const DEFAULT_DISPLAY = Object.fromEntries(DISPLAY_KEYS.map(k => [k, BASE[k]]));
  const DEFAULT_STATE = { enabled: true, preset: 'consumer', overrides: {}, display: DEFAULT_DISPLAY, disabledSites: [], compare: false };
  const MAX_SITES = 500;

  const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

  function normalizeState(s) {
    const st = Object.assign({}, DEFAULT_STATE, s || {});
    if (!PRESET_BY_ID[st.preset]) st.preset = 'consumer';
    st.overrides = isObject(st.overrides) ? Object.assign({}, st.overrides) : {};
    // Display settings used to be stored as overrides; migrate them so a preset change no longer wipes them.
    // An explicit display value wins over a leftover override.
    const disp = s && isObject(s.display) ? s.display : {};   // not st.display: that holds the defaults
    st.display = {};
    for (const k of DISPLAY_KEYS) {
      const raw = k in disp ? disp[k] : st.overrides[k];
      const v = raw === undefined ? undefined : clampParam(k, raw);
      st.display[k] = v === undefined ? DEFAULT_DISPLAY[k] : v;
      delete st.overrides[k];
    }
    // Dedupe keeping each host's newest position, then keep the newest MAX_SITES (the popup appends).
    const sites = Array.isArray(st.disabledSites) ? st.disabledSites.filter(h => typeof h === 'string' && h) : [];
    st.disabledSites = [...new Set(sites.reverse())].reverse().slice(-MAX_SITES);
    return st;
  }

  // Effective shader parameters for a state: preset, then overrides, then the monitor's display settings.
  function effectiveParams(state) {
    const st = normalizeState(state);
    const out = presetParams(st.preset);
    for (const [k, v] of Object.entries(st.overrides)) {
      if (!(k in BASE)) continue;
      const c = clampParam(k, v);
      if (c !== undefined) out[k] = c;
    }
    Object.assign(out, st.display);
    out.compare = !!st.compare;
    return out;
  }

  // ---- Colour helpers ------------------------------------------------------------------------------
  // CIE xy of a Planckian radiator (Kim et al. 2002 cubic approximation, 1667 K .. 25000 K).
  function planckXY(T) {
    T = Math.min(25000, Math.max(1667, T));
    const t = 1e3 / T, t2 = t * t, t3 = t2 * t;
    const x = T <= 4000
      ? -0.2661239 * t3 - 0.2343589 * t2 + 0.8776956 * t + 0.179910
      : -3.0258469 * t3 + 2.1070379 * t2 + 0.2226347 * t + 0.240390;
    const x2 = x * x, x3 = x2 * x;
    let y;
    if (T <= 2222) y = -1.1063814 * x3 - 1.34811020 * x2 + 2.18555832 * x - 0.20219683;
    else if (T <= 4000) y = -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867;
    else y = 3.0817580 * x3 - 5.87338670 * x2 + 3.75112997 * x - 0.37001483;
    return [x, y];
  }
  function xyToLinearSRGB([x, y]) {
    const X = x / y, Y = 1, Z = (1 - x - y) / y;
    return [
      3.2406 * X - 1.5372 * Y - 0.4986 * Z,
      -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
      0.0557 * X - 0.2040 * Y + 1.0570 * Z,
    ];
  }
  // Per-channel linear gains that shift white from 6500 K to T, normalised so the largest gain is 1.
  // Relative to the Planckian 6500 K point so that 6500 is exactly neutral.
  function whiteGains(T) {
    const a = xyToLinearSRGB(planckXY(T)), b = xyToLinearSRGB(planckXY(6500));
    const g = a.map((v, i) => v / b[i]);
    const m = Math.max(g[0], g[1], g[2]);
    return g.map(v => v / m);
  }

  // ---- Storage helpers (work in extension pages and content scripts) -------------------------------
  function hasStorage() { return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local; }
  async function loadState() {
    if (!hasStorage()) return normalizeState();
    const r = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeState(r[STORAGE_KEY]);
  }
  async function saveState(state) {
    if (!hasStorage()) return;
    await chrome.storage.local.set({ [STORAGE_KEY]: normalizeState(state) });
  }
  function onStateChanged(cb) {
    if (!hasStorage()) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes[STORAGE_KEY]) cb(normalizeState(changes[STORAGE_KEY].newValue));
    });
  }

  Object.assign(CRT, {
    PARAMS, PARAM_BY_KEY, PRESETS, PRESET_BY_ID, BASE, STORAGE_KEY, DEFAULT_STATE, DISPLAY_KEYS,
    presetParams, clampParam, normalizeState, effectiveParams, whiteGains,
    loadState, saveState, onStateChanged,
  });
})(typeof self !== 'undefined' ? self : this);
