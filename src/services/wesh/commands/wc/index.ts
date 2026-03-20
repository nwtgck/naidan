import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream } from '@/services/wesh/utils/fs';

export const wcCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'wc',
    description: 'Print newline, word, and byte counts for each file',
    usage: 'wc [file...] [-l] [-w] [-c] [-m]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'l', long: undefined, effects: [{ key: 'lines', value: true }] },
          { kind: 'flag', short: 'w', long: undefined, effects: [{ key: 'words', value: true }] },
          { kind: 'flag', short: 'c', long: undefined, effects: [{ key: 'bytes', value: true }] },
          { kind: 'flag', short: 'm', long: undefined, effects: [{ key: 'chars', value: true }] },
        ],
        allowShortFlagBundles: true,
        stopAtDoubleDash: true,
        treatSingleDashAsPositional: true,
        specialTokenParsers: [],
      },
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'wc',
        message: `wc: ${diagnostic.message}`,
      });
      return { exitCode: 1 };
    }

    const text = context.text();
    const linesRequested = Boolean(parsed.optionValues.lines);
    const wordsRequested = Boolean(parsed.optionValues.words);
    const bytesRequested = Boolean(parsed.optionValues.bytes);
    const charsRequested = Boolean(parsed.optionValues.chars);
    const showDefaultColumns = !linesRequested && !wordsRequested && !bytesRequested && !charsRequested;
    const showLines = linesRequested || showDefaultColumns;
    const showWords = wordsRequested || showDefaultColumns;
    const showBytes = bytesRequested || showDefaultColumns;
    const showChars = charsRequested;

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

    if (parsed.positionals.length === 0) {
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
      for (const f of parsed.positionals) {
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
