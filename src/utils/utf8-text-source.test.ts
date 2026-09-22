// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUtf8TextSource, utf8ByteLength, TEST_ONLY } from './utf8-text-source';

const blockUnits = TEST_ONLY.TEXT_BLOCK_CODE_UNITS;
const encode = (text: string) => new TextEncoder().encode(text);
afterEach(() => vi.restoreAllMocks());

describe('UTF-8 text source content', () => {
  it.each([
    '', 'ascii\0end', '日本語', '😀𝄞', '\uFEFFa\uFEFF', '\ud800', '\udfff', '\ud800x\udc00',
    '\ud800\ud800\udc00\udc00', '\u007f\u0080\u07ff\u0800\uffff', '\udbff\udfff',
  ])('matches TextEncoder at all small byte offsets: %j', text => {
    const bytes = encode(text);
    const source = createUtf8TextSource({ text });
    expect(utf8ByteLength({ text })).toBe(bytes.length);
    for (let start = 0; start <= bytes.length + 2; start++) {
      for (const length of [0, 1, 2, 3, 4, 7]) {
        const buffer = new Uint8Array(length + 4).fill(0xaa);
        const count = source.read({ buffer: buffer.subarray(2, 2 + length), position: start });
        const expected = bytes.subarray(start, start + length);
        expect(count).toBe(expected.length);
        expect(buffer.subarray(2, 2 + count)).toEqual(expected);
        expect(buffer.subarray(0, 2)).toEqual(new Uint8Array([0xaa, 0xaa]));
        expect(buffer.subarray(2 + count).every(byte => byte === 0xaa)).toBe(true);
      }
    }
    expect(source.getByteLength()).toBe(bytes.length);
  });

  it.each(['😀', '\ud800\ud800\udc00\udc00', '\udbff\udfff', '\ud800x\udc00'])('preserves surrogate sequences across every block boundary: %j', sequence => {
    for (const adjustment of [-2, -1, 0, 1]) {
      const text = `${'a'.repeat(blockUnits + adjustment)}${sequence}${'日'.repeat(blockUnits)}end`;
      const expected = encode(text);
      const source = createUtf8TextSource({ text });
      expect(source.getByteLength()).toBe(expected.length);
      const whole = new Uint8Array(expected.length + 2).fill(0xaa);
      expect(source.read({ buffer: whole, position: 0 })).toBe(expected.length);
      expect(whole.subarray(0, expected.length).every((byte, index) => byte === expected[index])).toBe(true);
      expect(whole.subarray(expected.length)).toEqual(new Uint8Array([0xaa, 0xaa]));
      for (let start = blockUnits - 4; start < blockUnits + 16; start++) {
        const buffer = new Uint8Array(9);
        expect(source.read({ buffer, position: start })).toBe(buffer.length);
        expect(buffer).toEqual(expected.subarray(start, start + buffer.length));
      }
    }
  });

  it('matches all UTF-16 code units and seeded random surrogate mixtures', () => {
    const corpus = Array.from({ length: 65536 }, (_, codeUnit) => String.fromCharCode(codeUnit)).join('');
    const expected = encode(corpus);
    const source = createUtf8TextSource({ text: corpus });
    expect(source.getByteLength()).toBe(expected.length);
    expect(utf8ByteLength({ text: corpus })).toBe(expected.length);
    const actual = new Uint8Array(expected.length);
    expect(source.read({ buffer: actual, position: 0 })).toBe(actual.length);
    expect(actual.every((byte, index) => byte === expected[index])).toBe(true);
    let state = 0x17c0ffee;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state;
    };
    for (let run = 0; run < 120; run++) {
      const text = Array.from({ length: next() % 257 }, () => {
        const value = next();
        return String.fromCharCode((value & 3) === 0 ? 0xd800 + (value % 0x800) : value % 0x10000);
      }).join('');
      const reference = encode(text);
      const input = createUtf8TextSource({ text });
      expect(utf8ByteLength({ text })).toBe(reference.length);
      for (let seek = 0; seek < 20; seek++) {
        const position = next() % (reference.length + 9);
        const buffer = new Uint8Array(next() % 41).fill(0xaa);
        const bytesRead = input.read({ buffer, position });
        expect(buffer.subarray(0, bytesRead)).toEqual(reference.subarray(position, position + buffer.length));
        expect(buffer.subarray(bytesRead).every(byte => byte === 0xaa)).toBe(true);
      }
      expect(input.getByteLength()).toBe(reference.length);
    }
  });
});

