// GLSL ES 3.00 sources for the CRT pipeline. Original code; algorithms follow the published techniques
// credited in the README (Lottes-style masks, guest/Royale-style brightness-dependent beams, NTSC YIQ filtering).
//
// Texture conventions: every intermediate texture stores the TOP of the picture in row 0.
// Grid = the "virtual CRT" raster: Gx samples per line × R rows (R = ceil(N) + 1, row r = line r-1).
(function (root) {
  'use strict';
  const CRT = root.CRT = root.CRT || {};

  const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

  // Full-screen triangle; vUv covers [0,1] over the viewport (y=0 at the bottom, as usual in GL).
  const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  // Pass A: area-resample the video frame onto the virtual raster, averaging in linear light.
  // Exact box filter: every video texel under a grid sample's footprint is fetched on its own and linearised
  // BEFORE it is weighted by its overlap. (Bilinear taps would blend gamma-encoded texels first, so thin bright
  // detail would lose most of its area share and pulse as it moves across texel rows.)
  // Output: gamma-encoded R'G'B' (what an analog video signal carries), RGBA16F.
  const RESAMPLE = HEADER + `
uniform sampler2D uVideo;
uniform vec4  uCrop;      // visible video UV rect: u0, v0, u1, v1 (v=0 is the top row of the video)
uniform vec2  uGrid;      // Gx, N (N may be fractional)
uniform float uPhase;     // line phase (0..1 line)
uniform float uGammaIn;
out vec4 outColor;

const int MAX_X = 8, MAX_Y = 12;                         // texels visited per axis

// Step j across the footprint [a, b) on one axis (in texels) -> (texel index, weight).
// Footprints spanning up to nmax texels visit every covered texel with its exact overlap; wider ones (very
// large sources) are strided with nmax equally weighted texels spread evenly across the footprint.
vec2 boxTap(float a, float b, int j, int nmax, int size) {
  float t, w;
  if (ceil(b) - floor(a) <= float(nmax)) {
    t = floor(a) + float(j);
    w = max(min(b, t + 1.0) - max(a, t), 0.0);
  } else {
    t = floor(mix(a, b, (float(j) + 0.5) / float(nmax)));
    w = 1.0;
  }
  return vec2(clamp(t, 0.0, float(size - 1)), w);        // clamped index = edge texels repeat (clamp-to-edge)
}

void main() {
  vec2 px = floor(gl_FragCoord.xy);
  float line = px.y - 1.0;                               // row r holds line r-1
  vec2 uvA = vec2(px.x / uGrid.x, (line + uPhase) / uGrid.y);
  vec2 uvB = vec2((px.x + 1.0) / uGrid.x, (line + 1.0 + uPhase) / uGrid.y);
  vec2 span = uCrop.zw - uCrop.xy;
  // The frame's own size, not videoWidth/Height: they can briefly disagree during bitrate switches.
  ivec2 size = textureSize(uVideo, 0);
  vec2 a = (uCrop.xy + uvA * span) * vec2(size);         // footprint in texel units
  vec2 b = (uCrop.xy + uvB * span) * vec2(size);
  int nx = int(min(ceil(b.x) - floor(a.x), float(MAX_X)));
  int ny = int(min(ceil(b.y) - floor(a.y), float(MAX_Y)));
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int j = 0; j < MAX_Y; j++) {
    if (j >= ny) break;
    vec2 ty = boxTap(a.y, b.y, j, MAX_Y, size.y);
    for (int i = 0; i < MAX_X; i++) {
      if (i >= nx) break;
      vec2 tx = boxTap(a.x, b.x, i, MAX_X, size.x);
      float w = tx.y * ty.y;
      acc += w * pow(texelFetch(uVideo, ivec2(tx.x, ty.x), 0).rgb, vec3(uGammaIn));
      wsum += w;
    }
  }
  acc /= max(wsum, 1e-6);
  outColor = vec4(pow(acc, vec3(1.0 / uGammaIn)), 1.0);
}`;

  // Pass B: analog signal path (RGB / S-Video / composite / RF) + colour controls, on the grid.
  // Composite is simulated for real: YIQ is QAM-modulated onto a carrier with 4 grid samples per cycle,
  // then decoded with a notch+low-pass luma filter and a low-pass chroma demodulator. Output: linear RGB.
  const SIGNAL = HEADER + `
uniform sampler2D uSrc;          // gamma-encoded grid
uniform ivec2 uSize;             // Gx, R
uniform int   uMode;             // 0 = RGB, 1 = S-Video, 2 = composite / RF
uniform float uKY[21];           // luma kernel (DC gain 1)
uniform float uKC[21];           // chroma low-pass kernel (DC gain 1)
uniform float uArtifacts;        // 0 = clean separation, 1 = full modulated cross-talk
uniform float uLineTurn;         // carrier phase advance per line, in cycles (0 or 0.5)
uniform float uNoise;            // RF noise amplitude
uniform uint  uFrame;            // frame counter for noise
uniform float uBlack;            // black level lift (signal units)
uniform float uGammaIn;
uniform float uSaturation;
uniform vec3  uWhite;            // linear per-channel white-point gains
out vec4 outColor;

const mat3 RGB2YIQ = mat3(0.299, 0.595716, 0.211456,
                          0.587, -0.274453, -0.522591,
                          0.114, -0.321263, 0.311135);
const mat3 YIQ2RGB = mat3(1.0, 1.0, 1.0,
                          0.9563, -0.2721, -1.1070,
                          0.6210, -0.6474, 1.7046);

// PCG-style integer hash (Jarzynski & Olano 2020): full 32-bit mixing, so the noise has no float-precision
// quantisation or pattern at large coordinates / frame counts.
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 rgb;
  if (uMode == 0) {
    rgb = texelFetch(uSrc, p, 0).rgb;
  } else {
    float Yc = 0.0, Ym = 0.0, Yn = 0.0;
    vec2 Cc = vec2(0.0), Cm = vec2(0.0), Cn = vec2(0.0);
    // Per-line carrier offset as a rotation, from a reduced angle (0 or pi): cos/sin evaluated once, never at
    // the large arguments a per-tap HALF_PI * x would reach.
    float lineOff = 6.2831853 * fract(uLineTurn * float(p.y));
    vec2 rot = vec2(cos(lineOff), sin(lineOff));
    for (int k = -10; k <= 10; k++) {
      // Edge taps repeat the border sample but the carrier keeps running (phase from the unclamped xi):
      // a held sample under a fixed carrier phase would demodulate as false chroma on flat edges.
      int xi = p.x + k;
      int x = clamp(xi, 0, uSize.x - 1);
      vec3 yiq = RGB2YIQ * texelFetch(uSrc, ivec2(x, p.y), 0).rgb;
      int q = (xi + 4096) & 3;                           // 4 samples per carrier cycle: exact quadrant
      vec2 cq = vec2(float(1 - (q & 1)) * (1.0 - float(q)), float(q & 1) * (2.0 - float(q)));   // cos, sin of q*pi/2
      vec2 cs = vec2(cq.x * rot.x - cq.y * rot.y, cq.y * rot.x + cq.x * rot.y);
      float s = yiq.x + dot(yiq.yz, cs);                 // composite signal sample
      float wy = uKY[k + 10], wc = uKC[k + 10];
      Yc += wy * yiq.x;
      Ym += wy * s;
      Cc += wc * yiq.yz;
      Cm += (2.0 * wc * s) * cs;                         // synchronous demodulation
      if (uNoise > 0.0) {
        // RF noise rides on the received signal, so it passes the same decoder filters but is kept apart
        // from the cross-talk mix: it shows whatever uArtifacts is set to.
        uint h = pcg3d(uvec3(uint(xi + 16), uint(p.y), uFrame)).x;
        float nz = uNoise * (float(h >> 8u) * (1.0 / 16777216.0) - 0.5);
        Yn += wy * nz;
        Cn += (2.0 * wc * nz) * cs;
      }
    }
    float Y = mix(Yc, Ym, uArtifacts) + Yn;
    vec2 C = mix(Cc, Cm, uArtifacts) + Cn;
    rgb = YIQ2RGB * vec3(Y, C);
  }
  rgb = max((rgb + uBlack) / (1.0 + uBlack), 0.0);
  vec3 lin = pow(rgb, vec3(uGammaIn));
  float l = dot(lin, vec3(0.2126, 0.7152, 0.0722));
  lin = max(mix(vec3(l), lin, uSaturation), 0.0) * uWhite;
  outColor = vec4(lin, 1.0);
}`;

  // Pass C: horizontal beam spot. Filters each grid line with a Gaussian at every OUTPUT column, so the
  // final pass only needs one exact texel per scanline. Per-channel offsets model static misconvergence.
  const BEAMH = HEADER + `
uniform sampler2D uSrc;          // linear grid
uniform ivec2 uSize;             // Gx, R
uniform float uOutW;             // output width in device px
uniform float uSigma;            // beam sigma in grid samples, output-pixel footprint included (<= 7)
uniform float uConv;             // convergence offset in grid samples (R: +, B: -)
out vec4 outColor;

vec3 filt(float center, int ch3) {
  float s2 = -0.5 / (uSigma * uSigma);
  int r = int(ceil(2.6 * uSigma));
  int c0 = int(floor(center));
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  // Taps c0-r .. c0+r+1 (2r+2 of them, r <= ceil(2.6 * 7) = 19): counted from the first tap with an early
  // break, so a small sigma never walks the full bound.
  for (int i = 0; i < 40; i++) {
    if (i > 2 * r + 1) break;
    int x = c0 - r + i;
    float d = float(x) - center;
    float w = exp(s2 * d * d);
    acc += w * texelFetch(uSrc, ivec2(clamp(x, 0, uSize.x - 1), int(gl_FragCoord.y)), 0).rgb;
    wsum += w;
  }
  return acc / wsum;
}

void main() {
  float center = (gl_FragCoord.x / uOutW) * float(uSize.x) - 0.5;
  vec3 c;
  if (uConv > 0.001) {
    c.r = filt(center - uConv, 0).r;
    c.g = filt(center, 1).g;
    c.b = filt(center + uConv, 2).b;
  } else {
    c = filt(center, 1);
  }
  outColor = vec4(c, 1.0);
}`;

  // Box downsample by 2 per axis, or 1 to keep that axis: one bilinear tap at the shared corner of each
  // 2x2 / 2x1 block (at a texel centre along a kept axis).
  const DOWN = HEADER + `
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform vec2 uScale;             // source texels per output texel: (2,2), or (2,1) to keep every line
out vec4 outColor;
void main() {
  vec2 uv = (floor(gl_FragCoord.xy) + 0.5) * uScale / uSrcSize;
  outColor = vec4(texture(uSrc, uv).rgb, 1.0);
}`;

  // Separable Gaussian blur (linear-sampling trick: pairs of taps merged into one bilinear fetch).
  const BLUR = HEADER + `
uniform sampler2D uSrc;
uniform vec2 uSrcSize;
uniform vec2 uDir;               // (1,0) or (0,1)
uniform float uSigma;            // in texels
out vec4 outColor;
void main() {
  vec2 uv = gl_FragCoord.xy / uSrcSize;
  vec2 stepv = uDir / uSrcSize;
  float s2 = -0.5 / (uSigma * uSigma);
  vec3 acc = texture(uSrc, uv).rgb;
  float wsum = 1.0;
  int r = int(ceil(3.0 * uSigma));
  for (int k = 1; k <= 24; k += 2) {
    if (k > r) break;
    float w1 = exp(s2 * float(k * k));
    float w2 = exp(s2 * float((k + 1) * (k + 1)));
    float w = w1 + w2;
    float o = float(k) + w2 / w;
    acc += w * (texture(uSrc, uv + stepv * o).rgb + texture(uSrc, uv - stepv * o).rgb);
    wsum += 2.0 * w;
  }
  outColor = vec4(acc / wsum, 1.0);
}`;

  // Final pass: scanline beams + phosphor mask + glow, at native device resolution.
  const COMPOSITE = HEADER + `
uniform sampler2D uLines;        // Wout × R, linear, horizontally beam-filtered lines
uniform sampler2D uBloom;        // linear, blurred (narrow)
uniform sampler2D uHalo;         // linear, blurred (wide)
uniform sampler2D uMask;         // mask tile (RGBA8, values 0..1)
uniform sampler2D uVideo;        // raw video, for compare mode
uniform vec2  uOut;              // output size in device px
uniform int   uRows;             // R
uniform float uN;                // virtual line count
uniform float uPhase;
uniform float uSigmaDark, uSigmaBright, uSigmaMin;
uniform float uBeamShape;        // 2 = Gaussian, >2 = flatter top / harder edge
uniform float uBeamEnergy;       // integral of beam() over d per unit sigma: 2^(1+1/beta) * Gamma(1+1/beta)
uniform float uDepth;            // scanline visibility 0..1 (fades out on tiny players)
uniform float uBoost;
uniform ivec2 uMaskSize;         // tile size, (0,0) = mask off
uniform vec3  uMaskFill;         // per-channel lit fraction of the tile
uniform float uMaskStrength;
uniform float uBloomAmt, uHaloAmt;
uniform vec2  uHaloSize;
uniform vec2  uGlowY;            // picture v -> grid texture v: v * x + y (grid rows are offset by phase / 1 line)
uniform float uGammaOut;
uniform vec4  uCrop;
uniform int   uCompare;
out vec4 outColor;

float maxc(vec3 c) { return max(c.r, max(c.g, c.b)); }

// Cubic B-spline texture filter from 4 bilinear taps (smooth upsampling of the small glow buffers).
vec3 textureBSpline(sampler2D t, vec2 uv, vec2 size) {
  vec2 st = uv * size - 0.5;
  vec2 i = floor(st), f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (w1 / g0) - 1.0 + i + 0.5, h1 = (w3 / g1) + 1.0 + i + 0.5;
  h0 /= size; h1 /= size;
  return g0.y * (g0.x * texture(t, vec2(h0.x, h0.y)).rgb + g1.x * texture(t, vec2(h1.x, h0.y)).rgb) +
         g1.y * (g0.x * texture(t, vec2(h0.x, h1.y)).rgb + g1.x * texture(t, vec2(h1.x, h1.y)).rgb);
}

// Beam sigma (in lines) per channel: brighter lines are wider.
vec3 beamSigma(vec3 c) {
  return max(mix(vec3(uSigmaDark), vec3(uSigmaBright), sqrt(clamp(c, 0.0, 1.0))), vec3(uSigmaMin));
}

// Beam profile weight for distance d (in lines) at pixel height h (in lines), per channel.
vec3 beam(vec3 c, float d, float h) {
  vec3 s = beamSigma(c);
  if (uBeamShape <= 2.001) {
    // Gaussian convolved with the pixel's box footprint (variance addition), energy preserved.
    vec3 se2 = s * s + (h * h / 12.0);
    return (s * inversesqrt(se2)) * exp(-0.5 * d * d / se2);
  }
  // Generalised Gaussian, averaged over three sub-positions of the pixel.
  vec3 w = vec3(0.0);
  for (int k = -1; k <= 1; k++) {
    float dd = abs(d + float(k) * h / 3.0);
    w += exp(-0.5 * pow(vec3(dd) / s, vec3(uBeamShape)));
  }
  return w / 3.0;
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec2 frag = floor(gl_FragCoord.xy);
  float yTop = uOut.y - 1.0 - frag.y;                    // device row counted from the top
  vec2 uv = vec2((frag.x + 0.5) / uOut.x, (yTop + 0.5) / uOut.y);   // picture coords, v=0 at top

  if (uCompare == 1 && frag.x < floor(uOut.x * 0.5)) {
    vec3 raw = texture(uVideo, uCrop.xy + uv * (uCrop.zw - uCrop.xy)).rgb;
    if (frag.x > floor(uOut.x * 0.5) - 2.0) raw = vec3(1.0, 0.85, 0.2);
    outColor = vec4(raw, 1.0);
    return;
  }

  // --- scanlines ---
  float h = uN / uOut.y;                                  // pixel height in line units
  float yl = uv.y * uN - uPhase - 0.5;                    // 0 at the centre of line 0
  float i0 = floor(yl);
  float f = yl - i0;
  int x = int(frag.x);
  vec3 acc = vec3(0.0);
  vec3 cA = vec3(0.0), cB = vec3(0.0);
  for (int j = -1; j <= 2; j++) {
    int row = clamp(int(i0) + j + 1, 0, uRows - 1);
    vec3 c = texelFetch(uLines, ivec2(x, row), 0).rgb;
    if (j == 0) cA = c;
    if (j == 1) cB = c;
    acc += c * beam(c, f - float(j), h);
  }
  // The beams only deliver s(c) * uBeamEnergy of each line's light (peak-normalised profile), so the flat
  // path is scaled to match: fading the scanlines out on small players removes structure, not brightness.
  vec3 flat_ = mix(cA, cB, smoothstep(0.0, 1.0, f));
  flat_ *= beamSigma(flat_) * uBeamEnergy;
  vec3 col = mix(flat_, acc, uDepth) * uBoost;

  // --- phosphor mask (energy-conserving: redistributes light, never loses it) ---
  if (uMaskSize.x > 0) {
    ivec2 mp = ivec2(int(frag.x) % uMaskSize.x, int(yTop) % uMaskSize.y);
    vec3 m = texelFetch(uMask, mp, 0).rgb;
    vec3 fill = uMaskFill;
    vec3 lit = min(col / fill, 1.0);
    vec3 unlit = clamp((col - fill) / (1.0 - fill), 0.0, 1.0);
    // Above 1.0 the whole tile is saturated: carry the excess through uniformly so the soft clip below
    // still sees it (continuous at 1.0, energy-exact above it).
    vec3 ec = mix(unlit, lit, m) * max(col, vec3(1.0));
    col = mix(col, ec, uMaskStrength);
  }

  // --- glow: bloom swallows the structure in bright areas, halation adds a soft veil ---
  vec2 guv = vec2(uv.x, uv.y * uGlowY.x + uGlowY.y);
  if (uBloomAmt > 0.0) {
    vec3 b = texture(uBloom, guv).rgb * uBoost;   // line-resolution buffer: bilinear is smooth enough
    // Gate on a luma/max-channel blend: whites and hot saturated colours bloom, a mid-blue sky does not.
    float lum = 0.5 * (dot(b, vec3(0.2126, 0.7152, 0.0722)) + maxc(b));
    float g = uBloomAmt * smoothstep(0.35, 1.0, lum);
    col = mix(col, b, g);
  }
  if (uHaloAmt > 0.0) {
    vec3 hl = textureBSpline(uHalo, guv, uHaloSize) * uBoost;
    col = mix(col, hl, uHaloAmt);
  }

  // --- per-channel soft clip (each electron gun saturates on its own), encode, dither ---
  const float knee = 0.8;
  vec3 over = max(col - knee, 0.0);
  col = min(col, vec3(knee)) + (1.0 - knee) * (1.0 - exp(-over / (1.0 - knee)));
  col = pow(max(col, 0.0), vec3(1.0 / uGammaOut));
  float n = hash12(frag) + hash12(frag + 17.13) - 1.0;   // triangular, ±1 LSB
  col += n / 255.0;
  outColor = vec4(col, 1.0);
}`;

  CRT.SHADERS = { VERT, RESAMPLE, SIGNAL, BEAMH, DOWN, BLUR, COMPOSITE };
})(typeof self !== 'undefined' ? self : this);
