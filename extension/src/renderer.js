// WebGL2 CRT renderer: owns the GL context, all passes and all per-size decisions.
(function (root) {
  'use strict';
  const CRT = root.CRT = root.CRT || {};
  const S = () => CRT.SHADERS;

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const roundUp = (v, m) => Math.ceil(v / m) * m;

  // ---------------------------------------------------------------------------------------------
  // Phosphor mask tiles (device-pixel space). Each entry is the lit state of R,G,B for one column.
  const APERTURE = {
    2: ['101', '010'],                                // magenta / green
    3: ['101', '010', '000'],                         // magenta / green / black
    4: ['100', '010', '001', '000'],                  // R G B X
    5: ['100', '110', '011', '001', '000'],           // R Y C B X
    6: ['100', '100', '010', '010', '001', '001'],    // RR GG BB
    7: ['100', '100', '010', '010', '001', '001', '000'],
  };

  function buildMask(type, P, outH, slotStrength, subpixel) {
    if (type === 'mono') {
      P = clamp(P, 3, 5);
      const cols = []; for (let i = 0; i < P; i++) cols.push(i === 0 ? '000' : '111');
      return tileFrom(cols, 1, () => 1, subpixel, `mono grille ${P}px`);
    }
    const cols = APERTURE[P];
    if (type === 'aperture') return tileFrom(cols, 1, () => 1, subpixel, `aperture grille ${P}px`);
    if (type === 'slot') {
      // Slot mask: vertical stripes interrupted by tie-bars, staggered by half a slot on alternate triads.
      const SH = outH >= 1700 ? 6 : outH >= 1300 ? 5 : 4;
      const bar = outH >= 1700 ? 2 : 1;
      const dark = 1 - slotStrength;
      const w = P * 2;
      const rows = [];
      for (let y = 0; y < SH; y++) {
        const row = [];
        for (let x = 0; x < w; x++) {
          const triad = Math.floor(x / P);
          const ry = (y + triad * Math.floor(SH / 2)) % SH;
          row.push({ c: cols[x % P], k: ry < bar ? dark : 1 });
        }
        rows.push(row);
      }
      return tileRows(rows, subpixel, `slot mask ${P}×${SH}px`);
    }
    if (type === 'shadow') {
      // Delta/dot mask: alternate row groups shifted by half a triad.
      const rh = Math.max(1, Math.round(P / 2));
      const shift = Math.round(P / 2);
      const rows = [];
      for (let y = 0; y < rh * 2; y++) {
        const row = [];
        const off = y >= rh ? shift : 0;
        for (let x = 0; x < P; x++) row.push({ c: cols[(x + off) % P], k: 1 });
        rows.push(row);
      }
      return tileRows(rows, subpixel, `shadow mask ${P}×${rh * 2}px`);
    }
    return null;
  }
  function tileFrom(cols, h, kf, subpixel, label) {
    const rows = [];
    for (let y = 0; y < h; y++) rows.push(cols.map(c => ({ c, k: kf(y) })));
    return tileRows(rows, subpixel, label);
  }
  function tileRows(rows, subpixel, label) {
    const h = rows.length, w = rows[0].length;
    const data = new Uint8Array(w * h * 4);
    const fill = [0, 0, 0];
    rows.forEach((row, y) => row.forEach((px, x) => {
      let rgb = px.c.split('').map(Number);
      if (subpixel === 'bgr') rgb = [rgb[2], rgb[1], rgb[0]];
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const v = rgb[ch] * px.k;
        data[i + ch] = Math.round(v * 255);
        fill[ch] += Math.round(v * 255) / 255;
      }
      data[i + 3] = 255;
    }));
    // Lit fraction per channel; clamp away from 0/1 so the energy-conserving maths stays finite.
    const n = w * h;
    return { w, h, data, fill: fill.map(f => clamp(f / n, 0.05, 0.95)), label };
  }

  // ---------------------------------------------------------------------------------------------
  // Analog signal kernels (21 taps on the 4-samples-per-subcarrier-cycle grid).
  const R = 10;
  function gauss(sigma) {
    const k = new Float64Array(2 * R + 1);
    let s = 0;
    for (let i = -R; i <= R; i++) { const v = Math.exp(-0.5 * (i * i) / (sigma * sigma)); k[i + R] = v; s += v; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return k;
  }
  function convolve(a, b) {
    const out = new Float64Array(2 * R + 1);
    for (let i = -R; i <= R; i++) {
      let s = 0;
      for (let j = -R; j <= R; j++) { const k = i - j; if (k >= -R && k <= R) s += a[j + R] * b[k + R]; }
      out[i + R] = s;
    }
    return out;
  }
  function delta() { const d = new Float64Array(2 * R + 1); d[R] = 1; return d; }
  function normalizeDC(k) { const s = k.reduce((a, b) => a + b, 0); return k.map(v => v / s); }
  function signalKernels(mode, sharpness) {
    // mode: svideo | composite | rf
    const sigmaY = mode === 'rf' ? 0.63 : mode === 'composite' ? 0.5 : 0.45;
    const sigmaC = mode === 'rf' ? 3.8 : 3.2;
    let kY = gauss(sigmaY);
    if (mode !== 'svideo') {
      // Chroma trap: subtract a band-pass centred on the carrier (1/4 cycle per sample).
      const g = gauss(2.0);
      let evenSum = 0;
      for (let i = -R; i <= R; i += 2) evenSum += g[i + R];
      const notch = delta();
      for (let i = -R; i <= R; i++) notch[i + R] -= g[i + R] * Math.cos(Math.PI * i / 2) / evenSum;
      kY = convolve(kY, notch);
    }
    const p = sharpness * 0.9;
    if (p > 0) {
      const peak = delta().map((v, i) => (1 + p) * v - p * gauss(1.0)[i]);
      kY = convolve(kY, peak);
    }
    kY = normalizeDC(kY);
    return { kY: Float32Array.from(kY), kC: Float32Array.from(gauss(sigmaC)) };
  }

  // ---------------------------------------------------------------------------------------------
  // Beam energy. Lanczos Gamma (g = 7, n = 9): ~15 significant digits for x >= 0.5 (we need 1.25..1.5).
  const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  function gammaFn(x) {
    x -= 1;
    let a = LANCZOS[0];
    for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i] / (x + i);
    const t = x + 7.5;
    return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
  }
  // Integral over d of the composite shader's beam() per unit sigma: exp(-0.5 |d/s|^beta) integrates to
  // s * 2^(1+1/beta) * Gamma(1+1/beta). The shader uses the plain Gaussian (sqrt(2*pi)) up to beta 2.001.
  function beamEnergy(beta) {
    const b = beta <= 2.001 ? 2 : beta;
    return Math.pow(2, 1 + 1 / b) * gammaFn(1 + 1 / b);
  }

  // Glow blur sigma along one axis, in texels of a buffer whose texels span 2^levels grid texels on that axis,
  // that makes the TOTAL glow sigma equal `target`: each 2x box downsample adds 1/4 of its source texel^2
  // on the axis it halves, and the upsample in the composite pass adds `recon` texel^2 (cubic B-spline 1/3,
  // bilinear 1/6). Floored at BLUR's minimum sigma (0.3 texels).
  function glowSigma(target, levels, recon = 1 / 3) {
    let v = recon;
    for (let k = 1; k <= levels; k++) v += 0.25 / Math.pow(4, levels - k + 1);
    return Math.sqrt(Math.max(target * target - v, 0.09));
  }

  // ---------------------------------------------------------------------------------------------
  class Renderer {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.onContextLost = opts.onContextLost || (() => {});
      this.onContextRestored = opts.onContextRestored || (() => {});
      this.params = CRT.presetParams('consumer');
      this.videoW = 0; this.videoH = 0;
      this.crop = [0, 0, 1, 1];
      this.frame = 0;
      this.hasFrame = false;
      this.sized = false;
      this.dirty = true;
      this.lost = false;
      this.gl = null;
      this._onLost = (e) => { e.preventDefault(); this.lost = true; this.hasFrame = false; this.onContextLost(); };
      // Stay "lost" until everything is rebuilt, so a failed rebuild can never render with stale objects.
      this._onRestored = () => { this._init(); this.lost = false; this.dirty = true; this.onContextRestored(); };
      canvas.addEventListener('webglcontextlost', this._onLost);
      canvas.addEventListener('webglcontextrestored', this._onRestored);
      // No separate support probe: it would cost a context of its own (Chrome caps them per page) and could
      // disagree with these attributes. A failure here must not leave a live context or listeners behind.
      try { this._init(); }
      catch (e) { this.destroy(); throw e; }
    }

    // Real drawing-buffer size, read live: Chrome silently caps huge buffers, and a lost context reports 0
    // (a cached copy taken during a loss would keep the overlay off after the restore).
    get outW() { return this.gl && !this.lost ? this.gl.drawingBufferWidth : 0; }
    get outH() { return this.gl && !this.lost ? this.gl.drawingBufferHeight : 0; }

    // (Re)builds every context-owned object; also run on webglcontextrestored, where all of them are gone.
    _init() {
      const gl = this.canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true,
        preserveDrawingBuffer: false, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true,
      });
      if (!gl) throw new Error('WebGL2 unavailable');
      this.gl = gl;
      this.floatOK = !!gl.getExtension('EXT_color_buffer_float');
      const sh = S();
      this.prog = {
        resample: this._program(sh.RESAMPLE),
        signal: this._program(sh.SIGNAL),
        beamh: this._program(sh.BEAMH),
        down: this._program(sh.DOWN),
        blur: this._program(sh.BLUR),
        composite: this._program(sh.COMPOSITE),
      };
      this.vao = gl.createVertexArray();
      this.videoTex = this._tex(gl.LINEAR);
      this.maskTex = this._tex(gl.NEAREST);
      this.targets = {};
      this.layout = null;
      this.kernelKey = '';
      this.maskKey = '';
    }

    _program(fsSrc) {
      const gl = this.gl;
      const compile = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
          throw new Error('Shader compile failed: ' + gl.getShaderInfoLog(s));
        }
        return s;
      };
      const p = gl.createProgram();
      gl.attachShader(p, compile(gl.VERTEX_SHADER, S().VERT));
      gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
        throw new Error('Program link failed: ' + gl.getProgramInfoLog(p));
      }
      const uniforms = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) || 0;
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        const name = info.name.replace(/\[0\]$/, '');
        uniforms[name] = gl.getUniformLocation(p, info.name);
      }
      return { p, u: uniforms };
    }

    _tex(filter) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }

    // Render target. kind: 'signal' (gamma-encoded data) or 'linear'.
    _target(name, w, h, kind) {
      const gl = this.gl;
      let t = this.targets[name];
      if (t && t.w === w && t.h === h) return t;
      if (t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
      const tex = this._tex(gl.LINEAR);
      let ifmt = gl.RGBA8, type = gl.UNSIGNED_BYTE;
      if (this.floatOK) { ifmt = gl.RGBA16F; type = gl.HALF_FLOAT; }
      else if (kind === 'linear') ifmt = gl.SRGB8_ALPHA8;
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, gl.RGBA, type, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      t = this.targets[name] = { tex, fbo, w, h };
      return t;
    }

    setParams(p) { this.params = Object.assign({}, p); this.dirty = true; }

    // Visible part of the video (for object-fit: cover). [u0, v0, u1, v1]
    setCrop(c) { this.crop = c.slice(); this.dirty = true; }

    // Canvas size only: the drawing buffer follows it (also while the context is lost, and on restore).
    resize(w, h) {
      w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
      if (this.canvas.width !== w) this.canvas.width = w;
      if (this.canvas.height !== h) this.canvas.height = h;
      this.sized = true;
      this.dirty = true;
    }

    // Upload the current video frame. Throws SecurityError for tainted (cross-origin) video.
    uploadFrame(video) {
      if (this.lost || video.readyState < 2 || !video.videoWidth) return false;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      // Always redefine the level at the frame's own size: during bitrate switches the frame can differ from
      // videoWidth/Height, and texSubImage2D would then drop it or leave a stale, split picture. Chrome's
      // GPU video copy redefines a same-size level cheaply.
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      const vw = video.videoWidth, vh = video.videoHeight;
      if (vw !== this.videoW || vh !== this.videoH) { this.videoW = vw; this.videoH = vh; this.dirty = true; }
      this.hasFrame = true;
      this.frame++;
      return true;
    }

    // ---- per-size / per-param decisions ----
    _computeLayout(W, H) {
      const P = this.params;
      const visH = this.videoH * (this.crop[3] - this.crop[1]);
      const visW = this.videoW * (this.crop[2] - this.crop[0]);
      const aspect = visW > 0 && visH > 0 ? visW / visH : W / H;

      let N = P.lines > 0 ? P.lines : (visH > 0 && visH <= 300 ? Math.round(visH) : P.autoLines);
      let p = H / N;
      // "Field look": an interlaced-class raster (480/576) is too fine for this output to show any lines,
      // so show one field's worth (240/288), like a TV fed a progressive signal.
      if (!(P.lines > 0) && N > 300 && p < 3) { N /= 2; p = H / N; }
      if (P.snapLines && p >= 2.5) {
        const cands = [Math.floor(p), Math.ceil(p)].map(q => H / q).filter(n => Math.abs(n - N) / N <= 0.12);
        if (cands.length) { N = cands.reduce((a, b) => (Math.abs(a - N) < Math.abs(b - N) ? a : b)); p = H / N; }
      }
      const depth = smoothstep(2.3, 3.3, p);
      const sigmaMin = 0.5 / (0.4 * p + 1);

      // Grid: 4 samples per colour-subcarrier cycle across the picture.
      const cycles = (N <= 300 ? 170.67 : 188) * (aspect / (4 / 3));
      const Gx = clamp(roundUp(4 * cycles, 8), 64, 2048);
      const rows = Math.ceil(N) + 1;
      const R8 = roundUp(rows, 8);

      // Horizontal beam sigma in grid samples: sharpX is in virtual pixels (hRes across 4:3).
      const samplesPerVPix = Gx / (P.hRes * aspect / (4 / 3));
      const sigmaH = Math.max(0.5, P.sharpX * samplesPerVPix);
      // BEAMH point-samples the filtered line at output-pixel centres: add the pixel's box footprint
      // (Gx / W samples wide, variance fp^2/12) like the vertical beam does, or small players alias.
      const sigmaBeam = Math.min(Math.hypot(sigmaH, (Gx / W) / Math.sqrt(12)), 7);
      const conv = P.convergence * samplesPerVPix;

      // Mask
      let maskType = P.maskType === 'auto' ? (P.autoMask || 'aperture') : P.maskType;
      if (P.maskStrength <= 0 || H < 480) maskType = 'none';
      if (maskType === 'slot' && p < 3.5) maskType = 'aperture';
      const maskP = clamp(Math.round(H / P.maskTVL), 2, 7);

      return { W, H, N, p, depth, sigmaMin, aspect, Gx, rows, R8, sigmaH, sigmaBeam, conv, maskType, maskP, visW, visH };
    }

    render() {
      if (this.lost || !this.hasFrame || !this.sized) return false;
      const W = this.outW, H = this.outH;
      if (!W || !H) return false;                                // lost but the event has not arrived yet
      const gl = this.gl, P = this.params;
      const L = this.layout = this._computeLayout(W, H);
      const vid = this.videoW && this.videoH;
      if (!vid) return false;

      // Kernels / mask only rebuilt when their inputs change.
      const kKey = `${P.signal}|${P.sharpness}`;
      if (kKey !== this.kernelKey) {
        this.kernels = P.signal === 'rgb' ? null : signalKernels(P.signal, P.sharpness);
        this.kernelKey = kKey;
      }
      const mKey = `${L.maskType}|${L.maskP}|${L.H}|${P.slotStrength}|${P.subpixel}`;
      if (mKey !== this.maskKey) {
        this.mask = L.maskType === 'none' ? null : buildMask(L.maskType, L.maskP, L.H, P.slotStrength, P.subpixel);
        if (this.mask) {
          gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.mask.w, this.mask.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.mask.data);
        }
        this.maskKey = mKey;
      }

      const gridA = this._target('gridA', L.Gx, L.R8, 'signal');
      const gridB = this._target('gridB', L.Gx, L.R8, 'linear');
      const lines = this._target('lines', L.W, L.R8, 'linear');
      // Bloom buffers: half width but every line kept. A grid sample is about half a line wide, so these
      // texels are roughly square, and the B-spline upsample alone no longer makes bloom taller than wide.
      const bh = this._target('bh', L.Gx / 2, L.R8, 'linear');
      const bht = this._target('bht', L.Gx / 2, L.R8, 'linear');
      const bhb = this._target('bhb', L.Gx / 2, L.R8, 'linear');
      const b2 = this._target('b2', L.Gx / 2, L.R8 / 2, 'linear');
      const b4 = this._target('b4', L.Gx / 4, L.R8 / 4, 'linear');
      const b8 = this._target('b8', L.Gx / 8, L.R8 / 8, 'linear');
      const b8t = this._target('b8t', L.Gx / 8, L.R8 / 8, 'linear');
      const b8b = this._target('b8b', L.Gx / 8, L.R8 / 8, 'linear');

      gl.bindVertexArray(this.vao);
      gl.disable(gl.BLEND);
      const draw = (target, prog, setup) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
        gl.viewport(0, 0, target ? target.w : L.W, target ? target.h : L.H);
        gl.useProgram(prog.p);
        setup(prog.u);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      };
      const bind = (unit, tex, loc) => { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(loc, unit); };

      // A: resample
      draw(gridA, this.prog.resample, u => {
        bind(0, this.videoTex, u.uVideo);
        gl.uniform4fv(u.uCrop, this.crop);
        gl.uniform2f(u.uGrid, L.Gx, L.N);
        gl.uniform1f(u.uPhase, P.phase);
        gl.uniform1f(u.uGammaIn, P.gammaIn);
      });

      // B: signal + colour
      const white = CRT.whiteGains(P.temperature);
      draw(gridB, this.prog.signal, u => {
        bind(0, gridA.tex, u.uSrc);
        gl.uniform2i(u.uSize, L.Gx, L.R8);
        const mode = P.signal === 'rgb' ? 0 : P.signal === 'svideo' ? 1 : 2;
        gl.uniform1i(u.uMode, mode);
        if (this.kernels) { gl.uniform1fv(u.uKY, this.kernels.kY); gl.uniform1fv(u.uKC, this.kernels.kC); }
        gl.uniform1f(u.uArtifacts, mode === 2 ? P.artifacts : 0);
        gl.uniform1f(u.uLineTurn, L.N <= 300 ? 0 : 0.5);         // carrier advance per line, in cycles
        gl.uniform1f(u.uNoise, P.signal === 'rf' ? 0.035 : 0);
        gl.uniform1ui(u.uFrame, this.frame >>> 0);
        gl.uniform1f(u.uBlack, P.blackLevel);
        gl.uniform1f(u.uGammaIn, P.gammaIn);
        gl.uniform1f(u.uSaturation, P.saturation);
        gl.uniform3fv(u.uWhite, white);
      });

      // C: horizontal beam at output width
      draw(lines, this.prog.beamh, u => {
        bind(0, gridB.tex, u.uSrc);
        gl.uniform2i(u.uSize, L.Gx, L.R8);
        gl.uniform1f(u.uOutW, L.W);
        gl.uniform1f(u.uSigma, L.sigmaBeam);
        gl.uniform1f(u.uConv, L.conv);
      });

      // Glow chain
      const useBloom = P.bloom > 0, useHalo = P.halation > 0;
      if (useBloom || useHalo) {
        const down = (src, dst) => draw(dst, this.prog.down, u => {
          bind(0, src.tex, u.uSrc); gl.uniform2f(u.uSrcSize, src.w, src.h); gl.uniform2f(u.uScale, src.w / dst.w, src.h / dst.h);
        });
        const blur = (src, dst, dx, dy, sigma) => draw(dst, this.prog.blur, u => {
          bind(0, src.tex, u.uSrc); gl.uniform2f(u.uSrcSize, src.w, src.h); gl.uniform2f(u.uDir, dx, dy); gl.uniform1f(u.uSigma, clamp(sigma, 0.3, 8));
        });
        // Physical sizes use the displayed shape (W/H), which differs from the video's with object-fit: fill.
        // Targets are total sigmas per axis in the buffer's own texels; glowSigma() removes what the
        // downsample chain and the B-spline upsample already contribute.
        const dispAspect = L.W / L.H;
        if (useBloom) {
          down(gridB, bh);                                           // 2x1: halves x only
          const sigV = P.bloomRadius * (bh.h / L.R8);                // lines -> bh rows (1 line per row)
          const sigH = (P.bloomRadius / L.N) * (bh.w / dispAspect);  // same physical size horizontally
          // Bloom lives at line resolution, so the composite reads it with one bilinear fetch (recon 1/6).
          blur(bh, bht, 1, 0, glowSigma(sigH, 1, 1 / 6));
          blur(bht, bhb, 0, 1, glowSigma(sigV, 0, 1 / 6));
        }
        if (useHalo) {
          down(gridB, b2);
          down(b2, b4);
          down(b4, b8);
          const pictureRows = b8.h * (L.N / L.R8);
          blur(b8, b8t, 1, 0, glowSigma(P.halationRadius * (b8.w / dispAspect), 3));
          blur(b8t, b8b, 0, 1, glowSigma(P.halationRadius * pictureRows, 3));
        }
      }

      // Final composite to the canvas
      draw(null, this.prog.composite, u => {
        bind(0, lines.tex, u.uLines);
        bind(1, (useBloom ? bhb : gridB).tex, u.uBloom);
        bind(2, (useHalo ? b8b : gridB).tex, u.uHalo);
        bind(3, this.maskTex, u.uMask);
        bind(4, this.videoTex, u.uVideo);
        gl.uniform2f(u.uOut, L.W, L.H);
        gl.uniform1i(u.uRows, L.R8);
        gl.uniform1f(u.uN, L.N);
        gl.uniform1f(u.uPhase, P.phase);
        gl.uniform1f(u.uSigmaDark, P.sigmaDark);
        gl.uniform1f(u.uSigmaBright, Math.max(P.sigmaBright, P.sigmaDark));
        gl.uniform1f(u.uSigmaMin, L.sigmaMin);
        gl.uniform1f(u.uBeamShape, P.beamShape);
        gl.uniform1f(u.uBeamEnergy, beamEnergy(P.beamShape));
        gl.uniform1f(u.uDepth, L.depth);
        gl.uniform1f(u.uBoost, P.boost);
        if (this.mask) {
          gl.uniform2i(u.uMaskSize, this.mask.w, this.mask.h);
          gl.uniform3fv(u.uMaskFill, this.mask.fill);
        } else {
          gl.uniform2i(u.uMaskSize, 0, 0);
          gl.uniform3f(u.uMaskFill, 0.5, 0.5, 0.5);
        }
        gl.uniform1f(u.uMaskStrength, P.maskStrength);
        gl.uniform1f(u.uBloomAmt, useBloom ? P.bloom : 0);
        gl.uniform1f(u.uHaloAmt, useHalo ? P.halation : 0);
        gl.uniform2f(u.uHaloSize, b8b.w, b8b.h);
        gl.uniform2f(u.uGlowY, L.N / L.R8, (1 - P.phase) / L.R8);
        gl.uniform1f(u.uGammaOut, P.gammaOut);
        gl.uniform4fv(u.uCrop, this.crop);
        gl.uniform1i(u.uCompare, P.compare ? 1 : 0);
      });
      this.dirty = false;
      return true;
    }

    info() {
      const L = this.layout;
      if (!L) return null;
      return {
        video: [this.videoW, this.videoH], out: [L.W, L.H], lines: Math.round(L.N * 100) / 100,
        pxPerLine: Math.round(L.p * 100) / 100, scanlineDepth: Math.round(L.depth * 100) / 100,
        grid: [L.Gx, L.R8], mask: this.mask ? this.mask.label : 'off', float: this.floatOK,
      };
    }

    destroy() {
      this.canvas.removeEventListener('webglcontextlost', this._onLost);
      this.canvas.removeEventListener('webglcontextrestored', this._onRestored);
      const gl = this.gl;
      this.gl = null;
      this.lost = true; this.hasFrame = false;                    // later render()/uploadFrame() calls are no-ops
      // Release the context now instead of waiting for GC: Chrome caps live contexts per page.
      const ext = gl && gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
  }

  CRT.Renderer = Renderer;
  CRT._internals = { buildMask, signalKernels, beamEnergy, glowSigma };
})(typeof self !== 'undefined' ? self : this);
