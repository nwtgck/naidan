import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvPolicy, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { resolvePath } from '@/features/wesh/path';
import { openFileReadStream, openHandleReadStream, writeAllBytesToHandle } from '@/features/wesh/utils/fs';
import { iterateReadableStreamChunks } from '@/features/wesh/utils/stream';
import { iterateByteRecordEntries } from '@/features/wesh/utils/text-records';

const OUTPUT_BUFFER_SIZE = 16 * 1024;
const BACKSLASH_BYTE = 0x5c;
const NEWLINE_BYTE = 0x0a;
const TAB_BYTE = 0x09;
const NUL_BYTE = 0x00;

function parseDelimiterList({
  value,
}: {
  value: string,
}):
  | { ok: true, delimiters: readonly Uint8Array[] }
  | { ok: false, message: string } {
  const encoded = new TextEncoder().encode(value);
  const delimiters: Uint8Array[] = [];
  for (let index = 0; index < encoded.byteLength; index += 1) {
    const byte = encoded[index]!;
    if (byte !== BACKSLASH_BYTE) {
      delimiters.push(Uint8Array.of(byte));
      continue;
    }
    if (index + 1 >= encoded.byteLength) {
      return {
        ok: false,
        message: `paste: delimiter list ends with an unescaped backslash: ${value}`,
      };
    }

    const escaped = encoded[index + 1]!;
    index += 1;
    switch (escaped) {
    case 0x6e:
      delimiters.push(Uint8Array.of(NEWLINE_BYTE));
      break;
    case 0x74:
      delimiters.push(Uint8Array.of(TAB_BYTE));
      break;
    case BACKSLASH_BYTE:
      delimiters.push(Uint8Array.of(BACKSLASH_BYTE));
      break;
    case 0x30:
      delimiters.push(new Uint8Array(0));
      break;
    default:
      delimiters.push(Uint8Array.of(escaped));
      break;
    }
  }
  return { ok: true, delimiters };
}

function delimiterForIndex({
  delimiters,
  index,
}: {
  delimiters: readonly Uint8Array[],
  index: number,
}): Uint8Array {
  if (delimiters.length === 0) {
    return new Uint8Array(0);
  }
  return delimiters[index % delimiters.length] ?? new Uint8Array(0);
}

