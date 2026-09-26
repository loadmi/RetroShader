// Popup UI. Built once into #app and then updated in place (so focus, open dropdowns and slider drags survive
// state changes); writes settings to chrome.storage.local (content scripts update live).
(function () {
  'use strict';
  const CRT = self.CRT;
  const app = document.getElementById('app');
  const iconUrl = new URL('../icons/icon48.png', document.currentScript.src).href;
  let state = CRT.normalizeState();
  let ready = false;
  const ui = {};       // long-lived controls, see sync()
  const inputs = {};   // param key -> {el, valEl, nameEl, update(effectiveParams)}

  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const kid of kids) if (kid != null) e.append(kid);
    return e;
  };

  // ---- Saving ------------------------------------------------------------------------------------
  // Throttled (leading + trailing edge) rather than debounced: a continuous slider drag never pauses long
  // enough for a debounce, so the video would only update once the pointer stops. Discrete changes, slider
  // release and closing the popup write at once.
  const SAVE_INTERVAL = 50;
  let saveTimer = 0, lastSaveAt = -Infinity, dirty = false;
  // Our own writes come back through storage.onChanged. They are recognised by content (canonical JSON:
  // Chrome hands objects back with sorted keys) so a late echo of an older write never undoes newer edits.
  let stored = '';          // what storage was last seen to hold (load or change event)
  const inflight = [];      // our writes whose change event has not arrived yet, oldest first
  const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));

  function save(immediate) {
    dirty = true;
    const wait = immediate ? 0 : lastSaveAt + SAVE_INTERVAL - performance.now();
    if (wait <= 0) flush();
    else if (!saveTimer) saveTimer = setTimeout(flush, wait);
  }
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    if (!dirty) return;
    dirty = false;
    lastSaveAt = performance.now();
    state = CRT.normalizeState(state);
    const json = canon(state);
    // Skip a write that would change nothing: Chrome fires no change event for it, so no echo would come.
    // Compare with what storage holds once our pending writes land, not with the last echo seen: with slow
    // echoes (A, B, back to A) the echo of A arrives after B went out, and skipping the second A would leave B.
    if (json === (inflight.length ? inflight[inflight.length - 1] : stored)) return;
    inflight.push(json);
    if (inflight.length > 32) inflight.shift();
    CRT.saveState(state).catch(e => {
      const i = inflight.lastIndexOf(json);   // a failed write never echoes
      if (i >= 0) inflight.splice(i, 1);
      console.warn('[CRT] saving settings failed', e);
    });
  }

  let gotEarlyState = false;
  function onStorageState(s) {
    const json = canon(s);
    stored = json;
    const i = inflight.indexOf(json);
    if (i >= 0) { inflight.splice(0, i + 1); return; }   // our echo; anything older was a no-op write
    if (!ready) { state = s; gotEarlyState = true; return; }
    // Someone else wrote (a keyboard shortcut in the background: enabled / compare / preset, clearing the
    // overrides on a preset change). With local edits not yet in storage, take those fields but keep our
    // edits, and write the merge back now rather than letting either write silently undo the other.
    if (!dirty && !inflight.length) state = s;
    else {
      state = Object.assign({}, state, { enabled: s.enabled, compare: s.compare, preset: s.preset },
        s.preset !== state.preset ? { overrides: s.overrides } : null);
      save(true);
    }
    sync();
  }

  function fmt(meta, v) {
    if (meta.type !== 'range') return '';
    if (meta.key === 'lines') return v > 0 ? `${v}` : 'auto';
    if (meta.key === 'temperature') return `${v} K`;
    if (meta.step >= 1) return String(Math.round(v));
    const d = meta.step < 0.01 ? 3 : 2;
    return Number(v).toFixed(d);
  }

  // ---- Status line -------------------------------------------------------------------------------
  async function activeTab() {
    if (!chrome.tabs) return null;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  function statusDetail(i) {
    const dims = a => (Array.isArray(a) ? a.join('×') : '');
    const num = v => typeof v === 'number' && Number.isFinite(v);
    const parts = [];
    if (dims(i.video)) parts.push(`${dims(i.video)} video` + (dims(i.out) ? ` → ${dims(i.out)} px` : ''));
    if (num(i.lines)) parts.push(`${i.lines} lines` + (num(i.pxPerLine) ? ` (${i.pxPerLine} px/line)` : ''));
    if (i.mask) parts.push(String(i.mask));
    if (num(i.fps)) parts.push(`${i.fps} fps`);
    return parts.join(' · ');
  }

  let siteHost = null, statusSeq = 0;
  async function refreshStatus() {
    const box = ui.status, seq = ++statusSeq;
    const set = (cls, main, detail) => {
      box.className = 'status ' + cls;
      box.replaceChildren(el('span', { class: 'dot' }), el('b', { text: main }), detail ? el('span', { class: 'detail', text: detail }) : null);
    };
    const tab = await activeTab().catch(() => null);
    let r = null;
    if (tab) { try { r = await chrome.tabs.sendMessage(tab.id, { type: 'crt:status' }); } catch (e) { /* no content script */ } }
    if (seq !== statusSeq) return;   // a newer refresh is under way; the top frame answers late, so order varies
    if (!tab) { set('', 'No tab'); return; }
    if (!r) { set('warn', 'Not available on this page', 'Reload the tab if you just installed the extension.'); return; }
    // Any non-empty host key counts ('local-file' included). Update the site row in place: rebuilding the
    // popup here would tear down whatever the user started in the first ~200 ms.
    if (typeof r.host === 'string' && r.host && r.host !== siteHost) { siteHost = r.host; syncSite(); }
    if (!r.active) set('warn', 'Not active', r.reason || '');
    else if (!r.info || !r.info.shown) set('warn', 'Waiting for video frame');   // overlay exists, nothing drawn
    else set('on', 'CRT active', statusDetail(r.info));
  }

  // ---- Keyboard shortcuts ------------------------------------------------------------------------
  // Show the keys Chrome actually assigned: a suggested key is skipped when another extension already holds
  // it, and users can rebind or clear them. The manifest defaults are only a fallback where chrome.commands
  // is missing (the test harness).
  const COMMANDS = [['toggle-crt', 'on/off'], ['next-preset', 'next preset'], ['toggle-compare', 'compare']];
  const MANIFEST_KEYS = { 'toggle-crt': 'Alt+Shift+C', 'next-preset': 'Alt+Shift+P', 'toggle-compare': 'Alt+Shift+X' };
  async function loadShortcuts() {
    if (chrome.commands && chrome.commands.getAll) {
      try { return Object.fromEntries((await chrome.commands.getAll()).map(c => [c.name, c.shortcut || ''])); }
      catch (e) { /* fall back to the manifest defaults */ }
    }
    return MANIFEST_KEYS;
  }
  const withKey = (text, key) => (key ? `${text} (${key})` : text);
  // A plain <a href="chrome://..."> does not navigate from an extension popup; tabs.create can open it.
  const canOpenShortcuts = !!(chrome.tabs && chrome.tabs.create);
  const openShortcuts = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }).catch(() => {});

  // ---- Controls ----------------------------------------------------------------------------------
  // "Changed" means: differs from the preset (overrides) or from the default (per-monitor display settings).
  function isChanged(meta) {
    if (meta.display) return state.display[meta.key] !== CRT.DEFAULT_STATE.display[meta.key];
    return meta.key in state.overrides && state.overrides[meta.key] !== CRT.presetParams(state.preset)[meta.key];
  }

  function paramControl(meta) {
    const nameEl = el('span', { class: 'name', text: meta.label });
    const valEl = el('span', { class: 'val' });
    let input;
    const onChange = (raw, now) => {
      const val = CRT.clampParam(meta.key, raw);
      if (val === undefined) return;
      if (meta.display) state.display[meta.key] = val;   // describes the monitor: survives preset changes
      else if (val === CRT.presetParams(state.preset)[meta.key]) delete state.overrides[meta.key];
      else state.overrides[meta.key] = val;
      valEl.textContent = fmt(meta, val);
      nameEl.classList.toggle('changed', isChanged(meta));
      syncPresetLabels();
      save(now);
    };
    if (meta.type === 'range') {
      input = el('input', { type: 'range', min: meta.min, max: meta.max, step: meta.step, 'aria-label': meta.label });
      input.addEventListener('input', () => onChange(input.value, false));
      input.addEventListener('change', () => onChange(input.value, true));   // released: write the final value now
    } else if (meta.type === 'select') {
      input = el('select', { 'aria-label': meta.label });
      for (const [ov, label] of meta.options) input.append(el('option', { value: ov, text: label }));
      input.addEventListener('change', () => onChange(input.value, true));
    } else {
      input = el('input', { type: 'checkbox', 'aria-label': meta.label });
      input.addEventListener('change', () => onChange(input.checked, true));
    }
    const update = (eff) => {
      const v = eff[meta.key];
      if (meta.type === 'toggle') input.checked = !!v; else input.value = String(v);
      valEl.textContent = fmt(meta, v);
      nameEl.classList.toggle('changed', isChanged(meta));
    };
    inputs[meta.key] = { el: input, valEl, nameEl, update };
    const cls = 'param' + (meta.advanced ? ' advanced' : '');
    if (meta.type === 'toggle') {
      return el('div', { class: cls }, el('label', { class: 'check' }, input, nameEl), meta.hint ? el('div', { class: 'hint', text: meta.hint }) : null);
    }
    return el('div', { class: cls, title: meta.hint || '' }, el('div', { class: 'top' }, nameEl, valEl), input);
  }

  function syncSite() {
    ui.site.disabled = !siteHost;
    ui.site.checked = !siteHost || !state.disabledSites.includes(siteHost);
    ui.siteLabel.textContent = !siteHost ? 'Enabled on this site'
      : siteHost === 'local-file' ? 'Enabled on local files' : `Enabled on ${siteHost}`;
    ui.siteLabel.title = siteHost || '';
  }

  function syncPresetLabels() {
    const modified = Object.keys(state.overrides).length > 0;
    for (const o of ui.preset.options) {
      const text = CRT.PRESET_BY_ID[o.value].name + (o.value === state.preset && modified ? ' (modified)' : '');
      if (o.textContent !== text) o.textContent = text;
    }
  }

  // Push the whole state into the existing controls. Used instead of rebuilding: on Windows/Linux the arrow
  // keys on a focused closed <select> fire 'change' on every step, and a rebuild would drop focus each time.
  function sync() {
    const eff = CRT.effectiveParams(state);
    ui.power.checked = state.enabled;
    ui.compare.checked = !!state.compare;
    ui.preset.value = state.preset;
    syncPresetLabels();
    const preset = CRT.PRESET_BY_ID[state.preset];
    ui.presetDesc.textContent = preset ? preset.desc : '';
    syncSite();
    for (const c of Object.values(inputs)) c.update(eff);
  }

  function render(keys) {
    ui.status = el('div', { class: 'status' }, el('span', { class: 'dot' }), el('b', { text: 'Checking…' }));
    ui.power = el('input', { type: 'checkbox', 'aria-label': 'Enable CRT effect' });
    ui.power.addEventListener('change', () => { state.enabled = ui.power.checked; save(true); setTimeout(refreshStatus, 300); });

    ui.site = el('input', { type: 'checkbox' });
    ui.siteLabel = el('span');
    ui.site.addEventListener('change', () => {
      if (!siteHost) return;
      state.disabledSites = state.disabledSites.filter(h => h !== siteHost);
      if (!ui.site.checked) state.disabledSites.push(siteHost);
      save(true);
      setTimeout(refreshStatus, 300);
    });

    ui.preset = el('select', { 'aria-label': 'Preset' });
    for (const p of CRT.PRESETS) ui.preset.append(el('option', { value: p.id, text: p.name }));
    // Only the preset tweaks are dropped; state.display (monitor settings) is kept.
    ui.preset.addEventListener('change', () => { state.preset = ui.preset.value; state.overrides = {}; save(true); sync(); });
    ui.presetDesc = el('div', { class: 'preset-desc' });

    ui.compare = el('input', { type: 'checkbox' });
    ui.compare.addEventListener('change', () => { state.compare = ui.compare.checked; save(true); });

    const adv = el('input', { type: 'checkbox' });
    adv.checked = document.body.classList.contains('show-advanced');
    adv.addEventListener('change', () => document.body.classList.toggle('show-advanced', adv.checked));

    const byGroup = new Map();
    for (const m of CRT.PARAMS) {
      if (!byGroup.has(m.group)) byGroup.set(m.group, []);
      byGroup.get(m.group).push(m);
    }
    const groups = [...byGroup].map(([name, metas]) => {
      const d = el('details', {}, el('summary', { text: name }), ...metas.map(paramControl));
      d.open = name === 'Scanlines';
      return d;
    });

    const keyHints = COMMANDS.map(([name, text]) => el('span', {},
      el('kbd', { class: keys[name] ? '' : 'unset', text: keys[name] || 'not set' }), ' ' + text));
    app.replaceChildren(
      el('header', {}, el('img', { src: iconUrl, alt: '' }),
        el('h1', {}, 'RetroShader CRT', el('small', { text: 'Real-time CRT shader for web video' })),
        el('label', { class: 'switch', title: withKey('Enable / disable', keys['toggle-crt']) }, ui.power, el('span'))),
      ui.status,
      el('div', { class: 'row' }, el('label', { class: 'check' }, ui.site, ui.siteLabel),
        el('label', { class: 'check', title: withKey('Left half shows the original video', keys['toggle-compare']) }, ui.compare, el('span', { text: 'Compare' }))),
      ui.preset,
      ui.presetDesc,
      ...groups,
      el('div', { class: 'footer' },
        el('button', { text: 'Reset to preset', title: 'Undo your changes to this preset (display settings are kept)',
          onclick: () => { state.overrides = {}; save(true); sync(); } }),
        el('span', { class: 'spacer' }),
        el('label', { class: 'check' }, adv, el('span', { text: 'Advanced' }))),
      el('div', { class: 'keys' }, ...keyHints,
        canOpenShortcuts ? el('button', { class: 'link', text: 'Change shortcuts', onclick: openShortcuts }) : null),
    );
    sync();
    refreshStatus();
  }

  CRT.onStateChanged(onStorageState);
  Promise.all([CRT.loadState().catch(() => CRT.normalizeState()), loadShortcuts()]).then(([s, keys]) => {
    if (!gotEarlyState) { state = s; stored = canon(s); }
    ready = true;
    render(keys);
  });
  addEventListener('pagehide', flush);   // the popup can close within one throttle interval of the last edit
  setInterval(() => { if (ready) refreshStatus(); }, 1500);
})();
