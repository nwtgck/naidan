import {
  isXargsLogicalBlankLine,
  parseXargsInsertInput,
  parseXargsStandardInput,
} from '@/features/wesh/commands/xargs/parse-input';
import { CommandDataStreamDecoder } from '@/features/wesh/commands/_shared/data-codec';

export class XargsInputError extends Error {}

function hasUnescapedTrailingBackslash({
  text,
}: {
  text: string,
}): boolean {
  let count = 0;
  for (let index = text.length - 1; index >= 0 && text[index] === '\\'; index -= 1) {
    count += 1;
  }
  return count % 2 === 1;
}

export async function* iterateReadableStreamChunks({
  stream,
}: {
  stream: ReadableStream<Uint8Array>,
}): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  let completed = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        completed = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!completed) {
      await reader.cancel();
    }
    reader.releaseLock();
  }
}

export async function* iterateCommandDataTextChunks({
  chunks,
}: {
  chunks: AsyncIterable<Uint8Array>,
}): AsyncIterable<string> {
  const decoder = new CommandDataStreamDecoder();
  for await (const chunk of chunks) {
    const text = decoder.write({ bytes: chunk });
    if (text.length > 0) {
      yield text;
    }
  }
  const finalText = decoder.finish();
  if (finalText.length > 0) {
    yield finalText;
  }
}

export type XargsIgnoredNulBoundary =
  | { readonly kind: 'whitespace' }
  | { readonly kind: 'line' }
  | { readonly kind: 'delimiter', readonly delimiter: string };

function isIgnoredNulBoundary({
  char,
  boundary,
}: {
  char: string,
  boundary: XargsIgnoredNulBoundary,
}): boolean {
  switch (boundary.kind) {
  case 'whitespace':
    return char === ' ' || char === '\t' || char === '\n' || char === '\r';
  case 'line':
    return char === '\n' || char === '\r';
  case 'delimiter':
    return char === boundary.delimiter;
  default: {
    const _exhaustive: never = boundary;
    return _exhaustive;
  }
  }
}

export async function* iterateXargsTextIgnoringNulSuffixes({
  textChunks,
  boundary,
  onIgnoredNul,
  preserveNul = false,
}: {
  textChunks: AsyncIterable<string>,
  boundary: XargsIgnoredNulBoundary,
  onIgnoredNul?: () => Promise<void>,
  preserveNul?: boolean,
}): AsyncIterable<string> {
  let discarding = false;

  for await (const text of textChunks) {
    const output: string[] = [];
    for (const char of text) {
      if (discarding) {
        if (isIgnoredNulBoundary({ char, boundary })) {
          output.push(char);
          discarding = false;
        }
        continue;
      }

      if (char === '\0') {
        if (preserveNul) {
          output.push(char);
        }
        discarding = true;
        await onIgnoredNul?.();
        continue;
      }

      output.push(char);
    }

    if (output.length > 0) {
      yield output.join('');
    }
  }
}

export async function* iterateXargsInputLines({
  textChunks,
}: {
  textChunks: AsyncIterable<string>,
}): AsyncIterable<string> {
  let fragments: string[] = [];
  let sawData = false;
  let endedWithLineFeed = false;
  for await (const text of textChunks) {
    if (text.length === 0) continue;
    sawData = true;
    let start = 0;
    while (true) {
      const separator = text.indexOf('\n', start);
      if (separator === -1) {
        fragments.push(text.slice(start));
        endedWithLineFeed = false;
        break;
      }
      fragments.push(text.slice(start, separator));
      yield fragments.join('');
      fragments = [];
      start = separator + 1;
      endedWithLineFeed = start === text.length;
      if (start === text.length) break;
    }
  }
  if (fragments.length > 0 || (sawData && !endedWithLineFeed)) {
    yield fragments.join('');
  }
}

function finalizeStandardItem({
  fragments,
  tokenStarted,
}: {
  fragments: string[],
  tokenStarted: boolean,
}): string | undefined {
  if (!tokenStarted) {
    return undefined;
  }
  return fragments.join('');
}

