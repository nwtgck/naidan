import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshFileHandle } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';

export const grepCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'grep',
    description: 'Print lines matching a pattern',
    usage: 'grep [-i] [-v] [-n] pattern [file...]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['i', 'v', 'n'],
      stringFlags: [],
    });

    const text = context.text();
    if (positional.length === 0) {
      await text.error({ text: 'grep: pattern is required\n' });
      return { exitCode: 1 };
    }

    const patternStr = positional[0]!;
    const files = positional.slice(1);
    const regex = new RegExp(patternStr, flags.i ? 'i' : '');
    const invert = !!flags.v;
    const showLineNumber = !!flags.n;

    const processHandle = async (handle: WeshFileHandle, label?: string) => {
      let lineNum = 0;
      let buffer = '';
      const readBuf = new Uint8Array(16 * 1024);
      const decoder = new TextDecoder();

      while (true) {
        const { bytesRead } = await handle.read({ buffer: readBuf });
        if (bytesRead === 0) break;

        buffer += decoder.decode(readBuf.subarray(0, bytesRead), { stream: true });
        if (buffer.includes('\n')) {
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            lineNum++;
            if (regex.test(line) !== invert) {
              let out = '';
              if (label) out += `${label}:`;
              if (showLineNumber) out += `${lineNum}:`;
              out += line + '\n';
              await text.print({ text: out });
            }
          }
        }
      }
      if (buffer) {
        lineNum++;
        if (regex.test(buffer) !== invert) {
          let out = '';
          if (label) out += `${label}:`;
          if (showLineNumber) out += `${lineNum}:`;
          out += buffer + '\n';
          await text.print({ text: out });
        }
      }
    };

    if (files.length === 0) {
      await processHandle(context.stdin);
    } else {
      for (const f of files) {
        try {
          const path = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          const handle = await context.kernel.open({ path, flags: 0 });
          try {
            await processHandle(handle, files.length > 1 ? f : undefined);
          } finally {
            await handle.close();
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `grep: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
