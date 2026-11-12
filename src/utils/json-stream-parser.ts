export type JsonParseResult =
  | { success: true, data: unknown, raw: string }
  | { success: false, error: string, raw: string };

/** Object streams are not JSON Lines: whitespace is optional and each object
 * may span multiple lines. Never search past garbage for a later opening brace.
 * All consumers must reject a batch containing a failed result before saving. */
export function parseConcatenatedJson({ input }: { input: string }): JsonParseResult[] {
  const results: JsonParseResult[] = [];
  if (input.length > 4 * 1024 * 1024) {
    return [{ success: false, error: 'JSON input exceeds the size limit', raw: input }];
  }
  let cursor = input.startsWith('\uFEFF') ? 1 : 0;
  const whitespace = (): void => {
    while (cursor < input.length && /[ \t\r\n]/.test(input[cursor]!)) {
      cursor++;
    }
  };
  const fail = ({ message }: { message: string }): never => {
    throw new Error(cursor >= input.length ? 'Unclosed JSON object' : `${message} at character ${cursor + 1}`);
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor < input.length) {
      const character = input[cursor++]!;
      if (character === '"') {
        const value: unknown = JSON.parse(input.slice(start, cursor));
        if (typeof value !== 'string') {
          return fail({ message: 'Invalid JSON string' });
        }
        return value;
      }
      if (character === '\\') {
        cursor++;
      }
    }
    return fail({ message: 'Unclosed JSON string' });
  };
  const value = ({ depth }: { depth: number }): void => {
    if (depth > 64) {
      throw new Error('JSON nesting exceeds the depth limit');
    }
    whitespace();
    const character = input[cursor];
    if (character === '{') {
      cursor++;
      whitespace();
      const keys = new Set<string>();
      if (input[cursor] === '}') {
        cursor++;
        return;
      }
      while (cursor < input.length) {
        if (input[cursor] !== '"') {
          return fail({ message: 'Expected an object key' });
        }
        const key = string();
        if (keys.has(key)) {
          return fail({ message: 'Duplicate object key' });
        }
        keys.add(key);
        whitespace();
        if (input[cursor++] !== ':') {
          return fail({ message: 'Expected a colon' });
        }
        value({ depth: depth + 1 });
        whitespace();
        if (input[cursor] === '}') {
          cursor++;
          return;
        }
        if (input[cursor++] !== ',') {
          return fail({ message: 'Expected a comma or closing brace' });
        }
        whitespace();
      }
      return fail({ message: 'Unclosed JSON object' });
    }
    if (character === '[') {
      cursor++;
      whitespace();
      if (input[cursor] === ']') {
        cursor++;
        return;
      }
      while (cursor < input.length) {
        value({ depth: depth + 1 });
        whitespace();
        if (input[cursor] === ']') {
          cursor++;
          return;
        }
        if (input[cursor++] !== ',') {
          return fail({ message: 'Expected a comma or closing bracket' });
        }
        whitespace();
      }
      return fail({ message: 'Unclosed JSON array' });
    }
    if (character === '"') {
      string();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (input.startsWith(literal, cursor)) {
        cursor += literal.length;
        return;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(input.slice(cursor));
    if (number) {
      cursor += number[0].length;
      return;
    }
    return fail({ message: 'Expected a JSON value' });
  };
  while (true) {
    whitespace();
    if (cursor === input.length) {
      return results;
    }
    const start = cursor;
    try {
      if (results.length >= 128) {
        throw new Error('Too many JSON objects');
      }
      if (input[cursor] !== '{') {
        throw new Error(`Expected a top-level JSON object at character ${cursor + 1}`);
      }
      value({ depth: 0 });
      const raw = input.slice(start, cursor);
      const data: unknown = JSON.parse(raw);
      results.push({ success: true, data, raw });
    } catch (error) {
      // Do not resume after a malformed value: braces in its strings need not be
      // object boundaries. Preserve the complete failed suffix for the editor.
      results.push({ success: false, error: error instanceof Error ? error.message : String(error), raw: input.slice(start) });
      return results;
    }
  }
}

export const TEST_ONLY = {
};
