import type { JqStringTokenPart, JqToken } from './ast';

function isIdentifierStart({
  char,
}: {
  char: string,
}): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart({
  char,
}: {
  char: string,
}): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function appendTextPart({
  parts,
  value,
}: {
  parts: JqStringTokenPart[],
  value: string,
}): void {
  if (value.length === 0) return;
  const previous = parts.at(-1);
  if (previous !== undefined) {
    switch (previous.kind) {
    case 'text':
      previous.value += value;
      return;
    case 'interpolation':
      break;
    default: {
      const _ex: never = previous;
      throw new Error(`Unhandled jq string token part: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
  }
  parts.push({ kind: 'text', value });
}

function decodeUnicodeEscape({
  source,
  index,
}: {
  source: string,
  index: number,
}): { ok: true, value: string, nextIndex: number } | { ok: false, message: string } {
  const digits = source.slice(index, index + 4);
  if (!/^[0-9a-fA-F]{4}$/.test(digits)) {
    return { ok: false, message: 'invalid unicode escape' };
  }

  const first = Number.parseInt(digits, 16);
  const nextIndex = index + 4;
  if (first >= 0xd800 && first <= 0xdbff && source.slice(nextIndex, nextIndex + 2) === '\\u') {
    const lowDigits = source.slice(nextIndex + 2, nextIndex + 6);
    if (/^[0-9a-fA-F]{4}$/.test(lowDigits)) {
      const low = Number.parseInt(lowDigits, 16);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const codePoint = 0x10000 + ((first - 0xd800) << 10) + (low - 0xdc00);
        return {
          ok: true,
          value: String.fromCodePoint(codePoint),
          nextIndex: nextIndex + 6,
        };
      }
    }
  }

  return {
    ok: true,
    value: String.fromCharCode(first),
    nextIndex,
  };
}

function decodeSimpleEscape({
  char,
}: {
  char: string,
}): string | undefined {
  switch (char) {
  case '"':
    return '"';
  case '\\':
    return '\\';
  case '/':
    return '/';
  case 'b':
    return '\b';
  case 'f':
    return '\f';
  case 'n':
    return '\n';
  case 'r':
    return '\r';
  case 't':
    return '\t';
  default:
    return undefined;
  }
}

function scanInterpolation({
  source,
  start,
}: {
  source: string,
  start: number,
}): { ok: true, body: string, nextIndex: number } | { ok: false, message: string } {
  let index = start;
  let depth = 1;
  let inString = false;
  let escaped = false;

  while (index < source.length) {
    const char = source[index];
    if (char === undefined) break;

    if (inString) {
      if (!escaped && char === '"') {
        inString = false;
      } else if (!escaped && char === '\\') {
        escaped = true;
        index += 1;
        continue;
      }
      escaped = false;
      index += 1;
      continue;
    }

    if (char === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '(') {
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return {
          ok: true,
          body: source.slice(start, index),
          nextIndex: index + 1,
        };
      }
      index += 1;
      continue;
    }
    index += 1;
  }

  return { ok: false, message: 'unterminated string interpolation' };
}

function scanString({
  source,
  start,
}: {
  source: string,
  start: number,
}): { ok: true, parts: JqStringTokenPart[], nextIndex: number } | { ok: false, message: string } {
  const parts: JqStringTokenPart[] = [];
  let text = '';
  let index = start + 1;

  while (index < source.length) {
    const char = source[index];
    if (char === undefined) break;

    if (char === '"') {
      appendTextPart({ parts, value: text });
      return { ok: true, parts, nextIndex: index + 1 };
    }

    if (char !== '\\') {
      text += char;
      index += 1;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === undefined) {
      return { ok: false, message: 'unterminated string literal' };
    }

    if (escaped === '(') {
      appendTextPart({ parts, value: text });
      text = '';
      const interpolation = scanInterpolation({ source, start: index + 2 });
      if (!interpolation.ok) return interpolation;
      parts.push({ kind: 'interpolation', source: interpolation.body });
      index = interpolation.nextIndex;
      continue;
    }

    if (escaped === 'u') {
      const unicode = decodeUnicodeEscape({ source, index: index + 2 });
      if (!unicode.ok) return unicode;
      text += unicode.value;
      index = unicode.nextIndex;
      continue;
    }

    const decoded = decodeSimpleEscape({ char: escaped });
    if (decoded === undefined) {
      return { ok: false, message: `invalid escape sequence '\\${escaped}'` };
    }
    text += decoded;
    index += 2;
  }

  return { ok: false, message: 'unterminated string literal' };
}

export function lexJq({
  source,
}: {
  source: string,
}): { ok: true, tokens: JqToken[] } | { ok: false, message: string } {
  const tokens: JqToken[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (char === undefined) break;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }

    const threeCharacter = source.slice(index, index + 3);
    if (threeCharacter === '//=') {
      tokens.push({ kind: 'operator', value: '//=' });
      index += 3;
      continue;
    }

    const twoCharacter = source.slice(index, index + 2);
    switch (twoCharacter) {
    case '..':
      tokens.push({ kind: 'recursive_descent' });
      index += 2;
      continue;
    case '==':
    case '!=':
    case '<=':
    case '>=':
    case '|=':
    case '//':
    case '+=':
    case '-=':
    case '*=':
    case '/=':
    case '%=':
      tokens.push({ kind: 'operator', value: twoCharacter });
      index += 2;
      continue;
    default:
      break;
    }

    if (char === '-') {
      const numberMatch = source.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (numberMatch?.[0] !== undefined && numberMatch[0] !== '-') {
        tokens.push({ kind: 'number', value: Number(numberMatch[0]) });
        index += numberMatch[0].length;
        continue;
      }
    }

    switch (char) {
    case '.':
      tokens.push({ kind: 'dot' });
      index += 1;
      continue;
    case '|':
    case ',':
    case '<':
    case '>':
    case '=':
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
    case ':':
    case '?':
      tokens.push({ kind: 'operator', value: char });
      index += 1;
      continue;
    case '$': {
      const next = source[index + 1];
      if (next === undefined || !isIdentifierStart({ char: next })) {
        return { ok: false, message: "expected variable name after '$'" };
      }
      let value = next;
      index += 2;
      while (index < source.length) {
        const current = source[index];
        if (current === undefined || !isIdentifierPart({ char: current })) break;
        value += current;
        index += 1;
      }
      tokens.push({ kind: 'variable', value });
      continue;
    }
    case '[':
    case ']':
    case '{':
    case '}':
    case '(':
    case ')':
    case ';':
      tokens.push({ kind: 'punctuation', value: char });
      index += 1;
      continue;
    case '"': {
      const string = scanString({ source, start: index });
      if (!string.ok) return string;
      tokens.push({ kind: 'string', parts: string.parts });
      index = string.nextIndex;
      continue;
    }
    default:
      break;
    }

    if (/\d/.test(char)) {
      const match = source.slice(index).match(/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (match?.[0] === undefined) {
        return { ok: false, message: `invalid number near '${source.slice(index)}'` };
      }
      tokens.push({ kind: 'number', value: Number(match[0]) });
      index += match[0].length;
      continue;
    }

    if (isIdentifierStart({ char })) {
      let value = char;
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === undefined || !isIdentifierPart({ char: current })) break;
        value += current;
        index += 1;
      }

      switch (value) {
      case 'true':
      case 'false':
      case 'null':
      case 'and':
      case 'or':
      case 'not':
      case 'if':
      case 'then':
      case 'elif':
      case 'else':
      case 'end':
      case 'try':
      case 'catch':
      case 'as':
        tokens.push({ kind: 'keyword', value });
        break;
      default:
        tokens.push({ kind: 'identifier', value });
        break;
      }
      continue;
    }

    return { ok: false, message: `unexpected character '${char}'` };
  }

  tokens.push({ kind: 'eof' });
  return { ok: true, tokens };
}
