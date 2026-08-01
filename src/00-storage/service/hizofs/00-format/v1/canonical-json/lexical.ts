import { decodeUtf8Strict } from '@/00-storage/service/hizofs/00-format/v1/encoding/utf8';

const DIGIT = /^[0-9]$/u;

class CanonicalJsonScanner {
  private index = 0;

  public constructor({ maximumDepth, text }: { maximumDepth: number; text: string }) {
    this.maximumDepth = maximumDepth;
    this.text = text;
  }

  private readonly maximumDepth: number;
  private readonly text: string;

  public scan(): void {
    this.parseValue({ depth: 1 });
    if (this.index !== this.text.length) throw new TypeError('canonical JSON has trailing bytes');
  }

  private current(): string | undefined {
    return this.text[this.index];
  }

  private consume({ expected }: { expected: string }): void {
    if (this.current() !== expected) throw new TypeError(`canonical JSON expected ${expected}`);
    this.index += 1;
  }

  private parseValue({ depth }: { depth: number }): void {
    const token = this.current();
    switch (token) {
    case '{':
      if (depth > this.maximumDepth) throw new RangeError('canonical JSON nesting depth exceeds the configured maximum');
      this.parseObject({ depth });
      return;
    case '[':
      if (depth > this.maximumDepth) throw new RangeError('canonical JSON nesting depth exceeds the configured maximum');
      this.parseArray({ depth });
      return;
    case '"':
      this.parseString();
      return;
    case undefined:
      throw new TypeError('canonical JSON contains an unsupported token');
    default:
      if (DIGIT.test(token)) {
        this.parseInteger();
        return;
      }
      throw new TypeError('canonical JSON contains an unsupported token');
    }
  }

  private parseObject({ depth }: { depth: number }): void {
    this.consume({ expected: '{' });
    const keys = new Set<string>();
    if (this.current() === '}') {
      this.index += 1;
      return;
    }
    for (;;) {
      const key = this.parseString();
      if (keys.has(key)) throw new TypeError(`canonical JSON contains duplicate object key: ${key}`);
      keys.add(key);
      this.consume({ expected: ':' });
      this.parseValue({ depth: depth + 1 });
      if (this.current() === '}') {
        this.index += 1;
        return;
      }
      this.consume({ expected: ',' });
    }
  }

  private parseArray({ depth }: { depth: number }): void {
    this.consume({ expected: '[' });
    if (this.current() === ']') {
      this.index += 1;
      return;
    }
    for (;;) {
      this.parseValue({ depth: depth + 1 });
      if (this.current() === ']') {
        this.index += 1;
        return;
      }
      this.consume({ expected: ',' });
    }
  }

  private parseString(): string {
    this.consume({ expected: '"' });
    const start = this.index;
    while (this.current() !== '"') {
      const character = this.current();
      if (character === undefined) throw new TypeError('canonical JSON string is unterminated');
      const code = character.charCodeAt(0);
      if (character === '\\' || code < 0x20 || code > 0x7e) {
        throw new TypeError('canonical JSON string must be unescaped printable ASCII');
      }
      this.index += 1;
    }
    const value = this.text.slice(start, this.index);
    this.index += 1;
    return value;
  }

  private parseInteger(): void {
    const start = this.index;
    if (this.current() === '0') {
      this.index += 1;
      if (this.current() !== undefined && DIGIT.test(this.current() ?? '')) {
        throw new TypeError('canonical JSON integer has a leading zero');
      }
      return;
    }
    while (this.current() !== undefined && DIGIT.test(this.current() ?? '')) this.index += 1;
    if (this.index === start) throw new TypeError('canonical JSON integer is invalid');
  }
}

export function decodeRestrictedCanonicalJson({
  bytes,
  maximumBytes,
  maximumDepth,
}: {
  bytes: Uint8Array;
  maximumBytes: number;
  maximumDepth: number;
}): unknown {
  if (bytes.byteLength > maximumBytes) throw new RangeError('canonical JSON exceeds the configured byte maximum');
  const textWithLf = decodeUtf8Strict({ bytes, label: 'canonical JSON' });
  if (!textWithLf.endsWith('\n') || textWithLf.endsWith('\n\n')) {
    throw new TypeError('canonical JSON must end in exactly one LF');
  }
  const text = textWithLf.slice(0, -1);
  new CanonicalJsonScanner({ maximumDepth, text }).scan();
  return JSON.parse(text) as unknown;
}

export function encodeCanonicalAsciiString({ value }: { value: string }): string {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code > 0x7e || character === '"' || character === '\\') {
      throw new TypeError('canonical JSON string must be unescaped printable ASCII');
    }
  }
  return `"${value}"`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
