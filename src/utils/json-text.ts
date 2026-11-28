import * as dtozod from '@/utils/dtozod';
import { parseJsonValue } from '@/utils/zod/parse-json-value';

/** Checks depth and duplicate keys before validating the JSON value. */
export function parseJsonText({ text, maxDepth, depthErrorMessage }: {
  text: string, maxDepth: number, depthErrorMessage: string,
}) {
  const value: unknown = JSON.parse(text);
  let index = 0;
  function space(): void {
    while (/\s/.test(text[index] ?? '') && index < text.length) {
      index++;
    }
  }
  function string(): string {
    const start = index++;
    while (index < text.length) {
      const c = text[index++];
      if (c === '\\') {
        index++;
        continue;
      }
      if (c === '"') {
        return dtozod.string().parse(JSON.parse(text.slice(start, index)));
      }
    }
    throw new Error('Unterminated JSON string.');
  }
  function visit({ depth }: { depth: number }): void {
    if (depth > maxDepth) {
      throw new Error(depthErrorMessage);
    }
    space();
    const c = text[index];
    if (c === '"') {
      string();
      return;
    }
    if (c === '{') {
      index++;
      space();
      const keys = new Set<string>();
      while (text[index] !== '}') {
        space();
        const key = string();
        if (keys.has(key)) {
          throw new Error(`Duplicate JSON key: ${key}`);
        }
        keys.add(key);
        space();
        index++;
        visit({ depth: depth + 1 });
        space();
        if (text[index] === ',') {
          index++;
        } else {
          break;
        }
      }
      index++;
      return;
    }
    if (c === '[') {
      index++;
      space();
      while (text[index] !== ']') {
        visit({ depth: depth + 1 });
        space();
        if (text[index] === ',') {
          index++;
        } else {
          break;
        }
      }
      index++;
      return;
    }
    while (index < text.length && !/[\s,}\]]/.test(text[index] ?? '')) {
      index++;
    }
  }
  visit({ depth: 0 });
  return parseJsonValue({ value });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
