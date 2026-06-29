import {
  parseXargsInsertInput,
  parseXargsStandardInput,
} from '@/features/wesh/commands/xargs/parse-input';

export class XargsInputError extends Error {}

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

export async function* iterateUtf8TextChunks({
  chunks,
}: {
  chunks: AsyncIterable<Uint8Array>,
}): AsyncIterable<string> {
  const decoder = new TextDecoder();
  for await (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (text.length > 0) {
      yield text;
    }
  }
  const finalText = decoder.decode();
  if (finalText.length > 0) {
    yield finalText;
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

  if (escaping) {
    throw new XargsInputError('xargs: unmatched backslash in input');
  }
  if (quote !== undefined) {
    throw new XargsInputError('xargs: unmatched quote in input');
  }

  const emitted = emitCurrent();
  if (!emitted.stopped && emitted.item !== undefined) {
    yield emitted.item;
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
  let endedWithDelimiter = false;

  for await (const text of textChunks) {
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

  if (!endedWithDelimiter) {
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
  for await (const line of lines) {
    const parsed = parseXargsInsertInput({ text: line });
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
}

export async function* iterateXargsLogicalLines({
  lines,
}: {
  lines: AsyncIterable<string>,
}): AsyncIterable<string[]> {
  let continuedParts: string[] = [];

  for await (const line of lines) {
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
    if (normalizedLine.trim().length === 0) {
      continue;
    }

    const parsed = parseXargsStandardInput({ text: normalizedLine });
    if (!parsed.ok) {
      throw new XargsInputError(parsed.message);
    }
    if (parsed.items.length > 0) {
      yield parsed.items;
    }
  }

  if (continuedParts.length > 0) {
    const parsed = parseXargsStandardInput({ text: continuedParts.join('') });
    if (!parsed.ok) {
      throw new XargsInputError(parsed.message);
    }
    if (parsed.items.length > 0) {
      yield parsed.items;
    }
  }
}