function createBufferedByteWriter({
  context,
}: {
  context: WeshCommandContext,
}): {
  readonly write: ({ chunks }: { chunks: readonly Uint8Array[] }) => Promise<void>,
  readonly flush: () => Promise<void>,
} {
  let bufferedChunks: Uint8Array[] = [];
  let bufferedLength = 0;

  const flush = async (): Promise<void> => {
    if (bufferedLength === 0) {
      return;
    }

    const combined = new Uint8Array(bufferedLength);
    let offset = 0;
    for (const chunk of bufferedChunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    bufferedChunks = [];
    bufferedLength = 0;
    await writeAllBytesToHandle({
      handle: context.stdout,
      data: combined,
    });
  };

  return {
    write: async ({ chunks }: { chunks: readonly Uint8Array[] }): Promise<void> => {
      for (const chunk of chunks) {
        if (chunk.byteLength === 0) {
          continue;
        }
        bufferedChunks.push(chunk);
        bufferedLength += chunk.byteLength;
      }
      if (bufferedLength >= OUTPUT_BUFFER_SIZE) {
        await flush();
      }
    },
    flush,
  };
}

const pasteDelimitersOption = {
  semantic: { kind: 'required-value', key: 'delimiters', parse: undefined },
  forms: [
    { kind: 'short', name: 'd', value: { kind: 'required-attached-or-following', missingValueName: 'list' } },
    { kind: 'long', name: 'delimiters', value: { kind: 'required', missingValueName: 'list' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const pasteSerialOption = {
  semantic: { kind: 'effects', effects: [{ key: 'serial', value: true }] },
  forms: [
    { kind: 'short', name: 's', value: { kind: 'none' } },
    { kind: 'long', name: 'serial', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const pasteZeroTerminatedOption = {
  semantic: { kind: 'effects', effects: [{ key: 'zeroTerminated', value: true }] },
  forms: [
    { kind: 'short', name: 'z', value: { kind: 'none' } },
    { kind: 'long', name: 'zero-terminated', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const pasteHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<never>>;
const pasteArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  nonExecutableLongOptions: ['version'],
  definitions: [pasteDelimitersOption, pasteSerialOption, pasteZeroTerminatedOption, pasteHelpOption],
});
const pasteArgvHelp = defineArgvHelpPresentation({
  catalog: pasteArgvCatalog,
  rows: [
    { forms: pasteDelimitersOption.forms, summary: 'reuse characters from LIST as output delimiters', valueName: 'LIST', category: 'common' },
    { forms: pasteSerialOption.forms, summary: 'paste one file at a time instead of in parallel', category: 'common' },
    { forms: pasteZeroTerminatedOption.forms, summary: 'line delimiter is NUL, not newline', category: 'common' },
    { forms: pasteHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});
const pasteArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

async function* emptyPasteRecords(): AsyncIterable<Uint8Array> {
  // A directory operand is diagnosed but remains an empty source so other
  // parallel inputs continue to produce their rows, matching GNU paste.
}

async function openPasteRecordIterator({
  context,
  path,
  zeroTerminated,
}: {
  context: WeshCommandContext,
  path: string,
  zeroTerminated: boolean,
}): Promise<AsyncIterator<Uint8Array>> {
  const stream = path === '-'
    ? openHandleReadStream({ handle: context.stdin })
    : await openFileReadStream({
      files: context.files,
      path: resolvePath({ cwd: context.cwd, path }),
    });
  const records = iterateByteRecordEntries({
    chunks: iterateReadableStreamChunks({ stream }),
    delimiterByte: zeroTerminated ? NUL_BYTE : NEWLINE_BYTE,
  });

  return (async function* (): AsyncIterable<Uint8Array> {
    for await (const record of records) {
      yield record.bytes;
    }
  })()[Symbol.asyncIterator]();
}

async function openPasteSource({
  context,
  path,
  zeroTerminated,
}: {
  context: WeshCommandContext,
  path: string,
  zeroTerminated: boolean,
}): Promise<
  | { kind: 'iterator', iterator: AsyncIterator<Uint8Array> }
  | { kind: 'directory' }
> {
  if (path !== '-') {
    const resolvedPath = resolvePath({ cwd: context.cwd, path });
    const entry = await context.files.lstat({ path: resolvedPath });
    switch (entry.type) {
    case 'directory':
      return { kind: 'directory' };
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      break;
    default: {
      const _ex: never = entry.type;
      throw new Error(`Unhandled paste input type: ${_ex}`);
    }
    }
  }

  return {
    kind: 'iterator',
    iterator: await openPasteRecordIterator({
      context,
      path,
      zeroTerminated,
    }),
  };
}

export const pasteCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'paste',
    description: 'Merge lines of files in parallel or serially',
    usage: 'paste [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: pasteArgvCatalog,
        policy: pasteArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: pasteArgvCatalog,
      policy: pasteArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'paste',
        message: `paste: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: pasteArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'paste',
        optionLines: formatArgvOptionHelp({ presentation: pasteArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const parsedDelimiters = parseDelimiterList({
      value: typeof parsed.optionValues.delimiters === 'string' ? parsed.optionValues.delimiters : '\t',
    });
    if (!parsedDelimiters.ok) {
      await context.text().error({ text: `${parsedDelimiters.message}\n` });
      return { exitCode: 1 };
    }
    const delimiters = parsedDelimiters.delimiters;
    const serial = parsed.optionValues.serial === true;
    const zeroTerminated = parsed.optionValues.zeroTerminated === true;
    const recordTerminator = Uint8Array.of(zeroTerminated ? NUL_BYTE : NEWLINE_BYTE);
    const files = parsed.positionals.length > 0 ? parsed.positionals : ['-'];
    const writer = createBufferedByteWriter({ context });
    const iterators = new Set<AsyncIterator<Uint8Array>>();
    let exitCode = 0;

    const getIterator = async ({
      file,
      stdinIterator,
    }: {
      file: string,
      stdinIterator: AsyncIterator<Uint8Array> | undefined,
    }): Promise<{
      iterator: AsyncIterator<Uint8Array>,
      stdinIterator: AsyncIterator<Uint8Array> | undefined,
    }> => {
      if (file === '-' && stdinIterator !== undefined) {
        return { iterator: stdinIterator, stdinIterator };
      }
      const source = await openPasteSource({
        context,
        path: file,
        zeroTerminated,
      });
      switch (source.kind) {
      case 'directory': {
        exitCode = 1;
        await context.text().error({ text: `paste: ${file}: Is a directory
` });
        const iterator = emptyPasteRecords()[Symbol.asyncIterator]();
        return { iterator, stdinIterator };
      }
      case 'iterator':
        return {
          iterator: source.iterator,
          stdinIterator: file === '-' ? source.iterator : stdinIterator,
        };
      default: {
        const _ex: never = source;
        throw new Error(`Unhandled paste source: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
      }
      }
    };

    try {
      if (serial) {
        let stdinIterator: AsyncIterator<Uint8Array> | undefined;
        for (const file of files) {
          const source = await getIterator({ file, stdinIterator });
          const iterator = source.iterator;
          stdinIterator = source.stdinIterator;
          iterators.add(iterator);
          let valueIndex = 0;
          while (true) {
            const next = await iterator.next();
            if (next.done) {
              break;
            }
            if (valueIndex > 0) {
              await writer.write({
                chunks: [delimiterForIndex({ delimiters, index: valueIndex - 1 })],
              });
            }
            await writer.write({ chunks: [next.value] });
            valueIndex += 1;
          }
          await writer.write({ chunks: [recordTerminator] });
        }
        return { exitCode };
      }

      let stdinIterator: AsyncIterator<Uint8Array> | undefined;
      const sources: AsyncIterator<Uint8Array>[] = [];
      for (const file of files) {
        const source = await getIterator({ file, stdinIterator });
        const iterator = source.iterator;
        stdinIterator = source.stdinIterator;
        sources.push(iterator);
        iterators.add(iterator);
      }

      while (true) {
        const values: Uint8Array[] = [];
        let hasValue = false;
        for (const iterator of sources) {
          const next = await iterator.next();
          if (next.done) {
            values.push(new Uint8Array(0));
          } else {
            values.push(next.value);
            hasValue = true;
          }
        }
        if (!hasValue) {
          break;
        }
        const rowChunks: Uint8Array[] = [];
        for (let index = 0; index < values.length; index += 1) {
          if (index > 0) {
            rowChunks.push(delimiterForIndex({ delimiters, index: index - 1 }));
          }
          rowChunks.push(values[index] ?? new Uint8Array(0));
        }
        rowChunks.push(recordTerminator);
        await writer.write({
          chunks: rowChunks,
        });
      }
      return { exitCode };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const failingPath = parsed.positionals.find((path) => path !== '-') ?? '-';
      await context.text().error({ text: `paste: ${failingPath}: ${message}\n` });
      return { exitCode: 1 };
    } finally {
      await writer.flush();
      for (const iterator of iterators) {
        await iterator.return?.();
      }
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
