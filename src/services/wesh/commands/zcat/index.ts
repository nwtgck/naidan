import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream } from '@/services/wesh/utils/fs';

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
          stream = handleToStream({ handle: context.stdin });
        } else {
          const fullPath = f.startsWith('/') ? f : (context.cwd === '/' ? `/${f}` : `${context.cwd}/${f}`);
          const blobResult = await context.files.tryReadBlobEfficiently({ path: fullPath });
          switch (blobResult.kind) {
          case 'blob':
            stream = blobResult.blob.stream();
            break;
          case 'fallback-required':
            stream = handleToStream({
              handle: await context.files.open({
                path: fullPath,
                flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
              })
            });
            break;
          default: {
            const _ex: never = blobResult;
            throw new Error(`Unhandled blob result: ${JSON.stringify(_ex)}`);
          }
          }
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
