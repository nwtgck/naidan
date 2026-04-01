import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { openHandleReadStream, openFileReadStream } from '@/services/wesh/utils/fs';

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }
  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

const zcatArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const zcatCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'zcat',
    description: 'Decompress and print files to standard output',
    usage: 'zcat [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: zcatArgvSpec,
    });

    const text = context.text();
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'zcat',
        message: `zcat: ${diagnostic.message}`,
        argvSpec: zcatArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'zcat',
        argvSpec: zcatArgvSpec,
      });
      return { exitCode: 0 };
    }

    const inputs = parsed.positionals.length > 0 ? parsed.positionals : ['-'];
    const decoder = new TextDecoder();

    for (const f of inputs) {
      if (f === undefined) continue;
      try {
        let stream: ReadableStream<Uint8Array>;
        if (f === '-') {
          stream = openHandleReadStream({ handle: context.stdin });
        } else {
          stream = await openFileReadStream({
            files: context.files,
            path: resolvePath({ cwd: context.cwd, path: f }),
          });
        }
        const decompressor = new DecompressionStream('gzip');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const decompressedStream = stream.pipeThrough(decompressor as any) as ReadableStream<Uint8Array>;

        const reader = decompressedStream.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await text.print({ text: decoder.decode(value, { stream: true }) });
        }
        await text.print({ text: decoder.decode() }); // flush
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        await text.error({ text: `zcat: ${f}: ${message}\n` });
      }
    }

    return { exitCode: 0 };
  },
};
