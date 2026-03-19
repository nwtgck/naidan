import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseFlags } from '@/services/wesh/utils/args';
import { handleToStream } from '@/services/wesh/utils/fs';

export const wcCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'wc',
    description: 'Print newline, word, and byte counts for each file',
    usage: 'wc [file...] [-l] [-w] [-c] [-m]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const { flags, positional } = parseFlags({
      args: context.args,
      booleanFlags: ['l', 'w', 'c', 'm'],
      stringFlags: [],
    });

    const text = context.text();
    const showLines = flags.l || (!flags.l && !flags.w && !flags.c && !flags.m);
    const showWords = flags.w || (!flags.l && !flags.w && !flags.c && !flags.m);
    const showBytes = flags.c || (!flags.l && !flags.w && !flags.c && !flags.m);
    const showChars = flags.m;

    const results: Array<{ lines: number; words: number; bytes: number; chars: number; name: string }> = [];

    const processStream = async (stream: ReadableStream<Uint8Array>, name: string) => {
      let lines = 0;
      let words = 0;
      let bytes = 0;
      let chars = 0;
      let inWord = false;
      const decoder = new TextDecoder();

      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        bytes += value.length;
        const chunk = decoder.decode(value, { stream: true });
        chars += chunk.length;

        for (const char of chunk) {
          if (char === '\n') lines++;
          if (/\s/.test(char)) {
            inWord = false;
          } else if (!inWord) {
            inWord = true;
            words++;
          }
        }
      }
      results.push({ lines, words, bytes, chars, name });
    };

    if (positional.length === 0) {
      // Use stdin if no files provided
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
      await processStream(input, '');
    } else {
      for (const f of positional) {
        if (f === undefined) continue;
        try {
          const fullPath = f.startsWith('/') ? f : `${context.cwd}/${f}`;
          const handle = await context.kernel.open({
            path: fullPath,
            flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
          });
          await processStream(handleToStream({ handle }), f);
        } catch (e: unknown) {
          const message = e instanceof Error ? e.message : String(e);
          await text.error({ text: `wc: ${f}: ${message}\n` });
        }
      }
    }

    for (const r of results) {
      let line = '';
      if (showLines) line += r.lines.toString().padStart(8);
      if (showWords) line += r.words.toString().padStart(8);
      if (showChars) line += r.chars.toString().padStart(8);
      if (showBytes) line += r.bytes.toString().padStart(8);
      if (r.name) line += ` ${r.name}`;
      await text.print({ text: line + '\n' });
    }

    if (results.length > 1) {
      const total = results.reduce(
        (acc, r) => ({
          lines: acc.lines + r.lines,
          words: acc.words + r.words,
          bytes: acc.bytes + r.bytes,
          chars: acc.chars + r.chars,
          name: 'total'
        }),
        { lines: 0, words: 0, bytes: 0, chars: 0, name: 'total' }
      );
      let line = '';
      if (showLines) line += total.lines.toString().padStart(8);
      if (showWords) line += total.words.toString().padStart(8);
      if (showChars) line += total.chars.toString().padStart(8);
      if (showBytes) line += total.bytes.toString().padStart(8);
      line += ` ${total.name}`;
      await text.print({ text: line + '\n' });
    }

    return { exitCode: 0 };
  },
};
