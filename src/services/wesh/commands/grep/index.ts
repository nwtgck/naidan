import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import type { ArgvOptionOccurrence } from '@/services/wesh/argv';
import { writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream, readFile } from '@/services/wesh/utils/fs';

interface GrepFileReport {
  matched: boolean;
  selectedLineCount: number;
  outputLines: string[];
}

type GrepOutputMode = 'lines' | 'count' | 'files-with-matches' | 'files-without-match' | 'only-matching';

function isValueOccurrenceForKey(
  occurrence: ArgvOptionOccurrence,
  key: string,
): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> {
  return occurrence.kind === 'value' && occurrence.key === key;
}

function escapeRegExp({ value }: { value: string }): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildGrepRegex({
  patterns,
  fixedStrings,
  wordRegexp,
  ignoreCase,
  exactLine,
  global,
}: {
  patterns: string[];
  fixedStrings: boolean;
  wordRegexp: boolean;
  ignoreCase: boolean;
  exactLine: boolean;
  global: boolean;
}): RegExp {
  const source = patterns
    .map((pattern) => (fixedStrings ? escapeRegExp({ value: pattern }) : pattern))
    .map((pattern) => (wordRegexp ? `\\b(?:${pattern})\\b` : `(?:${pattern})`))
    .map((pattern) => (exactLine ? `^(?:${pattern})$` : pattern))
    .join('|');

  const flags = `${global ? 'g' : ''}${ignoreCase ? 'i' : ''}`;
  return new RegExp(source, flags || undefined);
}

