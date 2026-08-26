import { describe, expect, it } from 'vitest';
import {
  CommandDataStreamDecoder,
  decodeCommandDataBytes,
  decodeCommandDataBytesAsSingleByte,
  encodeCommandDataText,
} from './data-codec';

describe('command data codec', () => {
  it('round-trips every byte value without replacement', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);

    expect(encodeCommandDataText({ text: decodeCommandDataBytes({ bytes }) })).toEqual(bytes);
  });

  it('round-trips valid Unicode including supplementary code points', () => {
    const text = `Aé😀${String.fromCodePoint(0x10080)}\uFEFF`;
    const bytes = new TextEncoder().encode(text);

    expect(decodeCommandDataBytes({ bytes })).toBe(text);
    expect(encodeCommandDataText({ text })).toEqual(bytes);
  });

  it('keeps malformed UTF-8 sequences byte-exact', () => {
    const bytes = Uint8Array.from([
      0xc0, 0x80,
      0xe0, 0x80, 0x80,
      0xed, 0xa0, 0x80,
      0xf4, 0x90, 0x80, 0x80,
      0xff,
    ]);

    expect(encodeCommandDataText({ text: decodeCommandDataBytes({ bytes }) })).toEqual(bytes);
  });

  it('decodes valid UTF-8 incrementally across every byte boundary', () => {
    const bytes = new TextEncoder().encode('Aé😀Z');
    const decoder = new CommandDataStreamDecoder();
    const fragments = Array.from(bytes, byte => decoder.write({ bytes: Uint8Array.of(byte) }));
    fragments.push(decoder.finish());

    expect(fragments.join('')).toBe('Aé😀Z');
  });

  it('retains incomplete and malformed suffix bytes until they are decidable', () => {
    const decoder = new CommandDataStreamDecoder();

    expect(decoder.write({ bytes: Uint8Array.of(0xe2) })).toBe('');
    expect(decoder.write({ bytes: Uint8Array.of(0x82) })).toBe('');
    const malformed = decoder.write({ bytes: Uint8Array.of(0x0a) });
    expect(encodeCommandDataText({ text: malformed })).toEqual(Uint8Array.of(0xe2, 0x82, 0x0a));
    expect(decoder.finish()).toBe('');
  });

  it('flushes incomplete final bytes exactly and resets after finish', () => {
    const decoder = new CommandDataStreamDecoder();

    expect(decoder.write({ bytes: Uint8Array.of(0xf0, 0x9f, 0x92) })).toBe('');
    expect(encodeCommandDataText({ text: decoder.finish() })).toEqual(Uint8Array.of(0xf0, 0x9f, 0x92));
    expect(decoder.write({ bytes: new TextEncoder().encode('ok') })).toBe('ok');
    expect(decoder.finish()).toBe('');
  });

  it('maps every byte to one code unit across chunk boundaries', () => {
    const bytes = Uint8Array.from({ length: 8_193 }, (_, index) => index & 0xff);
    const text = decodeCommandDataBytesAsSingleByte({ bytes });

    expect(text).toHaveLength(bytes.byteLength);
    expect(Array.from(text, (character) => character.charCodeAt(0))).toEqual([...bytes]);
  });
});
