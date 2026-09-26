// Procedural animated test content, exposed as a MediaStream so it can feed a real <video> element.
// Modes mimic what the extension will see on the web:
//   "240p"  - 320x240 pixel art, nearest-neighbour upscaled to 1280x960 (like a YouTube retro-game upload)
//   "480p"  - 640x480 smooth "TV" content
//   "1080p" - 1920x1080 smooth HD content (letterboxed 2.39:1 band in the middle)
(function () {
  'use strict';

  // 16x16 sprite, original design. '.' = transparent.
  const SPRITE = [
    '.....KKKKKK.....',
    '...KKYYYYYYKK...',
    '..KYYYYYYYYYYK..',
    '.KYYWWYYYYWWYYK.',
    '.KYYWKYYYYWKYYK.',
    'KYYYWKYYYYWKYYYK',
    'KYYYYYYYYYYYYYYK',
    'KYYRYYYYYYYYRYYK',
    'KYYYRRYYYYRRYYYK',
    'KYYYYYRRRRYYYYYK',
    '.KYYYYYYYYYYYYK.',
    '.KOOYYYYYYYYOOK.',
    '..KOOOYYYYOOOK..',
    '...KKOOOOOOKK...',
    '....KKK..KKK....',
    '...KKK....KKK...',
  ];
  const SPRITE_PAL = { K: '#101018', Y: '#f8c838', W: '#ffffff', R: '#d83020', O: '#c86818' };

  // Limited "16-bit console" palette.
  const PAL = {
    sky: ['#2848a8', '#3060c0', '#4078d8', '#5890e8', '#70a8f0', '#90c0f8'],
    ground: '#6a3c18', grass: '#38a830', grassHi: '#70d048', dirtDk: '#4a2810',
    water1: '#2058d0', water2: '#e8f0ff', rock: '#686878', rockHi: '#9898a8',
  };

  function drawSprite(ctx, x, y, scale) {
    for (let r = 0; r < 16; r++) {
      for (let c = 0; c < 16; c++) {
        const ch = SPRITE[r][c];
        if (ch === '.') continue;
        ctx.fillStyle = SPRITE_PAL[ch];
        ctx.fillRect(x + c * scale, y + r * scale, scale, scale);
      }
    }
  }

  // 320x240 retro scene with the classic torture tests:
  // banded sky, 1px checkerboard + column dithering (composite "transparency"), fine vertical lines,
  // bright pixel text on black, colour bars, grey ramp.
  function drawRetro(ctx, t) {
    ctx.imageSmoothingEnabled = false;
    // Sky bands (hard palette steps, like SNES/Genesis gradients).
    for (let i = 0; i < 6; i++) { ctx.fillStyle = PAL.sky[i]; ctx.fillRect(0, i * 20, 320, 20); }
    // Dithered transition band between sky rows 2/3 (checkerboard).
    for (let y = 40; y < 44; y++) for (let x = 0; x < 320; x++) {
      if ((x + y) & 1) { ctx.fillStyle = PAL.sky[3]; ctx.fillRect(x, y, 1, 1); }
    }
    // Distant hills band (also clears the previous frame's sprite).
    ctx.fillStyle = '#183860'; ctx.fillRect(0, 120, 320, 50);
    ctx.fillStyle = '#20507a';
    for (let x = 0; x < 320; x++) {
      const hgt = 18 + Math.round(10 * Math.sin(x * 0.045) + 6 * Math.sin(x * 0.13 + 1));
      ctx.fillRect(x, 164 - hgt, 1, hgt);
    }
    // Ground.
    ctx.fillStyle = PAL.ground; ctx.fillRect(0, 170, 320, 70);
    ctx.fillStyle = PAL.grass; ctx.fillRect(0, 164, 320, 8);
    ctx.fillStyle = PAL.grassHi; for (let x = (Math.floor(t * 30) % 4); x < 320; x += 4) ctx.fillRect(x, 164, 2, 2);
    ctx.fillStyle = PAL.dirtDk; for (let y = 180; y < 240; y += 8) for (let x = (y / 8 & 1) * 8; x < 320; x += 16) ctx.fillRect(x, y, 8, 4);

    // Waterfall: vertical-stripe dither (1px columns alternating blue/white) - the composite-blend test.
    const wx = 200, ww = 40;
    for (let y = 60; y < 170; y++) for (let x = wx; x < wx + ww; x++) {
      const phase = Math.floor(y + t * 60) % 6 === 0;
      ctx.fillStyle = ((x & 1) === 0) !== phase ? PAL.water1 : PAL.water2;
      ctx.fillRect(x, y, 1, 1);
    }
    // Rocks either side of waterfall.
    ctx.fillStyle = PAL.rock; ctx.fillRect(wx - 12, 60, 12, 110); ctx.fillRect(wx + ww, 60, 12, 110);
    ctx.fillStyle = PAL.rockHi; ctx.fillRect(wx - 12, 60, 3, 110); ctx.fillRect(wx + ww, 60, 3, 110);

    // Checkerboard-dither "shadow" (50% transparency trick) under the sprite.
    const sx = 20 + Math.round((Math.sin(t * 0.8) * 0.5 + 0.5) * 140);
    const jump = Math.max(0, Math.sin(t * 3)) * 24;
    for (let y = 172; y < 176; y++) for (let x = sx; x < sx + 32; x++) {
      if ((x + y) & 1) { ctx.fillStyle = '#000000'; ctx.fillRect(x, y, 1, 1); }
    }
    drawSprite(ctx, sx, 140 - Math.round(jump), 2);

    // HUD: black box with bright text (glow / halation test).
    ctx.fillStyle = '#000000'; ctx.fillRect(4, 4, 124, 30);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 10px monospace'; ctx.textBaseline = 'top';
    ctx.fillText('SCORE 0' + String(Math.floor(t * 100) % 100000).padStart(5, '0'), 8, 8);
    ctx.fillStyle = '#ff4040'; ctx.fillText('LIVES x3', 8, 20);

    // Fine vertical lines (1px on/off) + 2px on/off: mask/moire test.
    ctx.fillStyle = '#000'; ctx.fillRect(250, 4, 66, 30);
    for (let x = 252; x < 282; x += 2) { ctx.fillStyle = '#fff'; ctx.fillRect(x, 6, 1, 26); }
    for (let x = 284; x < 314; x += 4) { ctx.fillStyle = '#fff'; ctx.fillRect(x, 6, 2, 26); }

    // Colour bars + grey ramp along the bottom.
    const bars = ['#ffffff', '#ffff00', '#00ffff', '#00ff00', '#ff00ff', '#ff0000', '#0000ff', '#000000'];
    for (let i = 0; i < 8; i++) { ctx.fillStyle = bars[i]; ctx.fillRect(i * 40, 212, 40, 14); }
    for (let i = 0; i < 16; i++) { const v = Math.round(i * 17); ctx.fillStyle = `rgb(${v},${v},${v})`; ctx.fillRect(i * 20, 226, 20, 14); }
  }

  // Smooth "photographic" content for 480p/1080p: gradients, skin tones, bright text, fine detail.
  function drawSmooth(ctx, w, h, t) {
    ctx.imageSmoothingEnabled = true;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#0b1a3a'); g.addColorStop(0.55, '#d0703a'); g.addColorStop(1, '#2a1208');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    // Sun with soft glow.
    const cx = w * (0.3 + 0.1 * Math.sin(t * 0.3)), cy = h * 0.52, r = h * 0.12;
    const sun = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 3);
    sun.addColorStop(0, 'rgba(255,250,220,1)'); sun.addColorStop(0.3, 'rgba(255,200,120,0.8)'); sun.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 0, w, h);
    // Skin-tone swatches (light -> dark) - saturation/hue sanity check.
    const skins = ['#f6d3bd', '#e8b996', '#d19a74', '#a86f4c', '#7a4a2e', '#4a2c1c'];
    const sw = w * 0.07;
    for (let i = 0; i < skins.length; i++) { ctx.fillStyle = skins[i]; ctx.fillRect(w * 0.55 + i * sw, h * 0.15, sw, sw); }
    // A "face": circle with shading.
    const fx = w * 0.72, fy = h * 0.58, fr = h * 0.16;
    const face = ctx.createRadialGradient(fx - fr * 0.3, fy - fr * 0.3, fr * 0.1, fx, fy, fr);
    face.addColorStop(0, '#f3c9a8'); face.addColorStop(1, '#8a5436');
    ctx.fillStyle = face; ctx.beginPath(); ctx.arc(fx, fy, fr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#20120a';
    ctx.beginPath(); ctx.arc(fx - fr * 0.35, fy - fr * 0.1, fr * 0.08, 0, 7); ctx.arc(fx + fr * 0.35, fy - fr * 0.1, fr * 0.08, 0, 7); ctx.fill();
    // Subtitle-style bright text on dark band.
    ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.fillRect(0, h * 0.84, w, h * 0.1);
    ctx.fillStyle = '#ffffff'; ctx.font = `${Math.round(h * 0.05)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('"I remember when TV glowed like this."', w / 2, h * 0.89);
    ctx.textAlign = 'left';
    // Fine horizontal + vertical line gratings (aliasing/moire check).
    const gx = w * 0.05, gy = h * 0.1, gs = h * 0.2;
    ctx.fillStyle = '#000'; ctx.fillRect(gx, gy, gs * 2.1, gs);
    ctx.fillStyle = '#fff';
    for (let i = 0; i < gs; i += 2) ctx.fillRect(gx + i, gy, 1, gs);
    for (let i = 0; i < gs; i += 2) ctx.fillRect(gx + gs * 1.1, gy + i, gs, 1);
    // Moving white bar (motion check).
    ctx.fillStyle = '#fff'; ctx.fillRect(((t * 0.25) % 1) * w, h * 0.78, w * 0.02, h * 0.04);
  }

  function create(mode) {
    const out = document.createElement('canvas');
    const octx = out.getContext('2d');
    let src = null, sctx = null;
    if (mode === '240p') {
      out.width = 1280; out.height = 960;
      src = document.createElement('canvas'); src.width = 320; src.height = 240; sctx = src.getContext('2d');
    } else if (mode === '480p') {
      out.width = 640; out.height = 480;
    } else {
      out.width = 1920; out.height = 1080;
    }
    const start = performance.now();
    let raf = 0;
    function frame() {
      const t = (performance.now() - start) / 1000;
      if (mode === '240p') {
        drawRetro(sctx, t);
        octx.imageSmoothingEnabled = false;
        octx.drawImage(src, 0, 0, out.width, out.height);
      } else if (mode === '480p') {
        drawSmooth(octx, out.width, out.height, t);
      } else {
        octx.fillStyle = '#000'; octx.fillRect(0, 0, out.width, out.height);
        const bandH = Math.round(out.width / 2.39);
        const y0 = Math.round((out.height - bandH) / 2);
        octx.save(); octx.translate(0, y0);
        octx.beginPath(); octx.rect(0, 0, out.width, bandH); octx.clip();
        drawSmooth(octx, out.width, bandH, t);
        octx.restore();
      }
      raf = requestAnimationFrame(frame);
    }
    frame();
    const stream = out.captureStream(60);
    return { stream, canvas: out, stop() { cancelAnimationFrame(raf); stream.getTracks().forEach(tr => tr.stop()); } };
  }

  window.TestCard = { create };
})();
