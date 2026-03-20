import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { readFile, writeFile } from '@/services/wesh/utils/fs';

const gunzipArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

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

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'gunzip',
        message: 'gunzip: missing file operand',
        argvSpec: gunzipArgvSpec,
      });
      return { exitCode: 1 };
    }

    for (const f of parsed.positionals) {
      if (f === undefined) continue;
      try {
        const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
        if (!fullPath.endsWith('.gz')) {
          await text.error({ text: `gunzip: ${f}: unknown suffix -- ignored\n` });
          continue;
        }

        const input = await readFile({ kernel: context.kernel, path: fullPath });
        const decompressor = new DecompressionStream('gzip');
        const inputProvider = new ReadableStream({
          start(controller) {
            controller.enqueue(input);
            controller.close();
          }
        });
        const decompressedStream = inputProvider.pipeThrough(decompressor);

        const originalPath = fullPath.slice(0, -3);
        const chunks: Uint8Array[] = [];
        const reader = decompressedStream.getReader();
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

        await writeFile({ kernel: context.kernel, path: originalPath, data: result });
        await context.kernel.unlink({ path: fullPath });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `gunzip: ${f}: ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
