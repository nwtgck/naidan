import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream } from '@/services/wesh/utils/fs';

export const grepCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'grep',
    description: 'Search for patterns in files',
    usage: 'grep [flags] pattern [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'i', long: undefined, effects: [{ key: 'ignoreCase', value: true }] },
          { kind: 'flag', short: 'v', long: undefined, effects: [{ key: 'invertMatch', value: true }] },
          { kind: 'flag', short: 'n', long: undefined, effects: [{ key: 'lineNumber', value: true }] },
          { kind: 'flag', short: 'w', long: undefined, effects: [{ key: 'wordRegexp', value: true }] },
          { kind: 'flag', short: 'F', long: undefined, effects: [{ key: 'fixedStrings', value: true }] },
          { kind: 'flag', short: 'I', long: undefined, effects: [{ key: 'binaryWithoutMatch', value: true }] },
          { kind: 'value', short: 'A', long: undefined, key: 'afterContext', valueName: 'lines', allowAttachedValue: true, parseValue: undefined },
          { kind: 'value', short: 'B', long: undefined, key: 'beforeContext', valueName: 'lines', allowAttachedValue: true, parseValue: undefined },
          { kind: 'value', short: 'C', long: undefined, key: 'context', valueName: 'lines', allowAttachedValue: true, parseValue: undefined },
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
        command: 'grep',
        message: `grep: ${parsed.diagnostics[0]!.message}`,
      });
      return { exitCode: 2 };
    }

    const text = context.text();
    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'grep',
        message: 'grep: missing pattern operand',
      });
      return { exitCode: 1 };
    }

    const pattern = parsed.optionValues.fixedStrings === true
      ? parsed.positionals[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : parsed.positionals[0]!;
    const regex = new RegExp(
      parsed.optionValues.wordRegexp === true ? `\\b${pattern}\\b` : pattern,
      parsed.optionValues.ignoreCase === true ? 'i' : undefined,
    );
    const files = parsed.positionals.slice(1);

    const before = Number(parsed.optionValues.beforeContext ?? parsed.optionValues.context ?? 0) || 0;
    const contextAfter = Number(parsed.optionValues.afterContext ?? parsed.optionValues.context ?? 0) || 0;

    const processStream = async ({
      stream,
      name,
    }: {
      stream: ReadableStream<Uint8Array>;
      name?: string;
    }) => {
      const decoder = new TextDecoder();
      let buffer = '';
      const reader = stream.getReader();
      const allLines: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (parsed.optionValues.binaryWithoutMatch === true) {
          const isBinary = value.some(byte => byte === 0);
          if (isBinary) return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        allLines.push(...lines);
      }
      if (buffer) allLines.push(buffer);

      const matches = new Array(allLines.length).fill(false);
      for (let i = 0; i < allLines.length; i++) {
        const match = regex.test(allLines[i]!);
        matches[i] = parsed.optionValues.invertMatch === true ? !match : match;
      }

      for (let i = 0; i < allLines.length; i++) {
        if (matches[i]) {
          const start = Math.max(0, i - before);
          const end = Math.min(allLines.length - 1, i + contextAfter);

          for (let j = start; j <= end; j++) {
            let output = '';
            if (name) output += `${name}:`;
            if (parsed.optionValues.lineNumber === true) output += `${j + 1}:`;
            output += allLines[j] + '\n';
            await text.print({ text: output });
          }
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
      await processStream({ stream: input });
    } else {
      for (const f of files) {
        if (f === undefined) continue;
        try {
          const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          await processStream({
            stream: handleToStream({ handle }),
            name: files.length > 1 ? f : undefined
          });
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `grep: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
