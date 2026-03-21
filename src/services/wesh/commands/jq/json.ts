import type { JsonValue } from './ast';

function isWhitespace({
  char,
}: {
  char: string;
}): boolean {
  return /\s/.test(char);
}

function scanStringEnd({
  text,
  start,
}: {
  text: string;
  start: number;
}): number | undefined {
  let index = start + 1;
  let escaped = false;

  while (index < text.length) {
    const char = text[index];
    if (char === undefined) break;
    if (!escaped && char === '"') return index + 1;
    if (!escaped && char === '\\') {
      escaped = true;
      index += 1;
      continue;
    }
    escaped = false;
    index += 1;
  }

  return undefined;
}

function scanStructuredEnd({
  text,
  start,
}: {
  text: string;
  start: number;
}): number | undefined {
  const stack: string[] = [text[start]!];
  let index = start + 1;
  let inString = false;
  let escaped = false;

  while (index < text.length) {
    const char = text[index];
    if (char === undefined) break;

    if (inString) {
      if (!escaped && char === '"') {
        inString = false;
        index += 1;
        continue;
      }
      if (!escaped && char === '\\') {
        escaped = true;
        index += 1;
        continue;
      }
      escaped = false;
      index += 1;
      continue;
    }

    switch (char) {
    case '"':
      inString = true;
      index += 1;
      continue;
    case '{':
    case '[':
      stack.push(char);
      index += 1;
      continue;
    case '}':
      if (stack[stack.length - 1] !== '{') return undefined;
      stack.pop();
      index += 1;
      if (stack.length === 0) return index;
      continue;
    case ']':
      if (stack[stack.length - 1] !== '[') return undefined;
      stack.pop();
      index += 1;
      if (stack.length === 0) return index;
      continue;
    default:
      index += 1;
      continue;
    }
  }

  return undefined;
}

function scanPrimitiveEnd({
  text,
  start,
}: {
  text: string;
  start: number;
}): number {
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === undefined || isWhitespace({ char }) || char === ',' || char === ']' || char === '}') {
      break;
    }
    index += 1;
  }
  return index;
}

export function parseJsonSequence({
  text,
}: {
  text: string;
}): { ok: true; values: JsonValue[] } | { ok: false; message: string } {
  const values: JsonValue[] = [];
  let index = 0;

  while (index < text.length) {
    while (index < text.length) {
      const char = text[index];
      if (char === undefined || !isWhitespace({ char })) break;
      index += 1;
    }
    if (index >= text.length) break;

    const char = text[index];
    if (char === undefined) break;

    let end: number | undefined;
    switch (char) {
    case '"':
      end = scanStringEnd({ text, start: index });
      break;
    case '{':
    case '[':
      end = scanStructuredEnd({ text, start: index });
      break;
    default:
      end = scanPrimitiveEnd({ text, start: index });
      break;
    }

    if (end === undefined || end <= index) {
      return { ok: false, message: `invalid JSON input near byte ${index}` };
    }

    const slice = text.slice(index, end);
    try {
      values.push(JSON.parse(slice) as JsonValue);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, message: `invalid JSON input near byte ${index}: ${message}` };
    }

    index = end;
  }

  return { ok: true, values };
}

export function formatJsonOutput({
  value,
}: {
  value: JsonValue;
}): string {
  return `${JSON.stringify(value)}\n`;
}
