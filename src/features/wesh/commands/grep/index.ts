import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshEntryRef } from '@/features/wesh/types';
import { parseStandardArgv } from '@/features/wesh/argv';
import type { ArgvOptionOccurrence } from '@/features/wesh/argv';
import type { StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { openFileReadStream, openHandleReadStream, readAllFileBytes } from '@/features/wesh/utils/fs';
import { createBufferedTextWriter } from '@/features/wesh/utils/io';
import { iterateUtf8Lines } from '@/features/wesh/utils/text-records';

interface GrepFileReport {
  matched: boolean,
  selectedLineCount: number,
  outputLines: string[],
}

type GrepOutputMode = 'lines' | 'count' | 'files-with-matches' | 'files-without-match' | 'only-matching';
type GrepPatternSyntax = 'basic' | 'extended' | 'perl' | 'fixed';

function resolvePath({ cwd, path }: { cwd: string, path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }

  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
}

function asDirectoryEntryRef({
  entry,
}: {
  entry: WeshEntryRef,
}): WeshEntryRef<'directory'> {
  switch (entry.type) {
  case 'directory':
    return entry as WeshEntryRef<'directory'>;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`Not a directory: ${entry.fullPath}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled entry type: ${_ex}`);
  }
  }
}

function basename({ path }: { path: string }): string {
  if (path === '/') return '/';
  const normalized = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? normalized;
}

function isValueOccurrenceForKey(
  occurrence: ArgvOptionOccurrence,
  key: string,
): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> {
  return occurrence.kind === 'value' && occurrence.key === key;
}

function escapeRegExp({ value }: { value: string }): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function globToRegExp({ pattern }: { pattern: string }): RegExp {
  let source = '^';

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === undefined) continue;

    if (char === '*') {
      source += '.*';
      continue;
    }

    if (char === '?') {
      source += '.';
      continue;
    }

    if (char === '[') {
      const endIndex = pattern.indexOf(']', index + 1);
      if (endIndex > index) {
        source += pattern.slice(index, endIndex + 1);
        index = endIndex;
        continue;
      }
    }

    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  source += '$';
  return new RegExp(source);
}

function convertBREPattern({ pattern }: { pattern: string }): string {
  let result = '';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (char === '[') {
      // Pass through character classes unchanged
      result += char;
      i++;
      // Handle negation and leading ] inside class
      if (i < pattern.length && pattern[i] === '^') {
        result += pattern[i++]!;
      }
      if (i < pattern.length && pattern[i] === ']') {
        result += pattern[i++]!;
      }
      while (i < pattern.length && pattern[i] !== ']') {
        result += pattern[i++]!;
      }
      if (i < pattern.length) {
        result += pattern[i++]!;
      } // closing ]
    } else if (char === '\\' && i + 1 < pattern.length) {
      const next = pattern[i + 1]!;
      switch (next) {
      case '|': result += '|'; i += 2; break;
      case '(': result += '('; i += 2; break;
      case ')': result += ')'; i += 2; break;
      case '{': result += '{'; i += 2; break;
      case '}': result += '}'; i += 2; break;
      case '+': result += '+'; i += 2; break;
      case '?': result += '?'; i += 2; break;
      default:  result += char + next; i += 2; break;
      }
    } else {
      result += char;
      i++;
    }
  }
  return result;
}

function resolveGrepPatternSyntax({
  occurrences,
}: {
  occurrences: ArgvOptionOccurrence[],
}): GrepPatternSyntax {
  let syntax: GrepPatternSyntax = 'basic';

  for (const occurrence of occurrences) {
    switch (occurrence.kind) {
    case 'flag':
      break;
    case 'value':
    case 'special':
      continue;
    default: {
      const _ex: never = occurrence;
      throw new Error(`Unhandled occurrence kind: ${_ex}`);
    }
    }

    for (const effect of occurrence.effects) {
      switch (effect.key) {
      case 'extendedRegexp':
        syntax = 'extended';
        break;
      case 'basicRegexp':
        syntax = 'basic';
        break;
      case 'perlRegexp':
        syntax = 'perl';
        break;
      case 'fixedStrings':
        syntax = 'fixed';
        break;
      default:
        break;
      }
    }
  }

  return syntax;
}

