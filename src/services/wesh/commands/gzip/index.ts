import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { readFile, writeFile } from '@/services/wesh/utils/fs';

const gzipArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const gzipCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'gzip',
    description: 'Compress files',
    usage: 'gzip [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: gzipArgvSpec,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'gzip',
        message: `gzip: ${diagnostic.message}`,
        argvSpec: gzipArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'gzip',
        argvSpec: gzipArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'gzip',
        message: 'gzip: missing file operand',
        argvSpec: gzipArgvSpec,
      });
      return { exitCode: 1 };
    }

    for (const f of parsed.positionals) {
      if (f === undefined) continue;
      try {
        const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
        const input = await readFile({ kernel: context.kernel, path: fullPath });
        const compressor = new CompressionStream('gzip');
        const inputProvider = new ReadableStream({
          start(controller) {
            controller.enqueue(input);
            controller.close();
          }
        });
        const compressedStream = inputProvider.pipeThrough(compressor);

        const gzPath = `${fullPath}.gz`;
        const chunks: Uint8Array[] = [];
        const reader = compressedStream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;
        for (const chunk of chunks) {
          result.set(chunk, offset);
          offset += chunk.length;
        }

        await writeFile({ kernel: context.kernel, path: gzPath, data: result });
        await context.kernel.unlink({ path: fullPath });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `gzip: ${f}: ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
