import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { handleToStream } from '@/services/wesh/utils/fs';

type CutMode = 'b' | 'c' | 'f';

export const cutCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cut',
    description: 'Remove sections from each line of files',
    usage: 'cut [OPTION]... [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional, unknown } = parseFlags({
      args: context.args,
      booleanFlags: ['s', 'complement'],
      stringFlags: ['b', 'c', 'f', 'd', 'output-delimiter'],
    });

    if (unknown.length > 0) {
      await context.text().error({ text: `cut: invalid option -- '${unknown[0]}'\n` });
      return { exitCode: 1 };
    }

    const text = context.text();
    const delimiter = (flags.d as string) ?? '\t';
    const outputDelimiter = (flags['output-delimiter'] as string) ?? delimiter;

    // Simple range parser for list (e.g., "1,3-5,7-")
    const parseList = (list: string): number[] => {
      const indices = new Set<number>();
      for (const part of list.split(',')) {
        if (part.includes('-')) {
          const [start, end] = part.split('-').map(s => s === '' ? undefined : parseInt(s, 10));
          if (start === undefined && end === undefined) continue;
          const s = start ?? 1;
          const e = end ?? Infinity;
          for (let i = s; i <= e; i++) indices.add(i);
        } else {
          indices.add(parseInt(part, 10));
        }
      }
      return Array.from(indices).sort((a, b) => a - b);
    };

    const mode: CutMode | null = flags.b ? 'b' : flags.c ? 'c' : flags.f ? 'f' : null;
    const listStr = (flags.b ?? flags.c ?? flags.f) as string | undefined;

    if (!mode) {
      await text.error({ text: 'cut: must specify one of -b, -c, or -f\n' });
      return { exitCode: 1 };
    }

    const indices = listStr ? parseList(listStr) : [];

    const processLine = (line: string): string | null => {
      switch (mode) {
      case 'f': {
        const parts = line.split(delimiter);
        if (parts.length === 1 && line.includes(delimiter) === false && flags.s) return null;

        const result: string[] = [];
        if (flags.complement) {
          for (let i = 1; i <= parts.length; i++) {
            if (!indices.includes(i)) result.push(parts[i - 1]!);
          }
        } else {
          for (const idx of indices) {
            if (parts[idx - 1] !== undefined) result.push(parts[idx - 1]!);
          }
        }
        return result.join(outputDelimiter);
      }
      case 'b':
      case 'c': {
        // -b or -c (simplified to character-based for this implementation)
        const chars = [...line];
        const result: string[] = [];
        if (flags.complement) {
          for (let i = 1; i <= chars.length; i++) {
            if (!indices.includes(i)) result.push(chars[i - 1]!);
          }
        } else {
          for (const idx of indices) {
            if (chars[idx - 1] !== undefined) result.push(chars[idx - 1]!);
          }
        }
        return result.join('');
      }
      default: {
        const _exhaustive: never = mode;
        throw new Error(`Unhandled cut mode: ${_exhaustive}`);
      }
      }
    };

    const process = async ({ input }: { input: AsyncIterable<string> }) => {
      for await (const line of input) {
        const res = processLine(line);
        if (res !== null) await text.print({ text: res + '\n' });
      }
    };

    if (positional.length === 0) {
      // Stream processing from stdin logic
      const decoder = new TextDecoder();
      const stream = context.stdin;
      const reader = stream.getReader();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const res = processLine(line);
          if (res !== null) await text.print({ text: res + '\n' });
        }
      }
      if (buffer) {
        const res = processLine(buffer);
        if (res !== null) await text.print({ text: res + '\n' });
      }
    } else {
      for (const f of positional) {
        try {
          const fullPath = f!.startsWith('/') ? f! : `${context.cwd}/${f!}`;
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          const stream = handleToStream({ handle });
          const decoder = new TextDecoder();
          const reader = stream.getReader();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              const res = processLine(line);
              if (res !== null) await text.print({ text: res + '\n' });
            }
          }
          if (buffer) {
            const res = processLine(buffer);
            if (res !== null) await text.print({ text: res + '\n' });
          }
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `cut: ${f}: ${message}\n` });
        }
      }
    }

    return { exitCode: 0 };
  },
};
