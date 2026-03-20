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
  return {
    ok: true,
    items: text.split('\0').filter((item) => item.length > 0),
  };
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
