import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream } from '@/services/wesh/utils/fs';

export const sedCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'sed',
    description: 'Stream editor for filtering and transforming text',
    usage: 'sed [flags] command [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'n', long: undefined, effects: [{ key: 'quiet', value: true }] },
          { kind: 'flag', short: 'e', long: undefined, effects: [{ key: 'expressionFlag', value: true }] },
          { kind: 'flag', short: 'r', long: undefined, effects: [{ key: 'extendedRegexp', value: true }] },
          { kind: 'flag', short: 'E', long: undefined, effects: [{ key: 'extendedRegexp', value: true }] },
          {
            kind: 'value',
            short: 'i',
            long: undefined,
            key: 'inPlaceSuffix',
            valueName: 'suffix',
            allowAttachedValue: true,
            parseValue: undefined,
          },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: true,
        specialTokenParsers: [],
      },
    });

    if (parsed.diagnostics.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'sed',
        message: `sed: ${parsed.diagnostics[0]!.message}`,
      });
      return { exitCode: 2 };
    }

    const text = context.text();
    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'sed',
        message: 'sed: missing expression',
      });
      return { exitCode: 1 };
    }

    const expression = parsed.positionals[0]!;
    const files = parsed.positionals.slice(1);

    // Basic sed command parsing (only supports s/regex/replacement/g)
    const match = expression.match(/^s([|/])((?:(?=(\\?))\3.)*?)\1((?:(?=(\\?))\5.)*?)\1([g]?)$/);
    if (!match) {
      await writeCommandUsageError({
        context,
        command: 'sed',
        message: `sed: invalid expression '${expression}'`,
      });
      return { exitCode: 1 };
    }

    const regexStr = match[2] ?? '';
    const replacement = match[4] ?? '';
    const globalFlag = match[6] === 'g';
    const regex = new RegExp(regexStr, globalFlag ? 'g' : undefined);

    const processStream = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const transformed = line.replace(regex, replacement);
          if (parsed.optionValues.quiet !== true) {
            await text.print({ text: `${transformed}\n` });
          }
        }
      }
      if (buffer) {
        const transformed = buffer.replace(regex, replacement);
        if (parsed.optionValues.quiet !== true) {
          await text.print({ text: `${transformed}\n` });
        }
      }
    };

    if (files.length === 0) {
      const input = new ReadableStream({
        async pull(controller) {
          const buf = new Uint8Array(4096);
          const { bytesRead } = await context.stdin.read({ buffer: buf });
          if (bytesRead === 0) {
            controller.close();
            return;
          }
          controller.enqueue(buf.subarray(0, bytesRead));
        }
      });
      await processStream(input);
    } else {
      for (const f of files) {
        if (f === undefined) continue;
        try {
          const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          await processStream(handleToStream({ handle }));
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `sed: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