function buildGrepRegex({
  patterns,
  syntax,
  wordRegexp,
  ignoreCase,
  exactLine,
  global,
}: {
  patterns: string[],
  syntax: GrepPatternSyntax,
  wordRegexp: boolean,
  ignoreCase: boolean,
  exactLine: boolean,
  global: boolean,
}): RegExp {
  const source = patterns
    .map((pattern) => {
      switch (syntax) {
      case 'fixed':
        return escapeRegExp({ value: pattern });
      case 'basic':
        return convertBREPattern({ pattern });
      case 'extended':
      case 'perl':
        return pattern;
      default: {
        const _ex: never = syntax;
        throw new Error(`Unhandled grep pattern syntax: ${_ex}`);
      }
      }
    })
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
  context: WeshCommandContext,
  path: string,
}): Promise<string[]> {
  const fullPath = resolvePath({ cwd: context.cwd, path });
  const bytes = await readAllFileBytes({ files: context.files, path: fullPath });
  const content = new TextDecoder().decode(bytes);
  return content.split(/\r?\n/).filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

async function openGrepInputStream({
  context,
  file,
  entry,
}: {
  context: WeshCommandContext,
  file: string,
  entry?: WeshEntryRef,
}): Promise<ReadableStream<Uint8Array>> {
  if (file === '-') {
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const buffer = new Uint8Array(64 * 1024);
        const { bytesRead } = await context.stdin.read({ buffer });
        if (bytesRead === 0) {
          controller.close();
          return;
        }
        controller.enqueue(bytesRead === buffer.byteLength ? buffer : buffer.subarray(0, bytesRead));
      },
    });
  }

  if (entry !== undefined) {
    const handle = await context.files.openEntry({
      entry,
      flags: {
        access: 'read',
        creation: 'never',
        truncate: 'preserve',
        append: 'preserve',
      },
    });
    return openHandleReadStream({ handle });
  }

  return await openFileReadStream({
    files: context.files,
    path: resolvePath({ cwd: context.cwd, path: file }),
  });
}

async function* iterateGrepInputChunks({
  stream,
  binaryWithoutMatch,
  state,
}: {
  stream: ReadableStream<Uint8Array>,
  binaryWithoutMatch: boolean,
  state: { skippedBinary: boolean },
}): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  let reachedEnd = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reachedEnd = true;
        return;
      }

      if (binaryWithoutMatch && value.includes(0)) {
        state.skippedBinary = true;
        return;
      }

      yield value;
    }
  } finally {
    if (!reachedEnd) {
      await reader.cancel();
    }
    reader.releaseLock();
  }
}

