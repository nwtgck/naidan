import type { JqToken } from './ast';

function isIdentifierStart({
  char,
}: {
  char: string;
}): boolean {
  return /[A-Za-z_]/.test(char);
}

function isIdentifierPart({
  char,
}: {
  char: string;
}): boolean {
  return /[A-Za-z0-9_]/.test(char);
}

function decodeEscape({
  char,
}: {
  char: string;
}): string {
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
    return char;
  }
}

export function lexJq({
  source,
}: {
  source: string;
}): { ok: true; tokens: JqToken[] } | { ok: false; message: string } {
  const tokens: JqToken[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (char === undefined) break;

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const twoCharacter = source.slice(index, index + 2);
    if (twoCharacter === '==') {
      tokens.push({ kind: 'operator', value: '==' });
      index += 2;
      continue;
    }
    if (twoCharacter === '!=') {
      tokens.push({ kind: 'operator', value: '!=' });
      index += 2;
      continue;
    }
    if (twoCharacter === '<=') {
      tokens.push({ kind: 'operator', value: '<=' });
      index += 2;
      continue;
    }
    if (twoCharacter === '>=') {
      tokens.push({ kind: 'operator', value: '>=' });
      index += 2;
      continue;
    }
    if (twoCharacter === '|=') {
      tokens.push({ kind: 'operator', value: '|=' });
      index += 2;
      continue;
    }
    if (twoCharacter === '//') {
      tokens.push({ kind: 'operator', value: '//' });
      index += 2;
      continue;
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
      tokens.push({ kind: 'punctuation', value: char });
      index += 1;
      continue;
    case '"': {
      index += 1;
      let value = '';
      let escaped = false;
      let terminated = false;

      while (index < source.length) {
        const current = source[index];
        if (current === undefined) break;

        if (!escaped && current === '"') {
          terminated = true;
          index += 1;
          break;
        }

        if (!escaped && current === '\\') {
          escaped = true;
          index += 1;
          continue;
        }

        value += escaped ? decodeEscape({ char: current }) : current;
        escaped = false;
        index += 1;
      }

      if (!terminated) {
        return { ok: false, message: 'unterminated string literal' };
      }

      tokens.push({ kind: 'string', value });
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
