import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshFileHandle } from '@/services/wesh/types';
import { handleToStream } from '@/services/wesh/utils/fs';

function renderVisibleAscii(char: string): string {
  if (char === '\t') return '^I';

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

export const catCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cat',
    description: 'Concatenate files and print on the standard output',
    usage: 'cat [flags] [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const files: string[] = [];
    let numberAllLines = false;
    let numberNonBlankLines = false;
    let showEnds = false;
    let showTabs = false;
    let showNonPrinting = false;
    let squeezeBlank = false;

    for (let i = 0; i < context.args.length; i++) {
      const arg = context.args[i];
      if (arg === undefined) continue;

      if (arg === '--') {
        files.push(...context.args.slice(i + 1).filter((value): value is string => value !== undefined));
        break;
      }

      if (arg === '-') {
        files.push(arg);
        continue;
      }

      if (arg.startsWith('--')) {
        const longFlag = arg.slice(2);
        switch (longFlag) {
        case 'number':
          numberAllLines = true;
          break;
        case 'number-nonblank':
          numberNonBlankLines = true;
          break;
        case 'show-ends':
          showEnds = true;
          break;
        case 'show-tabs':
          showTabs = true;
          break;
        case 'show-nonprinting':
          showNonPrinting = true;
          break;
        case 'show-all':
          showEnds = true;
          showTabs = true;
          showNonPrinting = true;
          break;
        case 'squeeze-blank':
          squeezeBlank = true;
          break;
        case 'u':
          break;
        default:
          await context.stderr.write({
            buffer: new TextEncoder().encode(`cat: unrecognized option '--${longFlag}'\n`),
          });
          return { exitCode: 1 };
        }
        continue;
      }

      if (arg.startsWith('-') && arg.length > 1) {
        let invalidFlag: string | undefined;

        for (const flag of arg.slice(1)) {
          switch (flag) {
          case 'A':
            showEnds = true;
            showTabs = true;
            showNonPrinting = true;
            break;
          case 'b':
            numberNonBlankLines = true;
            break;
          case 'e':
            showEnds = true;
            showNonPrinting = true;
            break;
          case 'E':
            showEnds = true;
            break;
          case 'n':
            numberAllLines = true;
            break;
          case 's':
            squeezeBlank = true;
            break;
          case 't':
            showTabs = true;
            showNonPrinting = true;
            break;
          case 'T':
            showTabs = true;
            break;
          case 'u':
            break;
          case 'v':
            showNonPrinting = true;
            break;
          default:
            invalidFlag = flag;
            break;
          }

          if (invalidFlag !== undefined) break;
        }

        if (invalidFlag !== undefined) {
          await context.stderr.write({
            buffer: new TextEncoder().encode(`cat: invalid option -- '${invalidFlag}'\n`),
          });
          return { exitCode: 1 };
        }
        continue;
      }

      files.push(arg);
    }

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
            if (numberAllLines || (numberNonBlankLines && !isEmpty)) {
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
            if (numberAllLines || (numberNonBlankLines && !isEmpty)) {
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
