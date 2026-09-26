// Content script: finds the main <video>, overlays a WebGL CRT canvas on it and keeps it in sync.
(function () {
  'use strict';
  const CRT = self.CRT;
  if (!CRT || self.__crtContentLoaded) return;
  self.__crtContentLoaded = true;

  const MIN_W = 200, MIN_H = 112;           // ignore thumbnails (CSS px)
  const PREVIEW_AREA = 1 / 6;               // muted, control-less videos below this share of the viewport look like hover previews
  const CONTROLS_PX = 64;                   // height of Chrome's native control strip
  const DWELL_MS = 1000, QUICK_DWELL_MS = 200;
  const ORPHAN_MS = 3000;                   // how long a removed video's overlay waits for a replacement video
  const LOST_TIMEOUT_MS = 5000;             // a lost context not restored by then is treated as gone
  const MAX_GPU_FAILURES = 5;               // per page; beyond that we stop creating contexts
  const LOADING = 'video is loading';
  const TAINTED = 'video is cross-origin (the site does not allow reading its pixels)';
  const VIDEO_EVENTS = ['loadstart', 'emptied', 'loadedmetadata', 'loadeddata', 'seeked', 'resize', 'play', 'playing', 'pause'];
  const ROOT_EVENTS = ['loadstart', 'emptied', 'loadedmetadata', 'loadeddata', 'play', 'playing', 'pause', 'resize'];
  const INPUT_EVENTS = ['pointerdown', 'focusin', 'keydown'];
  const TRACK_EVENTS = ['change', 'addtrack', 'removetrack'];
  const isTop = window === window.top;
  const canPopover = typeof HTMLElement === 'function' && typeof HTMLElement.prototype.showPopover === 'function';
  const domApi = typeof chrome !== 'undefined' && chrome.dom && typeof chrome.dom.openOrClosedShadowRoot === 'function'
    ? chrome.dom : null;

  const tainted = new WeakMap();            // video -> currentSrc WebGL was refused for (cross-origin without CORS)
  let gpuFailed = new WeakMap();            // video -> {count, until, reason}: back off before building a context again
  let gpuFailures = 0;
  let webgl2Unavailable = false;            // latched from the Renderer constructor for this page
  let state = CRT.normalizeState();
  let params = CRT.effectiveParams(state);
  let ready = false;                        // the stored state is loaded (the default one may be wrong for this site)
  let overlay = null;                       // the one overlay in this frame
  let lastReason = 'no video found';
  let videoCount = 0;

  function siteHost() {
    try {
      const ao = location.ancestorOrigins;
      if (ao && ao.length) {
        const last = ao[ao.length - 1];
        // file:, data: and sandboxed top pages serialise as 'file://' or 'null': share the top frame's key.
        if (last === 'null' || last.startsWith('file:')) return 'local-file';
        return new URL(last).hostname || 'local-file';
      }
    } catch (e) { /* ignore */ }
    return location.hostname || 'local-file';
  }
  const HOST = siteHost();
  const enabledHere = () => state.enabled && !state.disabledSites.includes(HOST);

  // ---------------------------------------------------------------------------------------------
  // Small DOM helpers
  const num = (s) => parseFloat(s) || 0;
  const px = (n) => (Math.round(n * 1000) / 1000) + 'px';   // never exponent notation, which CSS rejects

  // Inline !important beats page rules (and the popover UA sheet); writes are skipped when nothing changed.
  function put(el, cache, prop, val) {
    if (cache[prop] === val) return;
    cache[prop] = val;
    el.style.setProperty(prop, val, 'important');
  }

  // Parent in the flat (rendered) tree: slots and shadow hosts included.
  function flatParent(n) {
    if (n.assignedSlot) return n.assignedSlot;
    if (n.parentElement) return n.parentElement;
    const p = n.parentNode;
    return p && p.nodeType === 11 ? p.host || null : null;
  }
  function flatContains(a, n) {
    for (let i = 0; n && i < 4096; i++, n = flatParent(n)) if (n === a) return true;
    return false;
  }
  function composedContains(a, n) {
    for (let i = 0; n && i < 4096; i++) {
      if (n === a) return true;
      n = n.parentNode || (n.nodeType === 11 ? n.host : null);
    }
    return false;
  }

  function closedRoot(el) {
    try { return domApi.openOrClosedShadowRoot(el) || null; } catch (e) { return null; }
  }
  const rootOf = (el) => el.shadowRoot || (domApi ? closedRoot(el) : null);

  // document.fullscreenElement is retargeted to the outermost shadow host; descend to the real element.
  function fullscreenState() {
    const outer = document.fullscreenElement;
    if (!outer) return null;
    let real = outer;
    for (let i = 0; i < 32; i++) {
      const sr = rootOf(real);
      const inner = sr && sr.fullscreenElement;
      if (!inner || inner === real) break;
      real = inner;
    }
    return { outer, real };
  }
  function insideFullscreen(fs, n) {
    if (flatContains(fs.real, n)) return true;
    // Closed shadow roots hide assignedSlot, so slotted content only shows up under the retargeted element.
    return fs.real !== fs.outer && fs.real.localName !== 'video' && composedContains(fs.outer, n);
  }

  // ---------------------------------------------------------------------------------------------
  // Geometry: where the picture actually is inside the <video> box (object-fit / object-position).

  // Fractional, untransformed box sizes: clientWidth/offsetWidth round to integers and leave slivers.
  function boxMetrics(v, cs) {
    const pl = num(cs.paddingLeft), pr = num(cs.paddingRight), pt = num(cs.paddingTop), pb = num(cs.paddingBottom);
    const bl = num(cs.borderLeftWidth), br = num(cs.borderRightWidth), bt = num(cs.borderTopWidth), bb = num(cs.borderBottomWidth);
    let cw = parseFloat(cs.width), ch = parseFloat(cs.height);
    if (!Number.isFinite(cw) || !Number.isFinite(ch)) { cw = v.clientWidth - pl - pr; ch = v.clientHeight - pt - pb; }
    else if (cs.boxSizing === 'border-box') { cw -= pl + pr + bl + br; ch -= pt + pb + bt + bb; }   // resolved size is the border box then
    cw = Math.max(0, cw); ch = Math.max(0, ch);
    return { cw, ch, pl, pt, bl, bt, bw: cw + pl + pr + bl + br, bh: ch + pt + pb + bt + bb };
  }

  // Split on whitespace outside parentheses, so 'calc(100% - 16px) 100%' stays two tokens.
  function splitTokens(s) {
    const out = [];
    let depth = 0, cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      else if (ch === ')') depth = Math.max(0, depth - 1);
      if (depth === 0 && /\s/.test(ch)) { if (cur) out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  }

  // <length-percentage> (px, % or a calc() sum of them) -> px, given the free space on that axis. NaN if unknown.
  function lengthPct(tok, free) {
    let s = tok.trim().toLowerCase();
    if (s.startsWith('calc(') && s.endsWith(')')) s = s.slice(5, -1);
    else if (s.includes('(')) return NaN;                           // min(), max(), clamp(): not produced for computed values
    let sum = 0, terms = 0;
    const rest = s.replace(/([+-]?)\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(%|px)?/g, (m, sign, n, unit) => {
      let v = parseFloat(n);
      if (sign === '-') v = -v;
      sum += unit === '%' ? free * v / 100 : v;                     // a unitless term can only be 0
      terms++;
      return '';
    });
    return terms && !/[^\s()]/.test(rest) ? sum : NaN;
  }

  const isXKw = (k) => k === 'left' || k === 'right';
  const isYKw = (k) => k === 'top' || k === 'bottom';
  const isKw = (k) => isXKw(k) || isYKw(k) || k === 'center';
  function axisPos(tok, free) {
    if (tok === undefined || tok === 'center') return free * 0.5;
    if (tok === 'left' || tok === 'top') return 0;
    if (tok === 'right' || tok === 'bottom') return free;
    return lengthPct(tok, free);
  }
  // Offset measured from the named edge (4-value syntax: 'right 16px bottom 0px').
  function edgePos(kw, off, free) {
    if (kw === 'center') return free * 0.5;
    const far = kw === 'right' || kw === 'bottom';
    if (off === undefined) return far ? free : 0;
    const d = lengthPct(off, free);
    return far ? free - d : d;
  }

  // object-position -> [x, y] offset of the picture inside the content box. Falls back to centred when unparsable.
  function objectPos(value, freeX, freeY) {
    const t = splitTokens(value || '');
    let x = NaN, y = NaN;
    if (t.length <= 2) {
      let [a, b] = t;
      if (isYKw(a) || isXKw(b)) [a, b] = [b, a];
      x = axisPos(a, freeX); y = axisPos(b, freeY);
    } else {
      let cx = false, cy = false, centers = 0;
      for (let i = 0; i < t.length; i++) {
        const k = t[i];
        if (!isKw(k)) { x = y = NaN; break; }
        const off = i + 1 < t.length && !isKw(t[i + 1]) ? t[++i] : undefined;
        if (isXKw(k)) { x = edgePos(k, off, freeX); cx = true; }
        else if (isYKw(k)) { y = edgePos(k, off, freeY); cy = true; }
        else centers++;
      }
      if (centers && !cx) x = freeX * 0.5;
      if (centers && !cy) y = freeY * 0.5;
    }
    return [Number.isFinite(x) ? x : freeX * 0.5, Number.isFinite(y) ? y : freeY * 0.5];
  }

  // Picture rect relative to the video's border-box origin, plus the UV crop of the part that is visible.
  function contentRect(video, cs = getComputedStyle(video), box = boxMetrics(video, cs)) {
    const W = box.cw, H = box.ch;
    const vw = video.videoWidth, vh = video.videoHeight;
    let sx = 1, sy = 1;
    const fit = cs.objectFit || 'contain';
    if (vw && vh) {
      if (fit === 'fill') { sx = W / vw; sy = H / vh; }
      else if (fit === 'cover') { sx = sy = Math.max(W / vw, H / vh); }
      else if (fit === 'none') { sx = sy = 1; }
      else if (fit === 'scale-down') { sx = sy = Math.min(1, Math.min(W / vw, H / vh)); }
      else { sx = sy = Math.min(W / vw, H / vh); }
    }
    const w = vw * sx, h = vh * sy;
    const [x, y] = objectPos(cs.objectPosition || '50% 50%', W - w, H - h);
    // Clip the picture to the element box; the hidden part becomes a UV crop.
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
    const crop = w > 0 && h > 0
      ? [(x0 - x) / w, (y0 - y) / h, (x1 - x) / w, (y1 - y) / h]
      : [0, 0, 1, 1];
    return {
      left: box.bl + box.pl + x0, top: box.bt + box.pt + y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0),
      crop, pw: w, ph: h, box,
    };
  }

  function isTranslateOnly(cs) {
    if ((cs.scale || 'none') !== 'none' || (cs.rotate || 'none') !== 'none') return false;
    const t = cs.transform;
    if (!t || t === 'none') return true;
    const m = /^matrix(3d)?\((.*)\)$/.exec(t);
    if (!m) return false;
    const a = m[2].split(',').map(Number);
    if (!m[1]) return a[0] === 1 && a[1] === 0 && a[2] === 0 && a[3] === 1;
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0].every((v, i) => a[i] === v) && a[15] === 1;   // e.g. translateZ(0)
  }

  // A static element with these properties paints as its own layer (like a positioned box), not as flow content.
  function paintsAsLayer(cs) {
    return cs.transform !== 'none' || (cs.translate || 'none') !== 'none' || (cs.rotate || 'none') !== 'none' ||
      (cs.scale || 'none') !== 'none' || parseFloat(cs.opacity) < 1 || cs.filter !== 'none' ||
      cs.mixBlendMode !== 'normal' || cs.isolation === 'isolate' || cs.clipPath !== 'none' ||
      (cs.maskImage || cs.webkitMaskImage || 'none') !== 'none' || (cs.backdropFilter || 'none') !== 'none' ||
      cs.perspective !== 'none' || /paint|layout|strict|content/.test(cs.contain) ||
      /transform|opacity|filter|translate|rotate|scale|perspective/.test(cs.willChange);
  }

  // Does this ancestor contain absolutely positioned descendants (i.e. is it the host's containing block)?
  function containsAbsolute(s) {
    return s.position !== 'static' || s.transform !== 'none' || (s.translate || 'none') !== 'none' ||
      (s.rotate || 'none') !== 'none' || (s.scale || 'none') !== 'none' || s.perspective !== 'none' ||
      s.filter !== 'none' || (s.backdropFilter || 'none') !== 'none' || /paint|layout|strict|content/.test(s.contain) ||
      /transform|perspective|filter/.test(s.willChange) || /size/.test(s.containerType || '');
  }

  function flexOrGridItem(v) {
    let p = flatParent(v);
    while (p && getComputedStyle(p).display === 'contents') p = flatParent(p);
    return !!p && /flex|grid/.test(getComputedStyle(p).display);
  }

  // Where the host goes in the tree and which z-index it takes, so it paints right above the video.
  function placement(v, cs) {
    if (cs.position !== 'static') return { first: false, z: cs.zIndex };
    const zApplies = cs.zIndex !== 'auto' && flexOrGridItem(v);
    // A video that paints as a layer is matched by following it in tree order with the same z-index.
    if (zApplies || paintsAsLayer(cs)) return { first: false, z: zApplies ? cs.zIndex : 'auto' };
    // Components find their media among their light children (media-chrome: first [slot=media], others:
    // firstElementChild), so never go first there. Slotted light children only render through the shadow tree anyway.
    const p = v.parentNode;
    if (p && p.nodeType === 1 && (p.localName.includes('-') || rootOf(p))) return { first: false, z: 'auto' };
    // Plain flow content paints below every positioned box. As the parent's first child the host paints just above
    // the video but below positioned siblings (site overlays, play buttons, captions) that came after it before.
    return { first: true, z: 'auto' };
  }

  function cueElement(cue) {
    const line = document.createElement('div');
    const s = document.createElement('span');
    const ss = s.style;
    ss.setProperty('background', 'rgba(0,0,0,0.8)');
    ss.setProperty('padding', '0.05em 0.3em');
    ss.setProperty('white-space', 'pre-line');
    ss.setProperty('box-decoration-break', 'clone');
    ss.setProperty('-webkit-box-decoration-break', 'clone');
    let frag = null;
    // getCueAsHTML() only builds b/i/u/span/ruby/rt nodes, never script or attributes beyond class/lang.
    try { frag = typeof cue.getCueAsHTML === 'function' ? cue.getCueAsHTML() : null; } catch (e) { frag = null; }
    if (frag) s.append(frag); else s.textContent = cue.text || '';
    line.append(s);
    return line;
  }

  // ---------------------------------------------------------------------------------------------
  class Overlay {
    constructor(video) {
      this.canvas = document.createElement('canvas');
      // Renderer first: if WebGL setup throws, nothing has been attached or subscribed yet.
      this.renderer = new CRT.Renderer(this.canvas, {
        onContextLost: () => this.onContextLost(),
        onContextRestored: () => this.onContextRestored(),
      });
      this.video = null;
      this.dead = false;
      this.shown = false;
      this.suspended = null;                // reason while parked: canvas hidden, nothing rendered
      this.topLayer = false;
      this.contextLosses = 0;
      this.orphanedAt = 0;
      this.hostCss = {}; this.canvasCss = {}; this.capCss = {};
      this.loopGen = 0; this.vfc = 0; this.rafId = 0; this.syncRaf = 0; this.kickRaf = 0;
      this.revealUntil = 0; this.ctrlInset = 0; this.capPad = 0; this.parkCheck = 0;
      this.tracks = []; this.cues = [];
      this.fps = 0; this.fpsFrames = 0; this.fpsT0 = performance.now();
      try {
        this.renderer.setParams(params);
        this.build();
        this.bind(video);
      } catch (e) {
        this.destroy();
        throw e;
      }
    }

    build() {
      // The host covers the video's border box and copies its transform; the canvas sits at the picture rect inside.
      const H = this.host = document.createElement('div');
      H.setAttribute('data-crt-overlay', '');
      H.style.setProperty('all', 'initial', 'important');
      for (const [k, v] of Object.entries({
        display: 'block', position: 'absolute', left: '0px', top: '0px', right: 'auto', bottom: 'auto', width: '0px', height: '0px',
        margin: '0', padding: '0', border: '0', overflow: 'hidden', background: 'transparent', 'pointer-events': 'none',
        'box-sizing': 'content-box', contain: 'strict', 'clip-path': 'none',
      })) put(H, this.hostCss, k, v);
      const shadow = H.attachShadow({ mode: 'closed' });
      for (const [k, v] of Object.entries({
        position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', display: 'block',
        margin: '0', padding: '0', border: '0', 'pointer-events': 'none', visibility: 'hidden', 'clip-path': 'none',
      })) put(this.canvas, this.canvasCss, k, v);
      // Native <track> cues are drawn inside the video box, under the canvas: redraw them above it.
      const cap = this.captions = document.createElement('div');
      for (const [k, v] of Object.entries({
        position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px', display: 'flex', 'flex-direction': 'column',
        'justify-content': 'flex-end', 'align-items': 'center', 'box-sizing': 'border-box', padding: '0 3%', overflow: 'hidden',
        'pointer-events': 'none', visibility: 'hidden', color: '#fff', 'font-family': 'sans-serif', 'line-height': '1.25',
        'text-align': 'center',
      })) put(cap, this.capCss, k, v);
      shadow.append(this.canvas, cap);

      this.ro = new ResizeObserver(entries => this.onResize(entries));
      try { this.ro.observe(this.canvas, { box: 'device-pixel-content-box' }); }
      catch (e) { this.ro.observe(this.canvas); }
      // Sync straight from the observer so size changes land in the same frame.
      this.vro = new ResizeObserver(() => this.syncGeometry());

      this.onMediaEvent = (e) => {
        const t = e.type;
        if (t === 'emptied' || t === 'loadstart') { this.hideCanvas(); this.renderer.hasFrame = false; }
        if (t === 'resize' || t === 'loadedmetadata') this.syncGeometry();
        if (t === 'play' || t === 'pause') this.updateControlsClip();
        // Resume right after a src swap instead of waiting for the idle-time evaluation.
        if (this.suspended === LOADING && (t === 'loadedmetadata' || t === 'loadeddata')) queueMicrotask(evaluate);
        this.kick();
      };
      this.onInput = () => { if (this.shown) this.revealControls(); };
      this.onPointer = (e) => {
        const r = this.vr;
        if (!r || !this.shown || !this.nativeControls()) return;
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) this.revealControls();
      };
      this.onTracks = () => this.refreshTracks();
      this.onCue = () => this.renderCues();
      document.addEventListener('pointermove', this.onPointer, { capture: true, passive: true });
      this.geomTimer = setInterval(() => this.syncGeometry(true), 500);   // safety net for changes no event reports
    }

    bind(video) {
      this.video = video;
      this.vcs = getComputedStyle(video);   // live: always reflects the current computed style
      this.resetGeometry();
      this.orphanedAt = 0;
      for (const ev of VIDEO_EVENTS) video.addEventListener(ev, this.onMediaEvent);
      for (const ev of INPUT_EVENTS) video.addEventListener(ev, this.onInput, { passive: true });
      const tt = video.textTracks;
      if (tt) for (const ev of TRACK_EVENTS) tt.addEventListener(ev, this.onTracks);
      this.vro.observe(video, { box: 'border-box' });
      this.refreshTracks();
      this.syncGeometry(true);
      this.updateControlsClip();
      this.startLoop();
      this.kick();
    }

    unbind() {
      const v = this.video;
      if (!v) return;
      this.stopLoop();
      if (this.onMediaEvent) for (const ev of VIDEO_EVENTS) v.removeEventListener(ev, this.onMediaEvent);
      if (this.onInput) for (const ev of INPUT_EVENTS) v.removeEventListener(ev, this.onInput);
      const tt = v.textTracks;
      if (tt && this.onTracks) for (const ev of TRACK_EVENTS) tt.removeEventListener(ev, this.onTracks);
      for (const t of this.tracks) t.removeEventListener('cuechange', this.onCue);
      this.tracks = []; this.cues = [];
      if (this.captions) this.captions.replaceChildren();
      if (this.vro) this.vro.unobserve(v);
    }

    // Move the existing context to another video instead of building a new one (context + 6 programs).
    retarget(video) {
      if (this.dead || video === this.video) return;
      this.leaveTopLayer();
      this.unbind();
      this.renderer.hasFrame = false;       // never show the previous video's last frame over the new one
      this.hideCanvas();
      this.suspended = null;
      clearTimeout(this.orphanTimer);
      this.fps = 0; this.fpsFrames = 0; this.fpsT0 = performance.now();
      this.bind(video);
    }

    resetGeometry() {
      this.posL = null; this.posT = null; this.posFixed = null; this.gain = [1, 1];
      this.vr = null; this.clippers = null; this.clipRadius = ''; this.crop = null;
    }

    attach(first) {
      const v = this.video, p = v.parentNode, h = this.host;
      if (!p) return;
      // Moving a showing popover would close it; in the top layer the tree position does not matter anyway.
      if (this.topLayer && h.isConnected) return;
      // No slot attribute copied from the video: components identify their media by slot name (media-chrome takes
      // the first [slot=media] child, and unsets its media when such a child is removed), so ours must not carry it.
      if (first) { if (p.firstChild !== h) p.insertBefore(h, p.firstChild); }
      else if (v.nextSibling !== h) v.after(h);
    }

    onResize(entries) {
      if (this.dead) return;
      const e = entries[entries.length - 1];
      let w, h;
      const d = e.devicePixelContentBoxSize && e.devicePixelContentBoxSize[0];
      if (d) { w = d.inlineSize; h = d.blockSize; }
      else { w = Math.round(e.contentRect.width * devicePixelRatio); h = Math.round(e.contentRect.height * devicePixelRatio); }
      if (w > 0 && h > 0) { this.renderer.resize(w, h); this.draw(); }
    }

    requestSync() {
      if (this.dead || this.syncRaf) return;
      this.syncRaf = requestAnimationFrame(() => { this.syncRaf = 0; this.syncGeometry(); });
    }

    // full: also re-derive the clipping ancestors (slow path: timer, attach, fullscreen changes).
    syncGeometry(full) {
      if (this.dead || this.suspended) return;
      const v = this.video;
      if (!v.isConnected) { scheduleEvaluate(); return; }
      const cs = this.vcs;
      const place = placement(v, cs);
      this.attach(place.first);
      this.updateTopLayer(false);
      if (full || !this.clippers) this.refreshClippers(cs);
      const box = boxMetrics(v, cs);
      const r = contentRect(v, cs, box);
      const H = this.host, hc = this.hostCss;
      const fixed = this.topLayer || cs.position === 'fixed';
      put(H, hc, 'position', fixed ? 'fixed' : 'absolute');
      put(H, hc, 'width', px(box.bw));
      put(H, hc, 'height', px(box.bh));
      // Same size, transform and origin as the video: both boxes then land on the same on-screen quad.
      put(H, hc, 'transform', cs.transform);
      put(H, hc, 'transform-origin', cs.transformOrigin);
      put(H, hc, 'translate', cs.translate || 'none');
      put(H, hc, 'rotate', cs.rotate || 'none');
      put(H, hc, 'scale', cs.scale || 'none');
      put(H, hc, 'border-radius', cs.borderRadius);
      put(H, hc, 'opacity', cs.opacity);
      put(H, hc, 'visibility', cs.visibility);
      put(H, hc, 'filter', cs.filter);
      put(H, hc, 'z-index', this.topLayer ? 'auto' : place.z);
      const vr = this.vr = v.getBoundingClientRect();
      const hr = this.pin(vr, v, fixed);
      // Snapping and clipping are done in host-local px, which equal screen px only without scale or rotation.
      const flat = isTranslateOnly(cs) && Math.abs(hr.width - box.bw) < 0.05 && Math.abs(hr.height - box.bh) < 0.05;
      this.layoutCanvas(r, hr, flat);
      this.applyClip(hr, flat);
    }

    // Place the host's border box on the video's, correcting a first guess against the real on-screen boxes.
    pin(vr, v, fixed) {
      const H = this.host, hc = this.hostCss;
      if (this.posL === null || this.posFixed !== fixed) {
        this.posFixed = fixed;
        this.posL = fixed ? vr.left : v.offsetLeft;
        this.posT = fixed ? vr.top : v.offsetTop;
      }
      let L = this.posL, T = this.posT, pL = L, pT = T, pr = null, hr;
      for (let i = 0; ; i++) {
        put(H, hc, 'left', px(L));
        put(H, hc, 'top', px(T));
        hr = H.getBoundingClientRect();
        const ex = vr.left - hr.left, ey = vr.top - hr.top;
        if ((Math.abs(ex) < 0.01 && Math.abs(ey) < 0.01) || i === 3) break;
        if (pr) {
          if ((L !== pL && hr.left === pr.left) || (T !== pT && hr.top === pr.top)) break;   // host is not laid out
          // Screen px per CSS px of left/top: not 1 inside scaled or mirrored ancestors, so learn it.
          if (Math.abs(L - pL) > 0.5) { const g = (hr.left - pr.left) / (L - pL); if (Math.abs(g) > 0.05 && Math.abs(g) < 20) this.gain[0] = g; }
          if (Math.abs(T - pT) > 0.5) { const g = (hr.top - pr.top) / (T - pT); if (Math.abs(g) > 0.05 && Math.abs(g) < 20) this.gain[1] = g; }
        }
        pL = L; pT = T; pr = hr;
        L += ex / this.gain[0];
        T += ey / this.gain[1];
        if (!Number.isFinite(L) || !Number.isFinite(T) || Math.abs(L) > 1e6 || Math.abs(T) > 1e6) { L = pL; T = pT; break; }
      }
      this.posL = L; this.posT = T;
      return hr;
    }

    layoutCanvas(r, hr, flat) {
      let x = r.left, y = r.top, w = r.width, h = r.height;
      const crop = r.crop.slice();
      if (flat && w > 0 && h > 0) {
        // Snap both edges to device pixels: the mask maps 1:1 and no raw-video sliver shows at either edge.
        const dpr = devicePixelRatio || 1, snap = (n) => Math.round(n * dpr) / dpr;
        const ax = hr.left + x, ay = hr.top + y;
        const x0 = snap(ax), x1 = snap(ax + w), y0 = snap(ay), y1 = snap(ay + h);
        crop[0] += (x0 - ax) / r.pw; crop[2] += (x1 - ax - w) / r.pw;
        crop[1] += (y0 - ay) / r.ph; crop[3] += (y1 - ay - h) / r.ph;
        for (let i = 0; i < 4; i++) crop[i] = Math.min(1, Math.max(0, crop[i]));
        x = x0 - hr.left; y = y0 - hr.top; w = x1 - x0; h = y1 - y0;
      }
      const c = this.canvas, cc = this.canvasCss, cap = this.captions, pc = this.capCss;
      put(c, cc, 'left', px(x)); put(c, cc, 'top', px(y)); put(c, cc, 'width', px(w)); put(c, cc, 'height', px(h));
      put(cap, pc, 'left', px(x)); put(cap, pc, 'top', px(y)); put(cap, pc, 'width', px(w)); put(cap, pc, 'height', px(h));
      put(cap, pc, 'font-size', px(Math.max(10, h * 0.05)));   // Chrome's default cue size: 5% of the video height
      this.capPad = h * 0.04;
      // Native controls sit at the bottom of the content box, which may extend below a letterboxed picture.
      const b = r.box;
      this.ctrlInset = Math.max(0, Math.min(h, CONTROLS_PX - (b.bt + b.pt + b.ch - (y + h))));
      // Scrolling moves the snap residue by sub-pixel amounts; ignore those instead of re-rendering a paused video.
      const old = this.crop;
      if (!old || crop.some((v, i) => Math.abs(v - old[i]) * (i & 1 ? r.ph : r.pw) > 0.02)) {
        this.crop = crop;
        this.renderer.setCrop(crop);
        this.draw();
      }
      this.updateControlsClip();
    }

    // Ancestors below the host's containing block clip an in-flow video but not the absolutely positioned host.
    // (An absolute or fixed video shares the host's containing block, so the same ancestors clip both.)
    refreshClippers(cs) {
      const list = [];
      let radius = '';
      if (!this.topLayer && cs.position !== 'fixed' && cs.position !== 'absolute') {
        for (let el = flatParent(this.video), i = 0; el && i < 64; el = flatParent(el), i++) {
          if (el === document.body || el === document.documentElement) break;
          const s = getComputedStyle(el);
          if (s.display === 'contents') continue;
          if (containsAbsolute(s)) break;                  // it and everything above clip the host as well
          if (s.display !== 'inline' && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) { list.push(el); radius = s.borderRadius; }
        }
      }
      this.clippers = list;
      this.clipRadius = list.length === 1 && radius && !radius.includes('%') && !/^0px$/.test(radius) ? radius : '';
    }

    applyClip(hr, flat) {
      // The video's own clip-path (rounded or shaped video) fits the host too: same border box. Clipping ancestors win.
      let val = this.vcs.clipPath || 'none';
      const list = this.clippers;
      if (list && list.length && flat) {
        let l = -Infinity, t = -Infinity, r = Infinity, b = Infinity, ok = true;
        for (const el of list) {
          if (!el.isConnected) { ok = false; this.clippers = null; break; }
          const rc = el.getBoundingClientRect();
          const x = rc.left + el.clientLeft, y = rc.top + el.clientTop;    // padding box: what overflow clips to
          l = Math.max(l, x); t = Math.max(t, y); r = Math.min(r, x + el.clientWidth); b = Math.min(b, y + el.clientHeight);
        }
        const it = t - hr.top, ir = hr.right - r, ib = hr.bottom - b, il = l - hr.left;
        if (ok && (this.clipRadius || it > 0.01 || ir > 0.01 || ib > 0.01 || il > 0.01)) {
          val = `inset(${px(it)} ${px(ir)} ${px(ib)} ${px(il)}${this.clipRadius ? ' round ' + this.clipRadius : ''})`;
        }
      }
      put(this.host, this.hostCss, 'clip-path', val);
    }

    // A bare <video> in fullscreen is in the top layer, above the whole page. Put the host there too, as a manual
    // popover shown after it: top-layer entries paint in insertion order.
    updateTopLayer(raise) {
      const fs = fullscreenState();
      const need = !!fs && canPopover && insideFullscreen(fs, this.video) && !insideFullscreen(fs, this.host);
      if (!need) { this.leaveTopLayer(); return; }
      const H = this.host;
      if (!this.topLayer) {
        this.topLayer = true;
        this.posL = null; this.gain = [1, 1]; this.clippers = null;
        H.popover = 'manual';
        raise = true;
      }
      if (!H.isConnected) return;
      try {
        const open = H.matches(':popover-open');
        if (open && !raise) return;
        if (open) H.hidePopover();          // re-raise above whatever entered the top layer since
        H.showPopover();
      } catch (e) { /* e.g. mid-removal; the next sync retries */ }
    }

    leaveTopLayer() {
      if (!this.topLayer) return;
      this.topLayer = false;
      this.posL = null; this.gain = [1, 1]; this.clippers = null;
      try { if (this.host.matches(':popover-open')) this.host.hidePopover(); } catch (e) { /* ignore */ }
      this.host.removeAttribute('popover');
    }

    // ---- native controls and captions (both live inside the video box, under the canvas) ----
    // Chrome also shows its controls on a fullscreen <video> that has no controls attribute.
    nativeControls() {
      const v = this.video;
      return !!v && (v.controls || this.topLayer);
    }

    revealControls() {
      if (!this.nativeControls()) return;
      this.revealUntil = performance.now() + 2500;
      this.updateControlsClip();
      clearTimeout(this.revealTimer);
      this.revealTimer = setTimeout(() => this.updateControlsClip(), 2550);
    }

    updateControlsClip() {
      const v = this.video;
      // Chrome keeps its controls up while paused; otherwise show them for a while after input on the video.
      const on = this.nativeControls() && this.ctrlInset > 0 && (v.paused || performance.now() < this.revealUntil);
      put(this.canvas, this.canvasCss, 'clip-path', on ? `inset(0px 0px ${px(this.ctrlInset)} 0px)` : 'none');
      put(this.captions, this.capCss, 'padding-bottom', px(this.capPad + (on ? this.ctrlInset : 0)));
    }

    refreshTracks() {
      for (const t of this.tracks) t.removeEventListener('cuechange', this.onCue);
      this.tracks = [];
      const list = this.video && this.video.textTracks;
      if (list) {
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          // Only these kinds are rendered by Chrome. The site's track modes are left alone.
          if (t.mode === 'showing' && (t.kind === 'subtitles' || t.kind === 'captions')) {
            t.addEventListener('cuechange', this.onCue);
            this.tracks.push(t);
          }
        }
      }
      this.renderCues();
    }

    renderCues() {
      const cues = [];
      for (const t of this.tracks) {
        const a = t.activeCues;
        if (a) for (let i = 0; i < a.length; i++) cues.push(a[i]);
      }
      if (cues.length === this.cues.length && cues.every((c, i) => c === this.cues[i])) return;
      this.cues = cues;
      this.captions.replaceChildren(...cues.map(cueElement));
    }

    // ---- frame loop ----
    startLoop() {
      const v = this.video, gen = ++this.loopGen;
      if (typeof v.requestVideoFrameCallback === 'function') {
        const onFrame = () => {
          if (this.dead || gen !== this.loopGen) return;
          this.vfc = v.requestVideoFrameCallback(onFrame);     // re-arm first so a throwing tick cannot end the loop
          this.frameTick();
        };
        this.vfc = v.requestVideoFrameCallback(onFrame);
      } else {
        const loop = () => {
          if (this.dead || gen !== this.loopGen) return;
          this.rafId = requestAnimationFrame(loop);
          if (!v.paused || this.suspended) this.frameTick();
        };
        this.rafId = requestAnimationFrame(loop);
      }
    }

    stopLoop() {
      this.loopGen++;
      try { if (this.vfc && this.video && this.video.cancelVideoFrameCallback) this.video.cancelVideoFrameCallback(this.vfc); } catch (e) { /* ignore */ }
      cancelAnimationFrame(this.rafId);
      this.vfc = 0; this.rafId = 0;
    }

    frameTick() {
      if (this.suspended) {
        // Frames keep coming while parked (e.g. a video fading in): re-check eligibility a few times a second.
        const now = performance.now();
        if (now - this.parkCheck > 250) { this.parkCheck = now; scheduleEvaluate(); }
        return;
      }
      // Cheap per-frame check: layout shifts, element scrolls and fades change the video without resizing it.
      const r = this.video.getBoundingClientRect(), p = this.vr, cs = this.vcs, hc = this.hostCss;
      if (!p || r.left !== p.left || r.top !== p.top || r.width !== p.width || r.height !== p.height ||
          cs.opacity !== hc.opacity || cs.transform !== hc.transform || cs.visibility !== hc.visibility) this.syncGeometry();
      if (this.upload()) {
        this.draw();
        this.fpsFrames++;
        const now = performance.now();
        if (now - this.fpsT0 > 1000) { this.fps = Math.round(this.fpsFrames * 1000 / (now - this.fpsT0)); this.fpsFrames = 0; this.fpsT0 = now; }
      }
    }

    upload() {
      if (this.dead || this.suspended) return false;
      try {
        return this.renderer.uploadFrame(this.video);
      } catch (e) {
        if (e && e.name === 'SecurityError') {
          tainted.set(this.video, this.video.currentSrc);
          this.fail(TAINTED);
        } else {
          this.fail('upload failed: ' + (e && e.message), true);
        }
        return false;
      }
    }

    // Upload + draw on the next frame (used when paused, after seeks, or when settings change).
    kick() {
      if (this.dead || this.kickRaf) return;
      this.kickRaf = requestAnimationFrame(() => {
        this.kickRaf = 0;
        if (this.dead || this.suspended) return;
        this.upload();
        this.draw();
      });
    }

    draw() {
      if (this.dead || this.suspended) return;
      let ok = false;
      try { ok = this.renderer.render(); }
      catch (e) { this.fail('render failed: ' + (e && e.message), true); return; }
      if (ok && !this.shown) this.showCanvas();
    }

    // Visibility is toggled on the canvas, not the host, so the canvas ResizeObserver keeps reporting sizes.
    showCanvas() {
      this.shown = true;
      put(this.canvas, this.canvasCss, 'visibility', 'inherit');
      put(this.captions, this.capCss, 'visibility', 'inherit');
    }

    hideCanvas() {
      this.shown = false;
      put(this.canvas, this.canvasCss, 'visibility', 'hidden');
      put(this.captions, this.capCss, 'visibility', 'hidden');
    }

    // Park the overlay while the video is briefly unusable (src swap, off-screen, hidden) instead of rebuilding it.
    setSuspended(why) {
      if (why) {
        if (this.suspended === why) return;
        this.suspended = why;
        this.hideCanvas();
      } else if (this.suspended) {
        this.suspended = null;
        this.syncGeometry(true);
        this.kick();
      }
    }

    // The video left the page: wait a moment for a replacement (SPA navigation, feed recycling). True once expired.
    orphan() {
      const now = performance.now();
      if (!this.orphanedAt) {
        this.orphanedAt = now;
        this.setSuspended('video was removed');
        this.leaveTopLayer();
        this.host.remove();
        clearTimeout(this.orphanTimer);
        this.orphanTimer = setTimeout(scheduleEvaluate, ORPHAN_MS + 50);
        return false;
      }
      return now - this.orphanedAt >= ORPHAN_MS;
    }

    setParams(p) { this.renderer.setParams(p); this.draw(); }

    onContextLost() {
      this.contextLosses++;
      this.hideCanvas();
      clearTimeout(this.lostTimer);
      // No 'webglcontextrestored' ever comes when Chrome has blocked 3D for the site.
      this.lostTimer = setTimeout(() => this.fail('GPU context lost', true), LOST_TIMEOUT_MS);
    }

    onContextRestored() {
      clearTimeout(this.lostTimer);
      if (this.contextLosses > 3) return this.fail('GPU context kept resetting', true);
      this.renderer.setParams(params);
      if (this.crop) this.renderer.setCrop(this.crop);
      this.kick();
    }

    fail(reason, gpu) {
      if (this.dead) return;
      lastReason = reason;
      if (gpu && this.video) noteGpuFailure(this.video, reason);
      console.info('[CRT] disabled for this video:', reason);
      this.destroy();
      if (overlay === this) overlay = null;
      scheduleEvaluate();
    }

    destroy() {
      if (this.dead) return;
      this.dead = true;
      if (this.host) this.leaveTopLayer();
      clearInterval(this.geomTimer);
      clearTimeout(this.revealTimer); clearTimeout(this.lostTimer); clearTimeout(this.orphanTimer);
      cancelAnimationFrame(this.syncRaf); cancelAnimationFrame(this.kickRaf);
      this.unbind();
      if (this.ro) this.ro.disconnect();
      if (this.vro) this.vro.disconnect();
      if (this.onPointer) document.removeEventListener('pointermove', this.onPointer, { capture: true });
      try { this.renderer.destroy(); } catch (e) { /* ignore */ }
      if (this.host) this.host.remove();
    }

    status() {
      return Object.assign({ fps: this.fps, shown: this.shown }, this.renderer.info() || {});
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Discovery: the document plus every nested, open or closed, shadow root found so far.
  const roots = new Map();                  // Document | ShadowRoot -> { videos, dirty }
  const docVideos = document.getElementsByTagName('video');   // live collection: cheap to re-read
  const HOSTABLE = new Set(['article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'header', 'main', 'nav', 'p', 'section', 'span']);
  const walkQueue = [];                     // TreeWalkers still to finish, resumed across idle slices
  let mo = null, closedChecked = new WeakSet();
  let sweepHandle = 0, passTimer = 0, passActive = false, passFound = false, idlePasses = 0;
  let running = false;

  // Sweep variant of rootOf(): the extension API costs a call per element, so only ask where a closed root can be.
  function sweepRootOf(el) {
    const sr = el.shadowRoot;
    if (sr || !domApi || closedChecked.has(el)) return sr;
    const n = el.localName, custom = n.includes('-');
    // Built-in hosts keep their content in the shadow tree, so ones with light children are not hosts in practice.
    if (!custom && !(HOSTABLE.has(n) && !el.firstElementChild)) return null;
    const root = closedRoot(el);
    // Components have their root by the time they are upgraded; only undefined custom elements are asked again.
    if (!root && (!custom || el.matches(':defined'))) closedChecked.add(el);
    return root;
  }

  function checkHost(el) {
    const sr = sweepRootOf(el);
    if (!sr || roots.has(sr) || (overlay && el === overlay.host)) return false;
    observeRoot(sr);
    queueWalk(sr, false);
    passFound = true;
    return true;
  }

  function queueWalk(node, withSelf) {
    if (withSelf && node.nodeType === 1) checkHost(node);
    if (!node.firstElementChild) return;
    walkQueue.push(document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT));
    scheduleSweep();
  }

  function scheduleSweep() {
    if (sweepHandle || !running) return;
    sweepHandle = self.requestIdleCallback ? requestIdleCallback(runSweep, { timeout: 1000 }) : setTimeout(runSweep, 16);
  }

  // Incremental and uncapped, but time-budgeted: large DOMs are finished over several idle slices.
  function runSweep(deadline) {
    sweepHandle = 0;
    if (!running) return;
    const t0 = performance.now();
    const limit = deadline && !deadline.didTimeout ? Math.max(2, Math.min(10, deadline.timeRemaining())) : 4;
    let n = 0, found = false;
    while (walkQueue.length) {
      const w = walkQueue[0];
      for (let el = w.nextNode(); el; el = w.nextNode()) {
        if (checkHost(el)) found = true;
        if ((++n & 63) === 0 && performance.now() - t0 > limit) {
          if (found) scheduleEvaluate();
          scheduleSweep();
          return;
        }
      }
      walkQueue.shift();
    }
    if (found) scheduleEvaluate();
    if (passActive) {
      passActive = false;
      idlePasses = passFound || videoCount ? 0 : idlePasses + 1;
      schedulePass();
    }
  }

  // Full passes catch roots attached after insertion (late upgrades), which no mutation reports.
  function startPass() {
    passTimer = 0;
    if (!running) return;
    passActive = true; passFound = false;
    for (const root of roots.keys()) if (root.isConnected) queueWalk(root, false);
    scheduleSweep();
    scheduleEvaluate();
  }

  function schedulePass() {
    clearTimeout(passTimer);
    // Back off on pages that show no sign of video (most frames: ads, widgets, editors).
    passTimer = setTimeout(startPass, videoCount || idlePasses < 3 ? 2000 : 10000);
  }

  function observeRoot(root) {
    if (roots.has(root)) return;
    roots.set(root, { videos: [], dirty: true });
    mo.observe(root, { childList: true, subtree: true });
    // Media and scroll events are not composed: each tree needs its own capture listeners.
    for (const ev of ROOT_EVENTS) root.addEventListener(ev, onMediaCapture, true);
    root.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
  }

  function forgetRoot(root) {
    roots.delete(root);
    for (const ev of ROOT_EVENTS) root.removeEventListener(ev, onMediaCapture, true);
    root.removeEventListener('scroll', onViewportChange, { capture: true });
  }

  function onMutations(records) {
    if (!running) return;
    const host = overlay && overlay.host;
    for (const rec of records) {
      const e = roots.get(rec.target.getRootNode());
      if (!e) continue;                     // a tree we already forgot
      e.dirty = true;
      for (const n of rec.addedNodes) {
        if (n.nodeType !== 1 || n === host) continue;
        if (n.localName.includes('-')) idlePasses = 0;
        if (walkQueue.length < 512) queueWalk(n, true);    // otherwise the next full pass covers it
      }
    }
    scheduleEvaluate();
  }

  function onMediaCapture(e) {
    // A new source may be same-origin (or CORS-enabled): give a tainted element another chance.
    if ((e.type === 'loadstart' || e.type === 'emptied') && e.target) tainted.delete(e.target);
    scheduleEvaluate();
  }

  function onViewportChange() {
    if (overlay) overlay.requestSync();
    scheduleEvaluate();
  }

  function onFullscreenChange() {
    evaluate();
    if (overlay) { overlay.updateTopLayer(true); overlay.syncGeometry(true); }
  }

  function allVideos() {
    const list = Array.from(docVideos);
    for (const [root, e] of roots) {
      if (root === document) continue;
      if (!root.isConnected) { forgetRoot(root); continue; }
      if (e.dirty) { e.videos = Array.from(root.querySelectorAll('video')); e.dirty = false; }
      for (const v of e.videos) list.push(v);
    }
    return list;
  }

  // Observers, listeners and sweeps run only while the effect is on for this site.
  function startWatching() {
    if (running) return;
    running = true;
    closedChecked = new WeakSet();
    idlePasses = 0;
    mo = new MutationObserver(onMutations);
    observeRoot(document);
    window.addEventListener('resize', onViewportChange, { passive: true });
    document.addEventListener('fullscreenchange', onFullscreenChange);
    startPass();
  }

  function stopWatching() {
    if (!running) return;
    running = false;
    if (mo) { mo.disconnect(); mo = null; }
    for (const root of Array.from(roots.keys())) forgetRoot(root);
    walkQueue.length = 0;
    passActive = false;
    clearTimeout(passTimer); passTimer = 0;
    if (sweepHandle) { (self.cancelIdleCallback ? cancelIdleCallback : clearTimeout)(sweepHandle); sweepHandle = 0; }
    window.removeEventListener('resize', onViewportChange);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    clearTimeout(dwellTimer); candidate = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Selection
  function noteGpuFailure(v, reason) {
    gpuFailures++;
    const g = gpuFailed.get(v);
    const count = g ? g.count + 1 : 1;
    // Exponential backoff: rebuilding contexts on a resetting GPU gets 3D blocked for the whole site.
    gpuFailed.set(v, { count, reason, until: performance.now() + Math.min(600e3, 10e3 * 2 ** (count - 1)) });
  }

  // Reasons a video cannot be processed at all right now (as opposed to a transient zero score).
  function blocked(v) {
    const src = tainted.get(v);
    if (src !== undefined) {
      if (src === v.currentSrc) return TAINTED;
      tainted.delete(v);
    }
    if (v.mediaKeys) return 'video is DRM-protected';
    const g = gpuFailed.get(v);
    if (g && performance.now() < g.until) return g.reason;
    return null;
  }

  const zero = (why, rank) => ({ s: 0, why, rank });

  function previewLike(v, r = v.getBoundingClientRect()) {
    return v.muted && !v.controls && r.width * r.height < PREVIEW_AREA * innerWidth * innerHeight;
  }

  // Muted-by-markup, looping, no controls: decorative (hero backgrounds, GIF-style clips). The muted *attribute*
  // is used so a user who mutes a looping video does not lose the effect.
  const isBackgroundVideo = (v) => v.defaultMuted && v.loop && !v.controls;

  function assess(v, fs, isCurrent) {
    if (v.readyState < 1) return zero(LOADING, 3);
    if (!v.videoWidth) return zero('video has no picture', 3);
    if (!isCurrent && isBackgroundVideo(v)) return zero('background video (muted, looping, no controls)', 4);
    if (fs) {
      if (!insideFullscreen(fs, v)) return zero('video is behind the fullscreen element', 3);
      if (fs.real === v && !canPopover) return zero('native fullscreen not supported', 3);
    }
    const cs = getComputedStyle(v);
    if (cs.visibility !== 'visible' || !(parseFloat(cs.opacity) > 0)) return zero('video is hidden', 2);
    const r = v.getBoundingClientRect();
    if (r.width < MIN_W || r.height < MIN_H) return zero('no video large enough', 1);
    const vw = innerWidth, vh = innerHeight;
    const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    let s = w * h;
    if (s <= 0) return zero('video is off-screen', 2);
    if (!v.paused && !v.ended) s *= 2;
    if (fs) s *= 10;
    if (previewLike(v, r)) s *= 0.25;      // hover previews lose against real players
    return { s, why: '', rank: 0 };
  }

  let candidate = null, candidateSince = 0, dwellTimer = 0;
  // True once `v` has been the best candidate for `ms`; otherwise re-evaluates when that time is up.
  function dwellDone(v, ms) {
    const now = performance.now();
    if (candidate !== v) { candidate = v; candidateSince = now; }
    const left = ms - (now - candidateSince);
    if (left <= 0) return true;
    clearTimeout(dwellTimer);
    dwellTimer = setTimeout(evaluate, left + 20);
    return false;
  }

  function switchDwell(best, cur) {
    if (previewLike(best)) return DWELL_MS;
    // Nothing visible can flap while the current video is out of sight (not merely loading) or just a preview.
    if (previewLike(cur.video) || (cur.suspended && cur.suspended !== LOADING)) return QUICK_DWELL_MS;
    return DWELL_MS;
  }

  function dropOverlay() {
    if (overlay) { overlay.destroy(); overlay = null; }
    candidate = null;
  }

  function create(v) {
    try {
      overlay = new Overlay(v);
      // fail() during construction cannot clear `overlay` yet; it has already recorded the reason.
      if (overlay.dead) overlay = null; else lastReason = '';
    } catch (e) {
      overlay = null;
      const msg = String((e && e.message) || e);
      if (msg.includes('WebGL2 unavailable')) { webgl2Unavailable = true; lastReason = 'WebGL2 unavailable'; }
      else { noteGpuFailure(v, 'could not start: ' + msg); lastReason = 'could not start: ' + msg; }
      console.warn('[CRT]', e);
    }
  }

  let evalScheduled = false;
  function scheduleEvaluate() {
    if (evalScheduled) return;
    evalScheduled = true;
    const run = () => { evalScheduled = false; evaluate(); };
    if (self.requestIdleCallback) requestIdleCallback(run, { timeout: 300 }); else setTimeout(run, 100);
  }

  function evaluate() {
    if (!ready) return;
    if (!enabledHere()) { dropOverlay(); lastReason = state.enabled ? 'disabled on this site' : 'turned off'; return; }
    const stop = webgl2Unavailable ? 'WebGL2 unavailable'
      : gpuFailures >= MAX_GPU_FAILURES ? 'the GPU keeps failing on this page' : '';
    if (stop) { dropOverlay(); lastReason = stop; return; }

    const fs = fullscreenState();
    const vids = allVideos();
    videoCount = vids.length;
    let cur = overlay && !overlay.dead ? overlay : null;
    let best = null, bestScore = 0, why = '', whyRank = -1;
    const note = (reason, rank) => { if (rank > whyRank) { why = reason; whyRank = rank; } };
    for (const v of vids) {
      if (cur && v === cur.video) continue;
      const b = blocked(v);
      if (b) { note(b, 5); continue; }
      const a = assess(v, fs, false);
      if (!a.s) note(a.why, a.rank);
      else if (a.s > bestScore) { best = v; bestScore = a.s; }
    }

    let curScore = 0;
    if (cur) {
      const v = cur.video;
      if (!v.isConnected) {
        if (best) { candidate = null; cur.retarget(best); lastReason = ''; return; }   // the site swapped its <video>
        if (cur.orphan()) { dropOverlay(); cur = null; }
      } else {
        if (cur.orphanedAt) { cur.orphanedAt = 0; clearTimeout(cur.orphanTimer); }
        const b = blocked(v);
        if (b) { dropOverlay(); cur = null; note(b, 6); }
        else {
          const a = assess(v, fs, true);
          curScore = a.s;
          cur.setSuspended(a.s ? null : a.why);
        }
      }
    }

    if (!best) {
      candidate = null;
      lastReason = cur ? (cur.suspended || '') : (why || (vids.length ? 'no video large enough' : 'no video found'));
      return;
    }
    if (cur) {
      lastReason = cur.suspended || '';
      if (bestScore <= curScore * 1.5) { candidate = null; return; }        // hysteresis against flapping
      if (!dwellDone(best, switchDwell(best, cur))) return;
      candidate = null;
      cur.retarget(best);
      lastReason = '';
      return;
    }
    // A hover preview has to linger before it is worth a WebGL context.
    if (!dwellDone(best, previewLike(best) ? DWELL_MS : 0)) { lastReason = why || 'waiting for the video to settle'; return; }
    candidate = null;
    create(best);
  }

  // ---------------------------------------------------------------------------------------------
  function applyState(st) {
    const wasOn = ready && enabledHere();
    state = st;
    params = CRT.effectiveParams(st);
    ready = true;
    const on = enabledHere();
    if (on && !wasOn) { gpuFailed = new WeakMap(); gpuFailures = 0; }   // turned back on: allow a fresh attempt
    if (on) startWatching();
    else { stopWatching(); dropOverlay(); lastReason = st.enabled ? 'disabled on this site' : 'turned off'; }
    if (overlay) overlay.setParams(params);
    if (on) scheduleEvaluate();
  }

  function boot() {
    CRT.onStateChanged(applyState);
    // A change event that beats the initial read carries the newer state, so the read must not overwrite it.
    CRT.loadState().then(
      (st) => { if (!ready) applyState(st); },
      () => { if (!ready) applyState(CRT.normalizeState()); });
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || msg.type !== 'crt:status') return false;
      const o = overlay && !overlay.dead ? overlay : null;
      if (o && !o.suspended) {
        sendResponse({ active: true, host: HOST, frame: isTop ? 'top' : location.hostname, info: o.status() });
        return false;
      }
      if (!isTop && !o) return false;
      // Let a frame with an active overlay answer first; a parked one still beats the top frame's generic reason.
      setTimeout(() => sendResponse({ active: false, host: HOST, reason: (o && o.suspended) || lastReason }), o ? 75 : 150);
      return true;
    });
  }

  // Test-harness hook (never set on real pages; content scripts live in an isolated world anyway).
  if (self.__CRT_DEBUG__) self.__crt = { get overlay() { return overlay; }, evaluate };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
