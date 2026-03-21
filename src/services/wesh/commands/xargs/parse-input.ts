function finalizeToken({
  tokens,
  current,
  tokenStarted,
}: {
  tokens: string[];
  current: string;
  tokenStarted: boolean;
}): { current: string; tokenStarted: boolean } {
  if (tokenStarted) {
    tokens.push(current);
  }

  return {
    current: '',
    tokenStarted: false,
  };
}

export function parseXargsStandardInput({
  text,
}: {
  text: string;
}): { ok: true; items: string[] } | { ok: false; message: string } {
  const items: string[] = [];
  let current = '';
  let tokenStarted = false;
  let quote: '"' | '\'' | undefined;
  let escaping = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) break;

    if (escaping) {
      current += char;
      tokenStarted = true;
      escaping = false;
      continue;
    }

    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else if (char === '\\' && quote === '"') {
        escaping = true;
      } else {
        current += char;
        tokenStarted = true;
      }
      continue;
    }

    switch (char) {
    case '\\':
      escaping = true;
      tokenStarted = true;
      break;
    case '"':
    case '\'':
      quote = char;
      tokenStarted = true;
      break;
    case ' ':
    case '\t':
    case '\n':
    case '\r': {
      const result = finalizeToken({
        tokens: items,
        current,
        tokenStarted,
      });
      current = result.current;
      tokenStarted = result.tokenStarted;
      break;
    }
    default:
      current += char;
      tokenStarted = true;
      break;
    }
  }

  if (escaping) {
    return { ok: false, message: 'xargs: unmatched backslash in input' };
  }

  if (quote !== undefined) {
    return { ok: false, message: 'xargs: unmatched quote in input' };
  }

  const result = finalizeToken({
    tokens: items,
    current,
    tokenStarted,
  });
  void result;
  return { ok: true, items };
}

export function parseXargsNullDelimitedInput({
  text,
}: {
  text: string;
}): { ok: true; items: string[] } {
  const items = text.split('\0');
  if (text.endsWith('\0')) {
    items.pop();
  }
  return {
    ok: true,
    items,
  };
}

function parseEscapedChar({
  char,
}: {
  char: string;
}): string {
  switch (char) {
  case 'n':
    return '\n';
  case 'r':
    return '\r';
  case 't':
    return '\t';
  case '0':
    return '\0';
  case '\\':
    return '\\';
  default:
    return char;
  }
}

function parseNumericEscape({
  value,
  base,
}: {
  value: string;
  base: 8 | 16;
}): { ok: true; delimiter: string } | { ok: false; message: string } {
  const parsed = Number.parseInt(value, base);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return { ok: false, message: `invalid delimiter value '\\${base === 8 ? value : `x${value}`}'` };
  }
  return { ok: true, delimiter: String.fromCodePoint(parsed) };
}

export function parseXargsDelimiter({
  value,
}: {
  value: string;
}): { ok: true; delimiter: string } | { ok: false; message: string } {
  if (value.length === 0) {
    return { ok: false, message: "invalid delimiter value ''" };
  }

  if (value[0] === '\\') {
    if (value.length === 2) {
      const escapedChar = value[1];
      if (escapedChar === undefined) {
        return { ok: false, message: `invalid delimiter value '${value}'` };
      }
      return { ok: true, delimiter: parseEscapedChar({ char: escapedChar }) };
    }

    if (/^\\x[0-9A-Fa-f]{1,2}$/.test(value)) {
      return parseNumericEscape({
        value: value.slice(2),
        base: 16,
      });
    }

    if (/^\\[0-7]{1,3}$/.test(value)) {
      return parseNumericEscape({
        value: value.slice(1),
        base: 8,
      });
    }

    return { ok: false, message: `invalid delimiter value '${value}'` };
  }

  if (value.length !== 1) {
    return { ok: false, message: `invalid delimiter value '${value}'` };
  }

  return { ok: true, delimiter: value };
}

export function parseXargsDelimitedInput({
  text,
  delimiter,
}: {
  text: string;
  delimiter: string;
}): { ok: true; items: string[] } {
  const items = text.split(delimiter);
  if (text.endsWith(delimiter)) {
    items.pop();
  }
  return {
    ok: true,
    items,
  };
}

export function parseXargsLineInput({
  text,
}: {
  text: string;
}): { ok: true; lines: string[][] } | { ok: false; message: string } {
  const lines: string[][] = [];
  const rawLines = text.split('\n');
  let continuedLine = '';

  for (const rawLine of rawLines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const mergedLine = `${continuedLine}${line}`;
    const hasContinuation = /[ \t]+$/.test(mergedLine);
    const normalizedLine = hasContinuation ? mergedLine.replace(/[ \t]+$/, '') : mergedLine;

    if (hasContinuation) {
      continuedLine = `${normalizedLine} `;
      continue;
    }

    continuedLine = '';
    if (normalizedLine.trim().length === 0) continue;

    const parsed = parseXargsStandardInput({ text: normalizedLine });
    if (!parsed.ok) return parsed;
    if (parsed.items.length === 0) continue;
    lines.push(parsed.items);
  }

  if (continuedLine.length > 0) {
    const parsed = parseXargsStandardInput({ text: continuedLine });
    if (!parsed.ok) return parsed;
    if (parsed.items.length > 0) {
      lines.push(parsed.items);
    }
  }

  return { ok: true, lines };
}

export function parseXargsInsertInput({
  text,
}: {
  text: string;
}): { ok: true; items: string[] } | { ok: false; message: string } {
  const lines = text.split('\n');
  const items: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const normalized = line.replace(/^[ \t]+/, '');
    if (normalized.length === 0) continue;
    let current = '';
    let quote: '"' | '\'' | undefined;
    let escaping = false;

    for (let index = 0; index < normalized.length; index += 1) {
      const char = normalized[index];
      if (char === undefined) break;

      if (escaping) {
        current += char;
        escaping = false;
        continue;
      }

      if (quote !== undefined) {
        if (char === quote) {
          quote = undefined;
        } else if (char === '\\' && quote === '"') {
          escaping = true;
        } else {
          current += char;
        }
        continue;
      }

      switch (char) {
      case '\\':
        escaping = true;
        break;
      case '"':
      case '\'':
        quote = char;
        break;
      default:
        current += char;
        break;
      }
    }

    if (escaping) {
      return { ok: false, message: 'xargs: unmatched backslash in input' };
    }

    if (quote !== undefined) {
      return { ok: false, message: 'xargs: unmatched quote in input' };
    }

    items.push(current);
  }

  return { ok: true, items };
}
