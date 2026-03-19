import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshFileHandle } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import { handleToStream } from '@/services/wesh/utils/fs';

const CAT_USAGE_LINES = [
  'usage: cat [OPTION]... [FILE]...',
  'options:',
  '  -A, --show-all            equivalent to -vET',
  '  -b, --number-nonblank     number nonempty output lines',
  '  -E, --show-ends           display $ at end of each line',
  '  -n, --number              number all output lines',
  '  -s, --squeeze-blank       suppress repeated empty output lines',
  '  -T, --show-tabs           display TAB characters as ^I',
  '  -u                        accepted for compatibility',
  '  -v, --show-nonprinting    use ^ and M- notation, except for LFD and TAB',
  '  -e                        equivalent to -vE',
  '  -t                        equivalent to -vT',
].join('\n');

function renderVisibleAscii(char: string): string {
  if (char === '\t') return char;

  const code = char.charCodeAt(0);
  if ((code >= 0 && code <= 8) || (code >= 11 && code <= 12) || (code >= 14 && code <= 31) || code === 127) {
    return '^' + String.fromCharCode(code + 64);
  }

  return char;
}

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  return path.startsWith('/') ? path : `${cwd}/${path}`;
}

async function writeAll({
  handle,
  buffer,
}: {
  handle: WeshFileHandle;
  buffer: Uint8Array;
}): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write({
      buffer,
      offset,
      length: buffer.length - offset,
    });
    offset += bytesWritten;
  }
}

async function writeUsageError({
  context,
  message,
}: {
  context: WeshCommandContext;
  message: string;
}): Promise<void> {
  const encoder = new TextEncoder();
  await context.stderr.write({
    buffer: encoder.encode(`${message}\n${CAT_USAGE_LINES}\n`),
  });
}

export const catCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cat',
    description: 'Concatenate files and print on the standard output',
    usage: 'cat [flags] [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'n', long: 'number', effects: [{ key: 'numberAllLines', value: true }] },
          { kind: 'flag', short: 'b', long: 'number-nonblank', effects: [{ key: 'numberNonBlankLines', value: true }] },
          { kind: 'flag', short: 'E', long: 'show-ends', effects: [{ key: 'showEnds', value: true }] },
          { kind: 'flag', short: 'T', long: 'show-tabs', effects: [{ key: 'showTabs', value: true }] },
          { kind: 'flag', short: 'v', long: 'show-nonprinting', effects: [{ key: 'showNonPrinting', value: true }] },
          {
            kind: 'flag',
            short: 'A',
            long: 'show-all',
            effects: [
              { key: 'showEnds', value: true },
              { key: 'showTabs', value: true },
              { key: 'showNonPrinting', value: true },
            ],
          },
          {
            kind: 'flag',
            short: 'e',
            long: undefined,
            effects: [
              { key: 'showEnds', value: true },
              { key: 'showNonPrinting', value: true },
            ],
          },
          {
            kind: 'flag',
            short: 't',
            long: undefined,
            effects: [
              { key: 'showTabs', value: true },
              { key: 'showNonPrinting', value: true },
            ],
          },
          { kind: 'flag', short: 's', long: 'squeeze-blank', effects: [{ key: 'squeezeBlank', value: true }] },
          { kind: 'flag', short: 'u', long: 'u', effects: [] },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: true,
        specialTokenParsers: [],
      },
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeUsageError({
        context,
        message: `cat: ${diagnostic.message}`,
      });
      return { exitCode: 1 };
    }

    const files = parsed.positionals;
    const numberAllLines = parsed.optionValues.numberAllLines === true;
    const numberNonBlankLines = parsed.optionValues.numberNonBlankLines === true;
    const showEnds = parsed.optionValues.showEnds === true;
    const showTabs = parsed.optionValues.showTabs === true;
    const showNonPrinting = parsed.optionValues.showNonPrinting === true;
    const squeezeBlank = parsed.optionValues.squeezeBlank === true;
    const text = context.text();
    let lineNumber = 1;
    let lastWasEmpty = false;
    let hadError = false;
    const applyNumbering = numberAllLines || numberNonBlankLines;
    const hasTransform = applyNumbering || showEnds || showTabs || showNonPrinting || squeezeBlank;

    const processRawStream = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writeAll({ handle: context.stdout, buffer: value });
        }
      } finally {
        reader.releaseLock();
      }
    };

    const processStream = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const isEmpty = line.length === 0;
            if (squeezeBlank && isEmpty && lastWasEmpty) continue;

            let output = '';
            const shouldNumberLine = numberNonBlankLines ? !isEmpty : numberAllLines;
            if (shouldNumberLine) {
              output += `${String(lineNumber++).padStart(6, ' ')}  `;
            }

            let processedLine = line;
            if (showTabs) processedLine = processedLine.replace(/\t/g, '^I');
            if (showNonPrinting) {
              processedLine = Array.from(processedLine, renderVisibleAscii).join('');
            }
            if (showEnds) processedLine += '$';

            await text.print({ text: output + processedLine + '\n' });
            lastWasEmpty = isEmpty;
          }
        }

        if (buffer.length > 0) {
          const isEmpty = buffer.length === 0;
          if (!(squeezeBlank && isEmpty && lastWasEmpty)) {
            let output = '';
            const shouldNumberLine = numberNonBlankLines ? !isEmpty : numberAllLines;
            if (shouldNumberLine) {
              output += `${String(lineNumber++).padStart(6, ' ')}  `;
            }

            let processedLine = buffer;
            if (showTabs) processedLine = processedLine.replace(/\t/g, '^I');
            if (showNonPrinting) {
              processedLine = Array.from(processedLine, renderVisibleAscii).join('');
            }
            if (showEnds) processedLine += '$';

            await text.print({ text: output + processedLine });
            lastWasEmpty = isEmpty;
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    const processInputHandle = async ({ handle }: { handle: WeshFileHandle }) => {
      const stream = handleToStream({ handle });
      if (hasTransform) {
        await processStream(stream);
        return;
      }
      await processRawStream(stream);
    };

    if (files.length === 0) {
      await processInputHandle({ handle: context.stdin });
    } else {
      for (const f of files) {
        if (f === '-') {
          await processInputHandle({ handle: context.stdin });
          continue;
        }

        try {
          const fullPath = resolvePath({ cwd: context.cwd, path: f });
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          try {
            await processInputHandle({ handle });
          } finally {
            try {
              await handle.close();
            } catch {
              // handleToStream may already have closed the file handle
            }
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `cat: ${f}: ${message}\n` });
          hadError = true;
        }
      }
    }

    return { exitCode: hadError ? 1 : 0 };
  },
};
