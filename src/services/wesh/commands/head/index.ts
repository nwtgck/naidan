import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';

function parseCount({
  value,
  errorPrefix,
}: {
  value: string;
  errorPrefix: string;
}): { ok: true; value: number } | { ok: false; message: string } {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return { ok: false, message: `${errorPrefix}: '${value}'` };
  }
  return { ok: true, value: parsed };
}

export const headCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'head',
    description: 'Output the first part of files',
    usage: 'head [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const textOutput = context.text();
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          {
            kind: 'value',
            short: 'n',
            long: 'lines',
            key: 'lines',
            valueName: 'lines',
            allowAttachedValue: true,
            parseValue: ({ value }) => parseCount({
              value,
              errorPrefix: 'invalid number of lines',
            }),
          },
          {
            kind: 'value',
            short: 'c',
            long: 'bytes',
            key: 'bytes',
            valueName: 'bytes',
            allowAttachedValue: true,
            parseValue: ({ value }) => parseCount({
              value,
              errorPrefix: 'invalid number of bytes',
            }),
          },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: true,
        specialTokenParsers: [
          ({ token }) => {
            if (!/^-\d+$/.test(token)) return undefined;
            return {
              kind: 'matched',
              consumeCount: 1,
              effects: [{ key: 'lines', value: parseInt(token.slice(1), 10) }],
            };
          },
        ],
      },
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await textOutput.error({ text: `head: ${diagnostic.message}\n` });
      return { exitCode: 1 };
    }

    const lines = typeof parsed.optionValues.lines === 'number' ? parsed.optionValues.lines : 10;
    const bytes = typeof parsed.optionValues.bytes === 'number' ? parsed.optionValues.bytes : undefined;
    const positional = parsed.positionals;

    const processStream = async ({ stream }: { stream: ReadableStream<Uint8Array> }) => {
      const reader = stream.getReader();

      if (bytes !== undefined) {
        let bytesReadCount = 0;
        while (bytesReadCount < bytes) {
          const { done, value } = await reader.read();
          if (done) break;

          const toRead = Math.min(value.length, bytes - bytesReadCount);
          await textOutput.print({ text: new TextDecoder().decode(value.subarray(0, toRead)) });
          bytesReadCount += toRead;
        }
      } else {
        const decoder = new TextDecoder();
        let linesProcessed = 0;
        let buffer = '';

        while (linesProcessed < lines) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer) await textOutput.print({ text: buffer });
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n');
          // If the last part isn't complete, keep it in buffer
          buffer = parts.pop() || '';

          for (const line of parts) {
            await textOutput.print({ text: line + '\n' });
            linesProcessed++;
            if (linesProcessed >= lines) break;
          }
        }
      }
      reader.releaseLock();
    };

    if (positional.length === 0) {
      await processStream({
        stream: new ReadableStream({
          async pull(controller) {
            const buf = new Uint8Array(4096);
            const { bytesRead } = await context.stdin.read({ buffer: buf });
            if (bytesRead === 0) {
              controller.close();
              return;
            }
            controller.enqueue(buf.subarray(0, bytesRead));
          }
        })
      });
    } else {
      for (const f of positional) {
        try {
          const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          // Simple wrapper to use the stream
          await processStream({
            stream: new ReadableStream({
              async pull(controller) {
                const buf = new Uint8Array(4096);
                const { bytesRead } = await handle.read({ buffer: buf });
                if (bytesRead === 0) {
                  controller.close();
                  return;
                }
                controller.enqueue(buf.subarray(0, bytesRead));
              }
            })
          });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await textOutput.error({ text: `head: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
