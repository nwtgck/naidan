const POSIX_CHARACTER_CLASSES: Readonly<Record<string, string>> = {
  alnum: 'A-Za-z0-9',
  alpha: 'A-Za-z',
  blank: ' \\t',
  cntrl: '\\x00-\\x1F\\x7F',
  digit: '0-9',
  graph: '!-~',
  lower: 'a-z',
  print: ' -~',
  punct: `!"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_\`{|}~`,
  space: ' \\t\\r\\n\\v\\f',
  upper: 'A-Z',
  xdigit: '0-9A-Fa-f',
};

const UTF8_ENCODER = new TextEncoder();
const BYTE_DOMAIN_CHUNK_SIZE = 8 * 1024;

export const GIT_REGEX_DUPLICATION_MAX = 32767;

export function gitPosixCharacterClassSource({ name }: { name: string }): string | undefined {
  return POSIX_CHARACTER_CLASSES[name];
}

export function encodeGitRegexBytes({ bytes }: { bytes: Uint8Array }): string {
  if (bytes.length <= BYTE_DOMAIN_CHUNK_SIZE) {
    let result = '';
    for (const byte of bytes)
      result += String.fromCharCode(byte);
    return result;
  }

  let result = '';
  for (let offset = 0; offset < bytes.length; offset += BYTE_DOMAIN_CHUNK_SIZE) {
    const end = Math.min(offset + BYTE_DOMAIN_CHUNK_SIZE, bytes.length);
    result += String.fromCharCode(...bytes.subarray(offset, end));
  }
  return result;
}

export function encodeGitRegexByteDomain({ value }: { value: string }): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > 0x7F)
      return encodeGitRegexBytes({ bytes: UTF8_ENCODER.encode(value) });
  }
  return value;
}

function byteHexEscape({ character }: { character: string }): string {
  return `\\x${character.charCodeAt(0).toString(16).padStart(2, '0')}`;
}

export function escapeGitRegexLiteral({ character }: { character: string }): string {
  const code = character.charCodeAt(0);
  if (code < 0x20 || code >= 0x7F)
    return byteHexEscape({ character });
  return /[\\^$.*+?()[\]{}|]/u.test(character) ? `\\${character}` : character;
}

export function compileGitPosixBracketExpression({ pattern, start }: {
  pattern: string,
  start: number,
}): { source: string, nextIndex: number } {
  let index = start + 1;
  let source = '[';
  if (pattern[index] === '^') {
    source += '^';
    index += 1;
  }
  if (pattern[index] === ']') {
    source += byteHexEscape({ character: ']' });
    index += 1;
  }

  while (index < pattern.length) {
    const character = pattern[index]!;
    if (character === ']') return { source: `${source}]`, nextIndex: index + 1 };
    if (character === '[' && pattern[index + 1] === ':') {
      const end = pattern.indexOf(':]', index + 2);
      if (end < 0) throw new Error('unterminated POSIX character class');
      const name = pattern.slice(index + 2, end);
      const translated = gitPosixCharacterClassSource({ name });
      if (translated === undefined) throw new Error(`unsupported POSIX character class: ${name}`);
      source += translated;
      index = end + 2;
      continue;
    }
    if (character === '[' && (pattern[index + 1] === '.' || pattern[index + 1] === '=')) {
      const marker = pattern[index + 1]!;
      const end = pattern.indexOf(`${marker}]`, index + 2);
      if (end < 0) throw new Error('unterminated POSIX collating or equivalence class');
      const value = pattern.slice(index + 2, end);
      if (value.length !== 1)
        throw new Error('multi-byte POSIX collating and equivalence classes are not supported');
      source += byteHexEscape({ character: value });
      index = end + 2;
      continue;
    }
    if (character === '-') {
      source += '-';
      index += 1;
      continue;
    }
    source += byteHexEscape({ character });
    index += 1;
  }
  throw new Error('unterminated bracket expression');
}

export const TEST_ONLY = {
};
