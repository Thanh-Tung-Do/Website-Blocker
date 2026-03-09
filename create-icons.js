/**
 * create-icons.js
 * Generates placeholder PNG icons (solid indigo squares) for the extension.
 *
 * Usage:
 *   node create-icons.js
 *
 * Requires only Node.js built-ins (no npm packages needed).
 * After running, the icons/ folder will contain icon16.png, icon48.png, icon128.png.
 */

const fs   = require('fs');
const zlib = require('zlib');
const path = require('path');

// ── CRC-32 (needed for PNG chunk checksums) ──────────────────
function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c;
  }
  return table;
}

const CRC_TABLE = buildCrcTable();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── PNG chunk builder ─────────────────────────────────────────
function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf  = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(data.length, 0);

  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf   = Buffer.allocUnsafe(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

// ── Generate a solid-colour PNG ───────────────────────────────
function makeSolidPNG(size, r, g, b) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR: width, height, bit-depth=8, color-type=2 (RGB), compress=0, filter=0, interlace=0
  const ihdrData = Buffer.allocUnsafe(13);
  ihdrData.writeUInt32BE(size, 0);
  ihdrData.writeUInt32BE(size, 4);
  ihdrData[8]  = 8; // bit depth
  ihdrData[9]  = 2; // RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;

  // Raw image data: one filter byte (0 = None) per row, then RGB triples
  const rowSize = 1 + size * 3;
  const raw     = Buffer.allocUnsafe(size * rowSize);

  for (let y = 0; y < size; y++) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0; // filter byte
    for (let x = 0; x < size; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px]     = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdrData),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0))
  ]);
}

// ── Main ──────────────────────────────────────────────────────
const iconsDir = path.join(__dirname, 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir);

// Indigo-500: #6366f1
const R = 99, G = 102, B = 241;

[16, 48, 128].forEach(size => {
  const png  = makeSolidPNG(size, R, G, B);
  const file = path.join(iconsDir, `icon${size}.png`);
  fs.writeFileSync(file, png);
  console.log(`✓  icons/icon${size}.png  (${png.length} bytes)`);
});

console.log('\nAll icons created. You can now load the extension in Chrome.');