async function readPatternFile({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): Promise<string[]> {
  const fullPath = path.startsWith('/') ? path : `${context.cwd}/${path}`;
  const bytes = await readFile({ kernel: context.kernel, path: fullPath });
  const content = new TextDecoder().decode(bytes);
  return content.split(/\r?\n/).filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

export const grepCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'grep',
    description: 'Search for patterns in files',
    usage: 'grep [OPTION]... PATTERNS [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: context.args,
      spec: {
        options: [
          { kind: 'flag', short: 'E', long: 'extended-regexp', effects: [{ key: 'extendedRegexp', value: true }] },
          { kind: 'flag', short: 'i', long: 'ignore-case', effects: [{ key: 'ignoreCase', value: true }] },
          { kind: 'flag', short: 'v', long: 'invert-match', effects: [{ key: 'invertMatch', value: true }] },
          { kind: 'flag', short: 'n', long: 'line-number', effects: [{ key: 'lineNumber', value: true }] },
          { kind: 'flag', short: 'w', long: 'word-regexp', effects: [{ key: 'wordRegexp', value: true }] },
          { kind: 'flag', short: 'x', long: 'line-regexp', effects: [{ key: 'exactLine', value: true }] },
          { kind: 'flag', short: 'F', long: 'fixed-strings', effects: [{ key: 'fixedStrings', value: true }] },
          { kind: 'flag', short: 'I', long: 'binary-files', effects: [{ key: 'binaryWithoutMatch', value: true }] },
          { kind: 'flag', short: 's', long: 'no-messages', effects: [{ key: 'noMessages', value: true }] },
          { kind: 'flag', short: 'q', long: 'quiet', effects: [{ key: 'quiet', value: true }] },
          { kind: 'flag', short: undefined, long: 'silent', effects: [{ key: 'quiet', value: true }] },
          { kind: 'flag', short: 'c', long: 'count', effects: [{ key: 'countOnly', value: true }] },
          { kind: 'flag', short: 'l', long: 'files-with-matches', effects: [{ key: 'filesWithMatches', value: true }] },
          { kind: 'flag', short: 'L', long: 'files-without-match', effects: [{ key: 'filesWithoutMatches', value: true }] },
          { kind: 'flag', short: 'o', long: 'only-matching', effects: [{ key: 'onlyMatching', value: true }] },
          { kind: 'flag', short: 'h', long: 'no-filename', effects: [{ key: 'noFilename', value: true }] },
          { kind: 'flag', short: 'H', long: 'with-filename', effects: [{ key: 'withFilename', value: true }] },
          { kind: 'value', short: 'A', long: 'after-context', key: 'afterContext', valueName: 'lines', allowAttachedValue: true, parseValue: undefined },
          { kind: 'value', short: 'B', long: 'before-context', key: 'beforeContext', valueName: 'lines', allowAttachedValue: true, parseValue: undefined },
          { kind: 'value', short: 'C', long: 'context', key: 'context', valueName: 'lines', allowAttachedValue: true, parseValue: undefined },
          { kind: 'value', short: 'm', long: 'max-count', key: 'maxCount', valueName: 'num', allowAttachedValue: true, parseValue: undefined },
          { kind: 'value', short: 'e', long: 'regexp', key: 'regexp', valueName: 'pattern', allowAttachedValue: true, parseValue: undefined },
          { kind: 'value', short: 'f', long: 'file', key: 'patternFile', valueName: 'file', allowAttachedValue: true, parseValue: undefined },
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
    const inlinePatterns = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => isValueOccurrenceForKey(occurrence, 'regexp'))
      .map((occurrence) => occurrence.value)
      .filter((value): value is string => typeof value === 'string');

    const patternFiles = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => isValueOccurrenceForKey(occurrence, 'patternFile'))
      .map((occurrence) => occurrence.value)
      .filter((value): value is string => typeof value === 'string');

    const patterns = [...inlinePatterns];
    for (const patternFile of patternFiles) {
      try {
        patterns.push(...await readPatternFile({ context, path: patternFile }));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `grep: ${patternFile}: ${message}\n` });
        return { exitCode: 2 };
      }
    }

    const files = [...parsed.positionals];
    if (patterns.length === 0) {
      const implicitPattern = files.shift();
      if (implicitPattern === undefined) {
        await writeCommandUsageError({
          context,
          command: 'grep',
          message: 'grep: missing pattern operand',
        });
        return { exitCode: 1 };
      }
      patterns.push(implicitPattern);
    }

    const exactLine = parsed.optionValues.exactLine === true;
    const ignoreCase = parsed.optionValues.ignoreCase === true;
    const fixedStrings = parsed.optionValues.fixedStrings === true;
    const wordRegexp = parsed.optionValues.wordRegexp === true;

    let regex: RegExp;
    let globalRegex: RegExp;
    try {
      regex = buildGrepRegex({
        patterns,
        fixedStrings,
        wordRegexp,
        ignoreCase,
        exactLine,
        global: false,
      });
      globalRegex = buildGrepRegex({
        patterns,
        fixedStrings,
        wordRegexp,
        ignoreCase,
        exactLine,
        global: true,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await text.error({ text: `grep: ${message}\n` });
      return { exitCode: 2 };
    }

    const before = Number(parsed.optionValues.beforeContext ?? parsed.optionValues.context ?? 0) || 0;
    const after = Number(parsed.optionValues.afterContext ?? parsed.optionValues.context ?? 0) || 0;
    const quiet = parsed.optionValues.quiet === true;
    const noMessages = parsed.optionValues.noMessages === true;
    const maxCount = Number(parsed.optionValues.maxCount ?? Number.POSITIVE_INFINITY);
    let outputMode: GrepOutputMode = 'lines';
    let filenameMode: 'auto' | 'always' | 'never' = 'auto';
    for (const occurrence of parsed.occurrences) {
      if (occurrence.kind !== 'flag') continue;
      for (const effect of occurrence.effects) {
        if (effect.key === 'countOnly') outputMode = 'count';
        if (effect.key === 'filesWithMatches') outputMode = 'files-with-matches';
        if (effect.key === 'filesWithoutMatches') outputMode = 'files-without-match';
        if (effect.key === 'onlyMatching') outputMode = 'only-matching';
        if (effect.key === 'noFilename') filenameMode = 'never';
        if (effect.key === 'withFilename') filenameMode = 'always';
      }
    }
    const showFilename = filenameMode === 'never'
      ? false
      : filenameMode === 'always' || files.length > 1;
    let sawMatch = false;
    let sawError = false;

    const processStream = async ({
      stream,
      name,
    }: {
      stream: ReadableStream<Uint8Array>;
      name?: string;
    }): Promise<GrepFileReport> => {
      const decoder = new TextDecoder();
      let buffer = '';
      const reader = stream.getReader();
      const allLines: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (parsed.optionValues.binaryWithoutMatch === true) {
          const isBinary = value.some(byte => byte === 0);
          if (isBinary) {
            return {
              matched: false,
              selectedLineCount: 0,
              outputLines: [],
            };
          }
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        allLines.push(...lines);
      }
      if (buffer) allLines.push(buffer);

      const matches = new Array(allLines.length).fill(false);
      for (let i = 0; i < allLines.length; i++) {
        regex.lastIndex = 0;
        const match = regex.test(allLines[i]!);
        matches[i] = parsed.optionValues.invertMatch === true ? !match : match;
      }

      const outputLines: string[] = [];
      let selectedLineCount = 0;
      let matched = false;
      let lastPrintedIndex = -1;

      for (let i = 0; i < allLines.length; i++) {
        if (matches[i]) {
          matched = true;
          selectedLineCount++;

          if (selectedLineCount > maxCount) {
            break;
          }

          if (quiet) {
            break;
          }

          if (outputMode === 'files-with-matches') {
            if (name !== undefined) {
              outputLines.push(`${name}\n`);
            }
            break;
          }

          if (outputMode === 'files-without-match') {
            continue;
          }

          if (outputMode === 'count') {
            continue;
          }

          if (outputMode === 'only-matching') {
            const line = allLines[i]!;
            globalRegex.lastIndex = 0;
            for (const match of line.matchAll(globalRegex)) {
              const matchedText = match[0];
              if (matchedText === undefined || matchedText.length === 0) continue;
              let output = '';
              if (name !== undefined && showFilename) output += `${name}:`;
              if (parsed.optionValues.lineNumber === true) output += `${i + 1}:`;
              output += `${matchedText}\n`;
              outputLines.push(output);
            }
            if (selectedLineCount >= maxCount) {
              break;
            }
            continue;
          }

          const start = Math.max(0, i - before);
          const end = Math.min(allLines.length - 1, i + after);

          for (let j = start; j <= end; j++) {
            if (j <= lastPrintedIndex) continue;

            let output = '';
            if (name !== undefined && showFilename) output += `${name}:`;
            if (parsed.optionValues.lineNumber === true) output += `${j + 1}:`;
            output += allLines[j] + '\n';
            outputLines.push(output);
            lastPrintedIndex = j;
          }
        }
      }

      if (outputMode === 'count') {
        let output = '';
        if (name !== undefined && showFilename) output += `${name}:`;
        output += `${Math.min(selectedLineCount, maxCount)}\n`;
        outputLines.push(output);
      }

      if (outputMode === 'files-without-match' && !matched && name !== undefined) {
        let output = '';
        if (showFilename) {
          output += `${name}\n`;
        } else {
          output += `${name}\n`;
        }
        outputLines.push(output);
      }

      return {
        matched,
        selectedLineCount,
        outputLines,
      };
    };

    const inputFiles = files.length === 0 ? ['-'] : files;

    for (const file of inputFiles) {
      const displayName = file === '-' ? '(standard input)' : file;
      try {
        const stream = file === '-'
          ? new ReadableStream<Uint8Array>({
            async pull(controller) {
              const buf = new Uint8Array(4096);
              const { bytesRead } = await context.stdin.read({ buffer: buf });
              if (bytesRead === 0) {
                controller.close();
                return;
              }
              controller.enqueue(buf.subarray(0, bytesRead));
            }
          })
          : await (async () => {
            const fullPath = file.startsWith('/') ? file : `${context.cwd}/${file}`;
            const handle = await context.kernel.open({
              path: fullPath,
              flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' }
            });
            return handleToStream({ handle });
          })();

        const report = await processStream({
          stream,
          name: displayName,
        });

        if (report.matched) {
          sawMatch = true;
        }

        if (!quiet) {
          for (const outputLine of report.outputLines) {
            await text.print({ text: outputLine });
          }
        }

        if (quiet && report.matched) {
          break;
        }
      } catch (e: unknown) {
        sawError = true;
        if (file === undefined) continue;
        const message = e instanceof Error ? e.message : String(e);
        if (!noMessages) {
          await text.error({ text: `grep: ${file}: ${message}\n` });
        }
      }
    }

    if (sawError) {
      return { exitCode: 2 };
    }

    return { exitCode: sawMatch ? 0 : 1 };
  },
};