export async function* iterateXargsStandardItems({
  textChunks,
  eofString,
}: {
  textChunks: AsyncIterable<string>,
  eofString: string | undefined,
}): AsyncIterable<string> {
  let fragments: string[] = [];
  let tokenStarted = false;
  let quote: '"' | '\'' | undefined;
  let escaping = false;
  let sawItemOnCurrentLine = false;

  const emitCurrent = (): { item: string | undefined, stopped: boolean } => {
    const item = finalizeStandardItem({ fragments, tokenStarted });
    fragments = [];
    tokenStarted = false;
    if (item !== undefined && eofString !== undefined && item === eofString) {
      return { item: undefined, stopped: true };
    }
    return { item, stopped: false };
  };

  for await (const text of textChunks) {
    for (const char of text) {
      if (escaping) {
        fragments.push(char);
        tokenStarted = true;
        escaping = false;
        continue;
      }

      if (quote !== undefined) {
        if (char === quote) {
          quote = undefined;
        } else if (char === '\\' && quote === '"') {
          escaping = true;
        } else if (char === '\n' || char === '\r') {
          throw new XargsInputError('xargs: unmatched quote in input');
        } else {
          fragments.push(char);
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
        const emitted = emitCurrent();
        if (emitted.stopped) {
          return;
        }
        if (emitted.item !== undefined) {
          yield emitted.item;
          sawItemOnCurrentLine = true;
        }
        if (char === '\n' || char === '\r') {
          sawItemOnCurrentLine = false;
        }
        break;
      }
      default:
        fragments.push(char);
        tokenStarted = true;
        break;
      }
    }
  }

  if (quote !== undefined) {
    throw new XargsInputError('xargs: unmatched quote in input');
  }

  const finalItem = finalizeStandardItem({ fragments, tokenStarted });
  if (
    finalItem !== undefined
    && !(eofString !== undefined && finalItem === eofString && !sawItemOnCurrentLine)
  ) {
    yield finalItem;
  }
}

export async function* iterateXargsDelimitedItems({
  textChunks,
  delimiter,
}: {
  textChunks: AsyncIterable<string>,
  delimiter: string,
}): AsyncIterable<string> {
  const fragments: string[] = [];
  let sawData = false;
  let endedWithDelimiter = false;

  for await (const text of textChunks) {
    if (text.length > 0) {
      sawData = true;
    }
    for (const char of text) {
      if (char === delimiter) {
        yield fragments.join('');
        fragments.length = 0;
        endedWithDelimiter = true;
      } else {
        fragments.push(char);
        endedWithDelimiter = false;
      }
    }
  }

  if (sawData && !endedWithDelimiter) {
    yield fragments.join('');
  }
}

export async function* iterateXargsInsertItems({
  lines,
  eofString,
}: {
  lines: AsyncIterable<string>,
  eofString: string | undefined,
}): AsyncIterable<string> {
  let continued = '';
  for await (const line of lines) {
    if (hasUnescapedTrailingBackslash({ text: line })) {
      continued += `${line.slice(0, -1)}\n`;
      continue;
    }

    const parsed = parseXargsInsertInput({ text: `${continued}${line}` });
    continued = '';
    if (!parsed.ok) {
      throw new XargsInputError(parsed.message);
    }
    for (const item of parsed.items) {
      if (eofString !== undefined && item === eofString) {
        return;
      }
      yield item;
    }
  }

  if (continued.length > 0) {
    throw new XargsInputError('xargs: unmatched backslash in input');
  }
}

export async function* iterateXargsLogicalLines({
  lines,
}: {
  lines: AsyncIterable<string>,
}): AsyncIterable<string[]> {
  let continuedParts: string[] = [];

  for await (const line of lines) {
    if (hasUnescapedTrailingBackslash({ text: line })) {
      continuedParts.push(line.slice(0, -1), '\n');
      continue;
    }

    const mergedParts = [...continuedParts, line];
    const mergedLine = mergedParts.join('');
    const hasContinuation = /[ \t]+$/.test(mergedLine);
    const normalizedLine = hasContinuation
      ? mergedLine.replace(/[ \t]+$/, '')
      : mergedLine;

    if (hasContinuation) {
      continuedParts = [normalizedLine, ' '];
      continue;
    }

    continuedParts = [];
    if (isXargsLogicalBlankLine({ text: normalizedLine })) {
      continue;
    }

    const parsed = parseXargsStandardInput({
      text: normalizedLine,
      literalNewlines: true,
    });
    if (!parsed.ok) {
      throw new XargsInputError(parsed.message);
    }
    if (parsed.items.length > 0) {
      yield parsed.items;
    }
  }

  if (continuedParts.length > 0) {
    const parsed = parseXargsStandardInput({
      text: continuedParts.join(''),
      literalNewlines: true,
    });
    if (!parsed.ok) {
      throw new XargsInputError(parsed.message);
    }
    if (parsed.items.length > 0) {
      yield parsed.items;
    }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
