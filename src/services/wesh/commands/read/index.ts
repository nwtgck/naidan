import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';

export const readCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'read',
    description: 'Read a line from standard input or a file descriptor into shell variables',
    usage: 'read [-r] [-u fd] [name...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'r', long: undefined, effects: [{ key: 'rawMode', value: true }], help: { summary: 'do not treat backslash as an escape character' } },
          {
            kind: 'value',
            short: 'u',
            long: undefined,
            key: 'fd',
            valueName: 'fd',
            allowAttachedValue: false,
            help: { summary: 'read from file descriptor fd' },
            parseValue: ({ value }) => /^\d+$/.test(value)
              ? { ok: true, value: parseInt(value, 10) }
              : { ok: false, message: `invalid file descriptor '${value}'` },
          },
        ],
        allowShortFlagBundles: false,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: true,
        specialTokenParsers: [],
      },
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await context.text().error({ text: `read: ${diagnostic.message}\n` });
      return { exitCode: 1 };
    }

    const fdValue = parsed.optionValues.fd;
    const fd = typeof fdValue === 'number' ? fdValue : 0;
    const rawMode = parsed.optionValues.rawMode === true;
    const variableNames = parsed.positionals;

    const inputHandle = context.getFileDescriptor({ fd });
    if (inputHandle === undefined) {
      await context.text().error({ text: `read: ${fd}: bad file descriptor\n` });
      return { exitCode: 1 };
    }

    const decoder = new TextDecoder();
    const buffer = new Uint8Array(1);
    let line = '';
    let didRead = false;

    while (true) {
      const { bytesRead } = await inputHandle.read({ buffer });
      if (bytesRead === 0) {
        break;
      }
      didRead = true;

      const chunk = decoder.decode(buffer.subarray(0, bytesRead));
      const char = chunk[0];
      if (char === undefined) {
        continue;
      }

      if (char === '\n') {
        break;
      }

      if (!rawMode && char === '\\') {
        const nextRead = await inputHandle.read({ buffer });
        if (nextRead.bytesRead === 0) {
          line += '\\';
          break;
        }
        didRead = true;

        const nextChar = decoder.decode(buffer.subarray(0, nextRead.bytesRead))[0];
        if (nextChar === '\n') {
          continue;
        }
        line += nextChar ?? '';
        continue;
      }

      line += char;
    }

    const names = variableNames.length > 0 ? variableNames : ['REPLY'];
    const fields = line.trim().length === 0 ? [''] : line.trim().split(/\s+/);

    for (let index = 0; index < names.length; index++) {
      const name = names[index];
      if (name === undefined) {
        continue;
      }

      if (index === names.length - 1) {
        context.setEnv({
          key: name,
          value: fields.slice(index).join(' '),
        });
        continue;
      }

      context.setEnv({
        key: name,
        value: fields[index] ?? '',
      });
    }

    return { exitCode: didRead ? 0 : 1 };
  },
};
