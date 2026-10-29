import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

// Fixed authored RGB8 PNG. No fonts, external images, profiles or ancillary chunks.
const width = 512, height = 512;
const colors = [[224, 48, 48], [48, 176, 80], [48, 96, 224], [240, 192, 48]];
const raw = Buffer.alloc(height * (1 + width * 3));
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const rgb = x >= 192 && x < 320 && y >= 192 && y < 320 ? [255, 255, 255] : colors[Math.floor(x / 256) + 2 * Math.floor(y / 256)];
    raw.set(rgb, y * (1 + width * 3) + 1 + x * 3);
  }
}
function chunk({ type, bytes }) {
  const data = Buffer.concat([Buffer.from(type), bytes]);
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, data, checksum]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(width);
ihdr.writeUInt32BE(height, 4);
ihdr[8] = 8;
ihdr[9] = 2;
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk({ type: 'IHDR', bytes: ihdr }),
  chunk({ type: 'IDAT', bytes: deflateSync(raw, { level: 9 }) }),
  chunk({ type: 'IEND', bytes: Buffer.alloc(0) }),
]);
const target = new URL('../src/features/llama-cpp-browser/performance/fixtures/rgb-quadrants-512-v1.png', import.meta.url);
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--check') {
  if (!png.equals(readFileSync(target))) {
    throw new Error('Fixture PNG changed; preserve the protocol identity or version it explicitly');
  }
} else if (args.length === 0) {
  writeFileSync(target, png);
} else {
  throw new Error('Usage: node scripts/generate-vision-performance-fixture.mjs [--check]');
}