export const grepCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'grep',
    description: 'Search for patterns in files',
    usage: 'grep [OPTION]... PATTERNS [FILE]...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const grepArgvSpec: StandardArgvParserSpec = {
      options: [
        { kind: 'flag', short: 'E', long: 'extended-regexp', effects: [{ key: 'extendedRegexp', value: true }], help: { summary: 'use extended regular expressions', category: 'common' } },
        { kind: 'flag', short: 'G', long: 'basic-regexp', effects: [{ key: 'basicRegexp', value: true }], help: { summary: 'use basic regular expressions', category: 'advanced' } },
        { kind: 'flag', short: 'P', long: 'perl-regexp', effects: [{ key: 'perlRegexp', value: true }], help: { summary: 'use Perl-compatible regular expressions', category: 'advanced' } },
        { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
        { kind: 'flag', short: 'i', long: 'ignore-case', effects: [{ key: 'ignoreCase', value: true }], help: { summary: 'ignore case distinctions', category: 'common' } },
        { kind: 'flag', short: 'v', long: 'invert-match', effects: [{ key: 'invertMatch', value: true }], help: { summary: 'select non-matching lines', category: 'common' } },
        { kind: 'flag', short: 'n', long: 'line-number', effects: [{ key: 'lineNumber', value: true }], help: { summary: 'print line numbers', category: 'common' } },
        { kind: 'flag', short: 'w', long: 'word-regexp', effects: [{ key: 'wordRegexp', value: true }], help: { summary: 'match only whole words', category: 'advanced' } },
        { kind: 'flag', short: 'x', long: 'line-regexp', effects: [{ key: 'exactLine', value: true }], help: { summary: 'match only whole lines', category: 'advanced' } },
        { kind: 'flag', short: 'F', long: 'fixed-strings', effects: [{ key: 'fixedStrings', value: true }], help: { summary: 'treat patterns as literal strings', category: 'common' } },
        { kind: 'flag', short: 'I', long: 'binary-files', effects: [{ key: 'binaryWithoutMatch', value: true }], help: { summary: 'ignore binary file matches', category: 'advanced' } },
        { kind: 'flag', short: 's', long: 'no-messages', effects: [{ key: 'noMessages', value: true }], help: { summary: 'suppress error messages', category: 'advanced' } },
        { kind: 'flag', short: 'q', long: 'quiet', effects: [{ key: 'quiet', value: true }], help: { summary: 'suppress normal output', category: 'common' } },
        { kind: 'flag', short: undefined, long: 'silent', effects: [{ key: 'quiet', value: true }], help: { summary: 'same as --quiet', category: 'advanced' } },
        { kind: 'flag', short: 'c', long: 'count', effects: [{ key: 'countOnly', value: true }], help: { summary: 'print only a count of matching lines', category: 'common' } },
        { kind: 'flag', short: 'l', long: 'files-with-matches', effects: [{ key: 'filesWithMatches', value: true }], help: { summary: 'print only names of matching files', category: 'common' } },
        { kind: 'flag', short: 'L', long: 'files-without-match', effects: [{ key: 'filesWithoutMatches', value: true }], help: { summary: 'print only names of files without matches', category: 'advanced' } },
        { kind: 'flag', short: 'o', long: 'only-matching', effects: [{ key: 'onlyMatching', value: true }], help: { summary: 'print only matched text', category: 'advanced' } },
        { kind: 'flag', short: 'h', long: 'no-filename', effects: [{ key: 'noFilename', value: true }], help: { summary: 'suppress file name prefixes', category: 'advanced' } },
        { kind: 'flag', short: 'H', long: 'with-filename', effects: [{ key: 'withFilename', value: true }], help: { summary: 'always print file name prefixes', category: 'advanced' } },
        { kind: 'flag', short: 'r', long: 'recursive', effects: [{ key: 'recursive', value: true }], help: { summary: 'search directories recursively', category: 'common' } },
        { kind: 'flag', short: 'R', long: 'dereference-recursive', effects: [{ key: 'recursive', value: true }], help: { summary: 'search directories recursively', category: 'advanced' } },
        { kind: 'value', short: 'A', long: 'after-context', key: 'afterContext', valueName: 'lines', allowAttachedValue: true, parseValue: undefined, help: { summary: 'print NUM trailing context lines', valueName: 'NUM', category: 'advanced' } },
        { kind: 'value', short: 'B', long: 'before-context', key: 'beforeContext', valueName: 'lines', allowAttachedValue: true, parseValue: undefined, help: { summary: 'print NUM leading context lines', valueName: 'NUM', category: 'advanced' } },
        { kind: 'value', short: 'C', long: 'context', key: 'context', valueName: 'lines', allowAttachedValue: true, parseValue: undefined, help: { summary: 'print NUM context lines', valueName: 'NUM', category: 'common' } },
        { kind: 'value', short: 'm', long: 'max-count', key: 'maxCount', valueName: 'num', allowAttachedValue: true, parseValue: undefined, help: { summary: 'stop after NUM selected lines', valueName: 'NUM', category: 'advanced' } },
        { kind: 'value', short: 'e', long: 'regexp', key: 'regexp', valueName: 'pattern', allowAttachedValue: true, parseValue: undefined, help: { summary: 'add a pattern', valueName: 'PATTERN', category: 'common' } },
        { kind: 'value', short: 'f', long: 'file', key: 'patternFile', valueName: 'file', allowAttachedValue: true, parseValue: undefined, help: { summary: 'read patterns from file', valueName: 'FILE', category: 'common' } },
        { kind: 'value', short: undefined, long: 'include', key: 'include', valueName: 'glob', allowAttachedValue: false, parseValue: undefined, help: { summary: 'search only files matching GLOB', valueName: 'GLOB', category: 'advanced' } },
        { kind: 'value', short: undefined, long: 'exclude', key: 'exclude', valueName: 'glob', allowAttachedValue: false, parseValue: undefined, help: { summary: 'skip files matching GLOB', valueName: 'GLOB', category: 'advanced' } },
      ],
      allowShortFlagBundles: true,
      stopAtDoubleDash: true,
      treatSingleDashAsPositional: true,
      specialTokenParsers: [],
    };

    const parsed = parseStandardArgv({
      args: context.args,
      spec: grepArgvSpec,
    });

    if (parsed.diagnostics.length > 0) {
      await writeCommandUsageError({
        context,
        command: 'grep',
        message: `grep: ${parsed.diagnostics[0]!.message}`,
        argvSpec: grepArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'grep',
        argvSpec: grepArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const bufferedStdout = createBufferedTextWriter({
      handle: context.stdout,
      maxBufferLength: 16384,
    });
    const inlinePatterns = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => isValueOccurrenceForKey(occurrence, 'regexp'))
      .map((occurrence) => occurrence.value)
      .filter((value): value is string => typeof value === 'string');

    const patternFiles = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => isValueOccurrenceForKey(occurrence, 'patternFile'))
      .map((occurrence) => occurrence.value)
      .filter((value): value is string => typeof value === 'string');
    const includeGlobs = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => isValueOccurrenceForKey(occurrence, 'include'))
      .map((occurrence) => occurrence.value)
      .filter((value): value is string => typeof value === 'string');
    const excludeGlobs = parsed.occurrences
      .filter((occurrence): occurrence is Extract<ArgvOptionOccurrence, { kind: 'value' }> => isValueOccurrenceForKey(occurrence, 'exclude'))
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
          argvSpec: grepArgvSpec,
        });
        return { exitCode: 1 };
      }
      patterns.push(implicitPattern);
    }

    const exactLine = parsed.optionValues.exactLine === true;
    const ignoreCase = parsed.optionValues.ignoreCase === true;
    const wordRegexp = parsed.optionValues.wordRegexp === true;
    const syntax = resolveGrepPatternSyntax({
      occurrences: parsed.occurrences,
    });

    let regex: RegExp;
    let globalRegex: RegExp;
    try {
      regex = buildGrepRegex({
        patterns,
        syntax,
        wordRegexp,
        ignoreCase,
        exactLine,
        global: false,
      });
      globalRegex = buildGrepRegex({
        patterns,
        syntax,
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
    const recursive = parsed.optionValues.recursive === true;
    const maxCount = Number(parsed.optionValues.maxCount ?? Number.POSITIVE_INFINITY);
    const includePatterns = includeGlobs.map((pattern) => globToRegExp({ pattern }));
    const excludePatterns = excludeGlobs.map((pattern) => globToRegExp({ pattern }));
    let outputMode: GrepOutputMode = 'lines';
    let filenameMode: 'auto' | 'always' | 'never' = 'auto';
    for (const occurrence of parsed.occurrences) {
      switch (occurrence.kind) {
      case 'flag':
        break;
      case 'value':
      case 'special':
        continue;
      default: {
        const _ex: never = occurrence;
        throw new Error(`Unhandled occurrence kind: ${_ex}`);
      }
      }
      for (const effect of occurrence.effects) {
        if (effect.key === 'countOnly') outputMode = 'count';
        if (effect.key === 'filesWithMatches') outputMode = 'files-with-matches';
        if (effect.key === 'filesWithoutMatches') outputMode = 'files-without-match';
        if (effect.key === 'onlyMatching') outputMode = 'only-matching';
        if (effect.key === 'noFilename') filenameMode = 'never';
        if (effect.key === 'withFilename') filenameMode = 'always';
      }
    }
    const showFilename = (() => {
      switch (filenameMode) {
      case 'never':
        return false;
      case 'always':
        return true;
      case 'auto':
        return recursive || files.length > 1;
      default: {
        const _ex: never = filenameMode;
        throw new Error(`Unhandled filename mode: ${_ex}`);
      }
      }
    })();
    let sawMatch = false;
    let sawError = false;

    const shouldSearchFile = ({ displayPath }: { displayPath: string }): boolean => {
      const name = basename({ path: displayPath });
      if (includePatterns.length > 0 && !includePatterns.some((pattern) => pattern.test(name))) {
        return false;
      }
      if (excludePatterns.some((pattern) => pattern.test(name))) {
        return false;
      }
      return true;
    };

    interface ContextLine {
      line: string,
      lineNumber: number,
      selected: boolean,
    }

    class ContextLineRing {
      private readonly capacity: number;
      private readonly values: Array<ContextLine | undefined>;
      private count = 0;
      private nextIndex = 0;

      constructor({ capacity }: { capacity: number }) {
        this.capacity = capacity;
        this.values = new Array<ContextLine | undefined>(capacity);
      }

      push({ value }: { value: ContextLine }): void {
        if (this.capacity === 0) {
          return;
        }
        this.values[this.nextIndex] = value;
        this.nextIndex = (this.nextIndex + 1) % this.capacity;
        this.count = Math.min(this.count + 1, this.capacity);
      }

      valuesAfter({ lineNumber }: { lineNumber: number }): ContextLine[] {
        const result: ContextLine[] = [];
        if (this.count === 0) {
          return result;
        }
        const startIndex = (this.nextIndex - this.count + this.capacity) % this.capacity;
        for (let offset = 0; offset < this.count; offset += 1) {
          const value = this.values[(startIndex + offset) % this.capacity];
          if (value !== undefined && value.lineNumber > lineNumber) {
            result.push(value);
          }
        }
        return result;
      }
    }

    const writeReportedLine = async ({
      line,
      lineNumber,
      selected,
      name,
    }: {
      line: string,
      lineNumber: number,
      selected: boolean,
      name?: string,
    }): Promise<void> => {
      const separator = selected ? ':' : '-';
      let output = '';
      if (name !== undefined && showFilename) output += `${name}${separator}`;
      if (parsed.optionValues.lineNumber === true) output += `${lineNumber}${separator}`;
      output += `${line}\n`;
      await bufferedStdout.write({ text: output });
    };

    const processStream = async ({
      stream,
      name,
    }: {
      stream: ReadableStream<Uint8Array>,
      name?: string,
    }): Promise<GrepFileReport> => {
      const state = {
        matched: false,
        selectedLineCount: 0,
      };
      const binaryState = { skippedBinary: false };
      const previousLines = new ContextLineRing({ capacity: before });
      let lineNumber = 0;
      let remainingAfterLines = 0;
      let lastPrintedLineNumber = 0;
      let printedAnyGroup = false;
      let stop = false;

      const writeContextGroupSeparatorIfNeeded = async ({
        firstLineNumber,
      }: {
        firstLineNumber: number,
      }): Promise<void> => {
        if (
          (before > 0 || after > 0)
          && printedAnyGroup
          && firstLineNumber > lastPrintedLineNumber + 1
        ) {
          await bufferedStdout.write({ text: '--\n' });
        }
      };

      const rememberLine = ({ contextLine }: { contextLine: ContextLine }): void => {
        previousLines.push({ value: contextLine });
      };

      const chunks = iterateGrepInputChunks({
        stream,
        binaryWithoutMatch: parsed.optionValues.binaryWithoutMatch === true,
        state: binaryState,
      });

      for await (const line of iterateUtf8Lines({ chunks })) {
        lineNumber += 1;
        regex.lastIndex = 0;
        const regexMatched = regex.test(line);
        const selected = parsed.optionValues.invertMatch === true ? !regexMatched : regexMatched;
        const contextLine: ContextLine = { line, lineNumber, selected };

        if (selected && state.selectedLineCount < maxCount) {
          state.matched = true;
          state.selectedLineCount += 1;

          if (quiet) {
            stop = true;
          } else {
            switch (outputMode) {
            case 'count':
            case 'files-without-match':
              stop = state.selectedLineCount >= maxCount;
              break;
            case 'files-with-matches':
              if (name !== undefined) {
                await bufferedStdout.write({ text: `${name}\n` });
              }
              stop = true;
              break;
            case 'only-matching': {
              globalRegex.lastIndex = 0;
              for (const match of line.matchAll(globalRegex)) {
                const matchedText = match[0];
                if (matchedText.length === 0) continue;
                let output = '';
                if (name !== undefined && showFilename) output += `${name}:`;
                if (parsed.optionValues.lineNumber === true) output += `${lineNumber}:`;
                output += `${matchedText}\n`;
                await bufferedStdout.write({ text: output });
              }
              stop = state.selectedLineCount >= maxCount;
              break;
            }
            case 'lines': {
              const unprintedPreviousLines = previousLines.valuesAfter({
                lineNumber: lastPrintedLineNumber,
              });
              const firstLineNumber = unprintedPreviousLines[0]?.lineNumber ?? lineNumber;
              await writeContextGroupSeparatorIfNeeded({ firstLineNumber });
              for (const previousLine of unprintedPreviousLines) {
                await writeReportedLine({
                  ...previousLine,
                  name,
                });
                lastPrintedLineNumber = previousLine.lineNumber;
              }
              if (lineNumber > lastPrintedLineNumber) {
                await writeReportedLine({
                  line,
                  lineNumber,
                  selected: true,
                  name,
                });
                lastPrintedLineNumber = lineNumber;
              }
              printedAnyGroup = true;
              remainingAfterLines = after;
              stop = state.selectedLineCount >= maxCount && remainingAfterLines === 0;
              break;
            }
            default: {
              const _ex: never = outputMode;
              throw new Error(`Unhandled output mode: ${_ex}`);
            }
            }
          }
        } else if (outputMode === 'lines' && remainingAfterLines > 0) {
          if (lineNumber > lastPrintedLineNumber) {
            await writeReportedLine({
              line,
              lineNumber,
              selected,
              name,
            });
            lastPrintedLineNumber = lineNumber;
          }
          printedAnyGroup = true;
          remainingAfterLines -= 1;
          if (state.selectedLineCount >= maxCount && remainingAfterLines === 0) {
            stop = true;
          }
        } else if (selected && state.selectedLineCount >= maxCount) {
          stop = true;
        }

        rememberLine({ contextLine });
        if (stop) break;
      }

      if (binaryState.skippedBinary) {
        return {
          matched: false,
          selectedLineCount: 0,
          outputLines: [],
        };
      }

      if (!quiet) {
        switch (outputMode) {
        case 'count': {
          let output = '';
          if (name !== undefined && showFilename) output += `${name}:`;
          output += `${Math.min(state.selectedLineCount, maxCount)}\n`;
          await bufferedStdout.write({ text: output });
          break;
        }
        case 'files-without-match':
          if (!state.matched && name !== undefined) {
            await bufferedStdout.write({ text: `${name}\n` });
          }
          break;
        case 'lines':
        case 'files-with-matches':
        case 'only-matching':
          break;
        default: {
          const _ex: never = outputMode;
          throw new Error(`Unhandled output mode: ${_ex}`);
        }
        }
      }

      return {
        matched: state.matched,
        selectedLineCount: state.selectedLineCount,
        outputLines: [],
      };
    };

    const searchFile = async ({
      entry,
      file,
      displayName,
    }: {
      entry?: WeshEntryRef,
      file: string,
      displayName: string,
    }): Promise<boolean> => {
      const stream = await openGrepInputStream({
        context,
        file,
        entry,
      });
      const report = await processStream({
        stream,
        name: displayName,
      });
      if (report.matched) {
        sawMatch = true;
      }
      return quiet && report.matched;
    };

    const searchEntry = async ({
      entry,
      displayName,
    }: {
      entry: WeshEntryRef,
      displayName: string,
    }): Promise<boolean> => {
      switch (entry.type) {
      case 'directory':
        if (!recursive) {
          throw new Error('Is a directory');
        }
        for await (const child of context.files.readDirEntry({ entry: asDirectoryEntryRef({ entry }) })) {
          const childDisplayName = displayName === '/'
            ? `/${child.name}`
            : `${displayName}/${child.name}`;
          if (child.type !== 'directory' && !shouldSearchFile({ displayPath: childDisplayName })) {
            continue;
          }
          if (await searchEntry({ entry: child, displayName: childDisplayName })) {
            return true;
          }
        }
        return false;
      case 'file':
      case 'symlink':
      case 'fifo':
      case 'chardev':
        if (!shouldSearchFile({ displayPath: displayName })) {
          return false;
        }
        return searchFile({
          entry,
          file: entry.fullPath,
          displayName,
        });
      default: {
        const _ex: never = entry;
        throw new Error(`Unhandled entry type: ${_ex}`);
      }
      }
    };

    const directEntryRefs = new Map<string, WeshEntryRef[]>();
    for (let index = 0; index < context.args.length; index += 1) {
      const entryRef = context.getArgumentEntryRef({ index });
      if (entryRef === undefined) {
        continue;
      }
      const argument = context.args[index];
      if (argument === undefined) {
        continue;
      }
      const refs = directEntryRefs.get(argument) ?? [];
      refs.push(entryRef);
      directEntryRefs.set(argument, refs);
    }

    const inputFiles = files.length === 0 ? ['-'] : files;
    for (const file of inputFiles) {
      const displayName = file === '-' ? '(standard input)' : file;
      try {
        const directRefs = directEntryRefs.get(file);
        const directEntryRef = directRefs?.shift();
        const stop = file === '-'
          ? await searchFile({ file, displayName })
          : await searchEntry({
            entry: directEntryRef ?? await context.files.resolveEntry({
              path: resolvePath({ cwd: context.cwd, path: file }),
              finalSymlinkTreatment: 'follow',
            }),
            displayName,
          });
        if (stop) break;
      } catch (error: unknown) {
        sawError = true;
        const message = error instanceof Error ? error.message : String(error);
        if (!noMessages) {
          await text.error({ text: `grep: ${file}: ${message}\n` });
        }
      }
    }

    await bufferedStdout.flush();

    if (sawError) {
      return { exitCode: 2 };
    }

    return { exitCode: sawMatch ? 0 : 1 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
