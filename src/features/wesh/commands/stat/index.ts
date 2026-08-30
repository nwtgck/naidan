import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type StandardArgvAction, type StandardArgvOccurrence, type StandardArgvPolicy, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import { resolveCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { resolvePath } from '@/features/wesh/path';
import type {
  WeshCommandContext,
  WeshCommandDefinition,
  WeshCommandResult,
  WeshFileHandle,
} from '@/features/wesh/types';
import { compileStatFormat, type CompiledStatFormat } from './format-parser';
import {
  quoteStatName,
  renderCompiledStatFormatChunks,
  renderDefaultStatOutput,
  type StatRenderInput,
  validateStatMetadata,
} from './format-renderer';

const statHelpDetails = `\
supported format sequences:
  %a permissions in octal       %A symbolic permissions and file type
  %f raw mode in hexadecimal    %F file type
  %g group ID                   %i inode-like identifier
  %n file name                  %N quoted name and symlink target
  %s size in bytes              %u user ID
  %w birth time (- if unknown)  %W birth time seconds (0 if unknown)
  %y modification time in UTC   %Y modification time seconds

Wesh exposes virtual-filesystem metadata only. Block allocation, device numbers,
hard-link counts, owner names, access/change times, mount points, and filesystem
status are intentionally unavailable rather than fabricated.
`;

type StatDeferredOption = 'format' | 'printf';

const statDereferenceOption = {
  semantic: { kind: 'effects', effects: [{ key: 'dereference', value: true }] },
  forms: [
    { kind: 'short', name: 'L', value: { kind: 'none' } },
    { kind: 'long', name: 'dereference', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<StatDeferredOption>>;
const statFormatOption = {
  semantic: { kind: 'deferred', tag: 'format' },
  forms: [
    { kind: 'short', name: 'c', value: { kind: 'required-attached-or-following', missingValueName: 'FORMAT' } },
    { kind: 'long', name: 'format', value: { kind: 'required', missingValueName: 'FORMAT' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<StatDeferredOption>>;
const statPrintfOption = {
  semantic: { kind: 'deferred', tag: 'printf' },
  forms: [{ kind: 'long', name: 'printf', value: { kind: 'required', missingValueName: 'FORMAT' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<StatDeferredOption>>;
const statHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<StatDeferredOption>>;
const statArgvCatalog = defineArgvCatalog<StandardArgvAction<StatDeferredOption>>({
  nonExecutableLongOptions: [
    'cached',
    'file-system',
    'terse',
    'version',
  ],
  definitions: [statDereferenceOption, statFormatOption, statPrintfOption, statHelpOption],
});
const statArgvHelp = defineArgvHelpPresentation({
  catalog: statArgvCatalog,
  rows: [
    { forms: statDereferenceOption.forms, summary: 'follow symbolic links' },
    { forms: statFormatOption.forms, summary: 'use FORMAT and append a newline for each file', valueName: 'FORMAT' },
    { forms: statPrintfOption.forms, summary: 'use FORMAT, interpret escapes, and do not append a newline', valueName: 'FORMAT' },
    { forms: statHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});
const statArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

const textEncoder = new TextEncoder();
const newlineBytes = Uint8Array.of(0x0a);
const OUTPUT_BUFFER_SIZE = 64 * 1024;

type SelectedOutputMode =
  | { kind: 'default' }
  | { kind: 'format', format: string }
  | { kind: 'printf', format: string };

function selectOutputMode({
  occurrences,
}: {
  occurrences: readonly StandardArgvOccurrence<Extract<StandardArgvAction<StatDeferredOption>, { kind: 'deferred' }>>[],
}): SelectedOutputMode {
  let outputMode: SelectedOutputMode = { kind: 'default' };
  for (const occurrence of occurrences) {
    const format = (() => {
      switch (occurrence.value.kind) {
      case 'inline':
      case 'next-argv':
        return occurrence.value.rawValue;
      case 'none':
        throw new Error('stat output-format option is missing its required value');
      default: {
        const _ex: never = occurrence.value;
        throw new Error(`Unhandled stat option value: ${JSON.stringify(_ex)}`);
      }
      }
    })();
    switch (occurrence.semantic.tag) {
    case 'format':
      outputMode = { kind: 'format', format };
      break;
    case 'printf':
      outputMode = { kind: 'printf', format };
      break;
    default: {
      const _ex: never = occurrence.semantic.tag;
      throw new Error(`Unhandled stat output option: ${_ex}`);
    }
    }
  }
  return outputMode;
}

function compileSelectedFormat({
  outputMode,
}: {
  outputMode: SelectedOutputMode,
}): { ok: true, format: CompiledStatFormat | undefined } | { ok: false, message: string } {
  switch (outputMode.kind) {
  case 'default':
    return { ok: true, format: undefined };
  case 'format': {
    const compiled = compileStatFormat({
      format: outputMode.format,
      escapeMode: 'literal',
    });
    return compiled.ok ? { ok: true, format: compiled.value } : compiled;
  }
  case 'printf': {
    const compiled = compileStatFormat({
      format: outputMode.format,
      escapeMode: 'printf',
    });
    return compiled.ok ? { ok: true, format: compiled.value } : compiled;
  }
  default: {
    const _ex: never = outputMode;
    throw new Error(`Unhandled stat output mode: ${String(_ex)}`);
  }
  }
}

async function loadOperandInput({
  context,
  operand,
  dereference,
  format,
}: {
  context: WeshCommandContext,
  operand: string,
  dereference: boolean,
  format: CompiledStatFormat | undefined,
}): Promise<StatRenderInput> {
  if (operand.length === 0) {
    throw new Error('No such file or directory');
  }

  const resolvedPath = resolvePath({ cwd: context.cwd, path: operand });
  const hasTrailingSlash = operand.endsWith('/');
  const shouldDereference = dereference || hasTrailingSlash;
  const stat = shouldDereference
    ? await context.files.stat({ path: resolvedPath })
    : await context.files.lstat({ path: resolvedPath });

  if (hasTrailingSlash && stat.type !== 'directory') {
    throw new Error('Not a directory');
  }

  const invalidMetadata = validateStatMetadata({ stat });
  if (invalidMetadata !== undefined) {
    throw new Error(`invalid file metadata: ${invalidMetadata}`);
  }

  const needsSymlinkTarget = stat.type === 'symlink'
    && !shouldDereference
    && (format === undefined || format.needsSymlinkTarget);
  const symlinkTarget = needsSymlinkTarget
    ? await context.files.readlink({ path: resolvedPath })
    : undefined;

  return {
    operand,
    stat,
    symlinkTarget,
    characterLocaleMode: resolveCharacterLocaleMode({ env: context.env }),
  };
}

function* renderOutputChunks({
  outputMode,
  format,
  input,
}: {
  outputMode: SelectedOutputMode,
  format: CompiledStatFormat | undefined,
  input: StatRenderInput,
}): Iterable<Uint8Array> {
  switch (outputMode.kind) {
  case 'default':
    if (format !== undefined) throw new Error('Default stat output unexpectedly used a compiled format');
    yield textEncoder.encode(renderDefaultStatOutput({ input }));
    return;
  case 'format':
    if (format === undefined) throw new Error('Formatted stat output is missing its compiled format');
    yield* renderCompiledStatFormatChunks({ format, input });
    yield newlineBytes;
    return;
  case 'printf':
    if (format === undefined) throw new Error('Printf stat output is missing its compiled format');
    yield* renderCompiledStatFormatChunks({ format, input });
    return;
  default: {
    const _ex: never = outputMode;
    throw new Error(`Unhandled stat output mode: ${String(_ex)}`);
  }
  }
}

async function writeAllBytes({
  handle,
  bytes,
}: {
  handle: WeshFileHandle,
  bytes: Uint8Array,
}): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset;
    const { bytesWritten } = await handle.write({
      buffer: bytes,
      offset,
      length: remaining,
    });
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
      throw new Error('invalid write result');
    }
    offset += bytesWritten;
  }
}

function combineChunks({
  chunks,
  byteLength,
}: {
  chunks: Uint8Array[],
  byteLength: number,
}): Uint8Array {
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function writeOutputChunks({
  handle,
  chunks,
}: {
  handle: WeshFileHandle,
  chunks: Iterable<Uint8Array>,
}): Promise<void> {
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;

  const flush = async () => {
    if (pendingBytes === 0) return;
    const combined = combineChunks({ chunks: pending, byteLength: pendingBytes });
    pending = [];
    pendingBytes = 0;
    await writeAllBytes({ handle, bytes: combined });
  };

  for (const chunk of chunks) {
    if (chunk.byteLength === 0) continue;
    if (chunk.byteLength >= OUTPUT_BUFFER_SIZE) {
      await flush();
      await writeAllBytes({ handle, bytes: chunk });
      continue;
    }
    if (pendingBytes + chunk.byteLength > OUTPUT_BUFFER_SIZE) await flush();
    pending.push(chunk);
    pendingBytes += chunk.byteLength;
  }
  await flush();
}

export const statCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'stat',
    description: 'Display file status from the Wesh virtual filesystem',
    usage: 'stat [-L] [-c FORMAT | --printf FORMAT] FILE...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: statArgvCatalog,
        policy: statArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: statArgvCatalog,
      policy: statArgvPolicy,
    });
    const diagnostic = parsed.diagnostics[0];
    const text = context.text();

    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'stat',
        message: `stat: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: statArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'stat',
        optionLines: formatArgvOptionHelp({ presentation: statArgvHelp }),
      });
      await text.print({ text: statHelpDetails });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'stat',
        message: 'stat: missing operand',
        usageSummary: formatArgvUsageSummary({ presentation: statArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const outputMode = selectOutputMode({ occurrences: parsed.deferred });
    const compiled = compileSelectedFormat({ outputMode });
    if (!compiled.ok) {
      await text.error({ text: `${compiled.message}\n` });
      return { exitCode: 1 };
    }

    const dereference = parsed.optionValues.dereference === true;
    let exitCode = 0;
    for (const operand of parsed.positionals) {
      let input: StatRenderInput;
      try {
        input = await loadOperandInput({
          context,
          operand,
          dereference,
          format: compiled.format,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await text.error({
          text: `stat: cannot stat ${quoteStatName({
            value: operand,
            characterLocaleMode: resolveCharacterLocaleMode({ env: context.env }),
          })}: ${message}\n`,
        });
        exitCode = 1;
        continue;
      }

      if (compiled.format !== undefined) {
        for (const warning of compiled.format.warnings) {
          await text.error({ text: `${warning}\n` });
        }
      }

      try {
        await writeOutputChunks({
          handle: context.stdout,
          chunks: renderOutputChunks({
            outputMode,
            format: compiled.format,
            input,
          }),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `stat: output error: ${message}\n` });
        return { exitCode: 1 };
      }
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  compileSelectedFormat,
  selectOutputMode,
};
