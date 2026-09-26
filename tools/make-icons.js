// Generates the extension's PNG icons (a little CRT with glowing scanlines) with no dependencies.
// Usage: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Signed distance to a rounded box centred at (0,0).
function sdRoundBox(px, py, hw, hh, r) {
  const qx = Math.abs(px) - hw + r, qy = Math.abs(py) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function render(size) {
  const SS = 4; // supersampling
  const out = Buffer.alloc(size * size * 4);
  const lines = Math.max(4, Math.round(size / 8)); // scanline count across the screen
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const u = (x + (sx + 0.5) / SS) / size * 2 - 1;
      const v = (y + (sy + 0.5) / SS) / size * 2 - 1;
      const body = sdRoundBox(u, v - 0.02, 0.94, 0.84, 0.22);
      if (body > 0) continue;
      const screen = sdRoundBox(u, v - 0.02, 0.76, 0.66, 0.16);
      let cr, cg, cb;
      if (screen < 0) {
        // Warm-to-cool gradient, modulated into scanlines.
        const t = (v + 0.66) / 1.32;
        cr = 255 * (0.95 - 0.55 * t); cg = 255 * (0.45 + 0.25 * Math.sin(t * 3.1)); cb = 255 * (0.25 + 0.7 * t);
        const ly = ((t * lines) % 1) - 0.5;
        const beam = Math.exp(-ly * ly / 0.06);
        const glow = 0.25;
        const k = glow + (1 - glow) * beam;
        cr *= k; cg *= k; cb *= k;
      } else {
        const edge = Math.min(1, -body * 12);
        cr = cg = cb = 34 + 20 * edge;
      }
      r += cr; g += cg; b += cb; a += 255;
    }
    const n = SS * SS, i = (y * size + x) * 4;
    const alpha = a / n;
    // Un-premultiply colour by coverage.
    const cov = a / 255 || 1;
    out[i] = Math.min(255, r / cov); out[i + 1] = Math.min(255, g / cov); out[i + 2] = Math.min(255, b / cov); out[i + 3] = alpha;
  }
  return png(size, out);
}

const dir = path.resolve(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dir, `icon${s}.png`), render(s));
  console.log(`wrote icons/icon${s}.png`);
}