describe('UTF-8 text source allocation and range ownership', () => {
  it('does not encode on creation, empty reads, byte-length queries or EOF seeks', () => {
    const text = '日'.repeat(5 * blockUnits);
    const spy = vi.spyOn(TextEncoder.prototype, 'encode');
    const source = createUtf8TextSource({ text });
    expect(spy).not.toHaveBeenCalled();
    expect(source.read({ buffer: new Uint8Array(0), position: 0 })).toBe(0);
    expect(utf8ByteLength({ text })).toBe(text.length * 3);
    expect(source.getByteLength()).toBe(text.length * 3);
    expect(source.read({ buffer: new Uint8Array(5), position: Number.MAX_SAFE_INTEGER })).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('encodes only a bounded prefix for a small read of a much larger string', () => {
    const text = '日'.repeat(8 * 1024 * 1024);
    const spy = vi.spyOn(TextEncoder.prototype, 'encode');
    const source = createUtf8TextSource({ text });
    const buffer = new Uint8Array(7);
    expect(source.read({ buffer, position: 0 })).toBe(7);
    expect(buffer).toEqual(new Uint8Array([230, 151, 165, 230, 151, 165, 230]));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toHaveLength(blockUnits);
    expect(spy.mock.results[0]!.value.byteLength).toBe(3 * blockUnits);
  });

  it('indexes a distant seek without encoding the preceding blocks', () => {
    const text = `${'a'.repeat(20 * blockUnits)}😀end`;
    const spy = vi.spyOn(TextEncoder.prototype, 'encode');
    const source = createUtf8TextSource({ text });
    const buffer = new Uint8Array(5);
    expect(source.read({ buffer, position: 20 * blockUnits + 1 })).toBe(5);
    expect(buffer).toEqual(new Uint8Array([159, 152, 128, 101, 110]));
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]![0]).toBe('😀end');
  });

  it('reuses just the hot encoded block and never exposes it to caller mutation', () => {
    const source = createUtf8TextSource({ text: `${'a'.repeat(blockUnits)}${'b'.repeat(blockUnits)}c` });
    const spy = vi.spyOn(TextEncoder.prototype, 'encode');
    const buffer = new Uint8Array(4);
    source.read({ buffer, position: 0 }); buffer.fill(0);
    source.read({ buffer, position: 1 });
    expect(buffer).toEqual(new Uint8Array([97, 97, 97, 97]));
    expect(spy).toHaveBeenCalledOnce();
    source.read({ buffer, position: blockUnits });
    expect(spy).toHaveBeenCalledTimes(2);
    source.read({ buffer, position: 0 });
    expect(buffer).toEqual(new Uint8Array([97, 97, 97, 97]));
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte position %s before encoding or modifying output', position => {
    const source = createUtf8TextSource({ text: 'input' });
    const spy = vi.spyOn(TextEncoder.prototype, 'encode');
    const buffer = new Uint8Array(2).fill(0xaa);
    expect(() => source.read({ buffer, position })).toThrow(RangeError);
    expect(spy).not.toHaveBeenCalled();
    expect(buffer).toEqual(new Uint8Array([0xaa, 0xaa]));
  });

  it('rejects a non-string rather than silently stringifying it', () => {
    for (const value of [undefined, null, 123, {}, ['a']]) {
      const text = value as unknown as string;
      expect(() => createUtf8TextSource({ text })).toThrow(TypeError);
      expect(() => utf8ByteLength({ text })).toThrow(TypeError);
    }
  });
});
