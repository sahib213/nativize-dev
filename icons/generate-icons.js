/*
 * Nativize icon generator — PURE Node, zero dependencies (uses built-in zlib).
 *
 * Emits gradient PNG icons (16/48/128) with a rounded-square badge, a violet→
 * blue diagonal gradient, and a white "phone + up arrow" glyph (web → native,
 * elevated). Run:  node icons/generate-icons.js
 */
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

// ---- minimal PNG encoder ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression/filter/interlace = 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---- drawing helpers ----
function lerp(a, b, t) { return a + (b - a) * t; }
function mix(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t))
  ];
}

function render(size) {
  const VIOLET = [124, 58, 237];
  const BLUE = [37, 99, 235];
  const buf = Buffer.alloc(size * size * 4);
  const radius = size * 0.22; // rounded-square corner radius

  // glyph geometry (normalized to size)
  const cx = size * 0.5;
  const shaftW = size * 0.13;
  const shaftTop = size * 0.40;
  const shaftBot = size * 0.74;
  const headHalf = size * 0.17;
  const headTop = size * 0.26;
  const headBot = shaftTop + size * 0.02;

  function insideRounded(x, y) {
    const minX = radius, maxX = size - radius;
    const minY = radius, maxY = size - radius;
    let dx = 0, dy = 0;
    if (x < minX) dx = minX - x; else if (x > maxX) dx = x - maxX;
    if (y < minY) dy = minY - y; else if (y > maxY) dy = y - maxY;
    return dx * dx + dy * dy <= radius * radius;
  }
  function inArrow(x, y) {
    // shaft
    if (x >= cx - shaftW / 2 && x <= cx + shaftW / 2 && y >= shaftTop && y <= shaftBot) return true;
    // head: triangle from (cx, headTop) widening down to headBot
    if (y >= headTop && y <= headBot) {
      const t = (y - headTop) / (headBot - headTop);
      const half = headHalf * t;
      if (x >= cx - half && x <= cx + half) return true;
    }
    return false;
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (!insideRounded(x + 0.5, y + 0.5)) {
        buf[i] = buf[i + 1] = buf[i + 2] = buf[i + 3] = 0; // transparent
        continue;
      }
      const t = (x + y) / (2 * size); // diagonal gradient
      let [r, g, b] = mix(VIOLET, BLUE, t);
      if (inArrow(x + 0.5, y + 0.5)) { r = g = b = 255; }
      buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
    }
  }
  return encodePNG(size, size, buf);
}

[16, 48, 128].forEach((s) => {
  const out = path.join(__dirname, `icon${s}.png`);
  fs.writeFileSync(out, render(s));
  console.log("wrote", out);
});
