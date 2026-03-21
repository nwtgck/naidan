import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream, readFile, writeFile } from '@/services/wesh/utils/fs';

const gunzipArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'c', long: 'stdout', effects: [{ key: 'stdout', value: true }], help: { summary: 'write on standard output, keep original files unchanged', category: 'common' } },
    { kind: 'flag', short: 'k', long: 'keep', effects: [{ key: 'keep', value: true }], help: { summary: 'keep input files unchanged', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

async function readStreamBytes({
  stream,
}: {
  stream: ReadableStream<Uint8Array>;
}): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function writeBytes({
  handle,
  data,
}: {
  handle: WeshCommandContext['stdout'];
  data: Uint8Array;
}): Promise<void> {
  let offset = 0;
  while (offset < data.length) {
    const { bytesWritten } = await handle.write({
      buffer: data,
      offset,
      length: data.length - offset,
    });
    if (bytesWritten === 0) {
      break;
    }
    offset += bytesWritten;
  }
}

export const gunzipCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'gunzip',
    description: 'Decompress files',
    usage: 'gunzip [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: gunzipArgvSpec,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'gunzip',
        message: `gunzip: ${diagnostic.message}`,
        argvSpec: gunzipArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'gunzip',
        argvSpec: gunzipArgvSpec,
      });
      return { exitCode: 0 };
    }

    const writeToStdout = parsed.optionValues.stdout === true;
    const keepInput = parsed.optionValues.keep === true || writeToStdout;
    const inputs = parsed.positionals.length > 0 ? parsed.positionals : ['-'];

    for (const f of inputs) {
      try {
        if (f !== '-') {
          const fullPath = f.startsWith('/') ? f : (context.cwd === '/' ? `/${f}` : `${context.cwd}/${f}`);
          if (!fullPath.endsWith('.gz')) {
            await text.error({ text: `gunzip: ${f}: unknown suffix -- ignored\n` });
            continue;
          }

          const input = await readFile({ files: context.files, path: fullPath });
          const decompressor = new DecompressionStream('gzip');
          const inputProvider = new ReadableStream({
            start(controller) {
              controller.enqueue(input);
              controller.close();
            }
          });
          const decompressedStream = inputProvider.pipeThrough(decompressor);
          const result = await readStreamBytes({ stream: decompressedStream });

          if (writeToStdout) {
            await writeBytes({
              handle: context.stdout,
              data: result,
            });
            continue;
          }

          const originalPath = fullPath.slice(0, -3);
          await writeFile({ files: context.files, path: originalPath, data: result });
          if (!keepInput) {
            await context.files.unlink({ path: fullPath });
          }
          continue;
        }

        const input = await readStreamBytes({ stream: handleToStream({ handle: context.stdin }) });
        const decompressor = new DecompressionStream('gzip');
        const inputProvider = new ReadableStream({
          start(controller) {
            controller.enqueue(input);
            controller.close();
          }
        });
        const decompressedStream = inputProvider.pipeThrough(decompressor);
        const result = await readStreamBytes({ stream: decompressedStream });
        await writeBytes({
          handle: context.stdout,
          data: result,
        });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `gunzip: ${f}: ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
