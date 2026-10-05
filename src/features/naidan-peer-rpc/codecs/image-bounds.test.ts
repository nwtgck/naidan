import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { peerImageDimensions } from './image-bounds';

function fixture({ name }: { name: string }): Uint8Array<ArrayBuffer> {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}
for (const name of ['baseline.jpg', 'progressive.jpg', 'grayscale.jpg', 'rgb.png', 'lossless.webp', 'lossy.webp']) {
  it(`accepts the generated ${name} fixture through an offset byte view`, () => {
    const bytes = fixture({ name }), storage = new Uint8Array(bytes.length + 17);
    storage.set(bytes, 11);
    const mimeType = name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.png') ? 'image/png' : 'image/webp';
    expect(peerImageDimensions({ bytes: storage.subarray(11, 11 + bytes.length), mimeType })).toEqual({ width: 32, height: 24 });
  });
}
function spliceBeforeEnd({ inserted }: { inserted: number[] }) {
  const bytes = fixture({ name: 'baseline.jpg' });
  return new Uint8Array([...bytes.subarray(0, -2), ...inserted, 0xff, 0xd9]);
}
it('does not trust a second frame header hidden after the first scan', () => {
  const bytes = fixture({ name: 'baseline.jpg' });
  const marker = bytes.findIndex((value, at) => value === 0xff && bytes[at + 1] === 0xc0);
  const length = new DataView(bytes.buffer).getUint16(marker + 2);
  const second = [...bytes.subarray(marker, marker + 2 + length)];
  second[7] = 0x20; second[8] = 0;
  expect(() => peerImageDimensions({ bytes: spliceBeforeEnd({ inserted: second }), mimeType: 'image/jpeg' })).toThrow();
});
it.each([
  { label: 'DNL height redefinition', marker: [0xff, 0xdc, 0, 4, 0x20, 0] },
  { label: 'second image start', marker: [0xff, 0xd8] },
  { label: 'truncated metadata after scan', marker: [0xff, 0xe1, 0xff, 0xff] },
  { label: 'early image end and trailing image', marker: [0xff, 0xd9, 0xff, 0xd8] },
])('rejects $label after entropy-coded bytes', ({ marker }) => {
  expect(() => peerImageDimensions({ bytes: spliceBeforeEnd({ inserted: marker }), mimeType: 'image/jpeg' })).toThrow();
});
it('validates scan component count instead of returning immediately on SOS', () => {
  const bytes = fixture({ name: 'baseline.jpg' });
  const at = bytes.findIndex((value, at) => value === 0xff && bytes[at + 1] === 0xda);
  bytes[at + 4] = 0;
  expect(() => peerImageDimensions({ bytes, mimeType: 'image/jpeg' })).toThrow();
});
it('validates frame component table length', () => {
  const bytes = fixture({ name: 'baseline.jpg' });
  const at = bytes.findIndex((value, at) => value === 0xff && bytes[at + 1] === 0xc0);
  bytes[at + 9] = 4;
  expect(() => peerImageDimensions({ bytes, mimeType: 'image/jpeg' })).toThrow();
});
it('allows stuffed bytes and restart markers within the scan', () => {
  expect(peerImageDimensions({ bytes: spliceBeforeEnd({ inserted: [0xff, 0, 1, 0xff, 0xd0, 2, 0xff, 0xff, 0xd1] }), mimeType: 'image/jpeg' })).toEqual({ width: 32, height: 24 });
});
it('rejects truncated input in every generated fixture', () => {
  for (const name of ['baseline.jpg', 'progressive.jpg', 'grayscale.jpg', 'rgb.png', 'lossless.webp', 'lossy.webp']) {
    const bytes = fixture({ name });
    const mimeType = name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.png') ? 'image/png' : 'image/webp';
    for (const length of [0, 1, 8, 20, bytes.length - 1]) {
      expect(() => peerImageDimensions({ bytes: bytes.subarray(0, length), mimeType })).toThrow();
    }
  }
});
