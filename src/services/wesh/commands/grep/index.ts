import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/services/wesh/types';
import { parseStandardArgv } from '@/services/wesh/argv';
import type { ArgvOptionOccurrence } from '@/services/wesh/argv';
import type { StandardArgvParserSpec } from '@/services/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/services/wesh/commands/_shared/usage';
import { handleToStream, readFile } from '@/services/wesh/utils/fs';

interface GrepFileReport {
  matched: boolean;
  selectedLineCount: number;
  outputLines: string[];
}

type GrepOutputMode = 'lines' | 'count' | 'files-with-matches' | 'files-without-match' | 'only-matching';
type GrepPatternSyntax = 'basic' | 'extended' | 'perl' | 'fixed';

function resolvePath({ cwd, path }: { cwd: string; path: string }): string {
  if (path.startsWith('/')) {
    return path;
  }

  return cwd === '/' ? `/${path}` : `${cwd}/${path}`;
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
  occurrences: ArgvOptionOccurrence[];
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
  patterns: string[];
  syntax: GrepPatternSyntax;
  wordRegexp: boolean;
  ignoreCase: boolean;
  exactLine: boolean;
  global: boolean;
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
  context: WeshCommandContext;
  path: string;
}): Promise<string[]> {
  const fullPath = resolvePath({ cwd: context.cwd, path });
  const bytes = await readFile({ files: context.files, path: fullPath });
  const content = new TextDecoder().decode(bytes);
  return content.split(/\r?\n/).filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
}

async function openGrepInputStream({
  context,
  file,
}: {
  context: WeshCommandContext;
  file: string;
}): Promise<ReadableStream<Uint8Array>> {
  if (file === '-') {
    return new ReadableStream<Uint8Array>({
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
  }

  const path = resolvePath({ cwd: context.cwd, path: file });
  if (context.files.tryReadBlobEfficiently !== undefined) {
    const blobResult = await context.files.tryReadBlobEfficiently({ path });
    switch (blobResult.kind) {
    case 'blob':
      return blobResult.blob.stream() as ReadableStream<Uint8Array>;
    case 'fallback-required':
      break;
    default: {
      const _ex: never = blobResult;
      throw new Error(`Unhandled blob read result: ${JSON.stringify(_ex)}`);
    }
    }
  }

  const handle = await context.files.open({
    path,
    flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
  });
  return handleToStream({ handle });
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

    const processAllLines = ({ allLines, name }: { allLines: string[]; name?: string }): GrepFileReport => {
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

      matchLoop:
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

          switch (outputMode) {
          case 'files-with-matches':
            if (name !== undefined) {
              outputLines.push(`${name}\n`);
            }
            break matchLoop;
          case 'files-without-match':
            continue;
          case 'count':
            continue;
          case 'only-matching': {
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
          case 'lines': {
            const start = Math.max(0, i - before);
            const end = Math.min(allLines.length - 1, i + after);

            if ((before > 0 || after > 0) && lastPrintedIndex >= 0 && start > lastPrintedIndex + 1 && outputLines.length > 0) {
              outputLines.push('--\n');
            }

            for (let j = start; j <= end; j++) {
              if (j <= lastPrintedIndex) continue;

              let output = '';
              const isMatchingLine = matches[j] === true;
              const prefixSeparator = isMatchingLine ? ':' : '-';
              if (name !== undefined && showFilename) output += `${name}${prefixSeparator}`;
              if (parsed.optionValues.lineNumber === true) output += `${j + 1}${prefixSeparator}`;
              output += allLines[j] + '\n';
              outputLines.push(output);
              lastPrintedIndex = j;
            }
            break;
          }
          default: {
            const _ex: never = outputMode;
            throw new Error(`Unhandled output mode: ${_ex}`);
          }
          }
        }
      }

      switch (outputMode) {
      case 'count': {
        let output = '';
        if (name !== undefined && showFilename) output += `${name}:`;
        output += `${Math.min(selectedLineCount, maxCount)}\n`;
        outputLines.push(output);
        break;
      }
      case 'files-without-match':
        if (!matched && name !== undefined) {
          let output = '';
          if (showFilename) {
            output += `${name}\n`;
          } else {
            output += `${name}\n`;
          }
          outputLines.push(output);
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

      return { matched, selectedLineCount, outputLines };
    };

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
            return { matched: false, selectedLineCount: 0, outputLines: [] };
          }
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        allLines.push(...lines);
      }
      if (buffer) allLines.push(buffer);

      return processAllLines({ allLines, name });
    };

    const inputFiles = files.length === 0 ? ['-'] : files;

    const expandedInputs: Array<{ file: string; displayName: string }> = [];
    const enqueueInput = async ({
      file,
      displayName,
    }: {
      file: string;
      displayName: string;
    }) => {
      if (file === '-') {
        expandedInputs.push({ file, displayName });
        return;
      }

      const fullPath = resolvePath({ cwd: context.cwd, path: file });
      const stat = await context.files.stat({ path: fullPath });
      switch (stat.type) {
      case 'directory': {
        if (!recursive) {
          throw new Error('Is a directory');
        }

        const walk = async ({
          fullPath: currentFullPath,
          displayPath,
        }: {
          fullPath: string;
          displayPath: string;
        }) => {
          for await (const entry of context.files.readDir({ path: currentFullPath })) {
            const childFullPath = currentFullPath === '/' ? `/${entry.name}` : `${currentFullPath}/${entry.name}`;
            const childDisplayPath = displayPath === '/' ? `/${entry.name}` : `${displayPath}/${entry.name}`;

            switch (entry.type) {
            case 'directory':
              await walk({ fullPath: childFullPath, displayPath: childDisplayPath });
              continue;
            case 'file':
            case 'symlink':
            case 'fifo':
            case 'chardev':
              break;
            default: {
              const _ex: never = entry.type;
              throw new Error(`Unhandled entry type: ${_ex}`);
            }
            }

            if (!shouldSearchFile({ displayPath: childDisplayPath })) {
              continue;
            }

            expandedInputs.push({ file: childFullPath, displayName: childDisplayPath });
          }
        };

        await walk({ fullPath, displayPath: displayName });
        return;
      }
      case 'file':
      case 'symlink':
      case 'fifo':
      case 'chardev':
        break;
      default: {
        const _ex: never = stat.type;
        throw new Error(`Unhandled stat type: ${_ex}`);
      }
      }

      if (!shouldSearchFile({ displayPath: displayName })) {
        return;
      }

      expandedInputs.push({ file, displayName });
    };

    for (const file of inputFiles) {
      const displayName = file === '-' ? '(standard input)' : file;
      try {
        await enqueueInput({ file, displayName });
      } catch (e: unknown) {
        sawError = true;
        const message = e instanceof Error ? e.message : String(e);
        if (!noMessages) {
          await text.error({ text: `grep: ${file}: ${message}\n` });
        }
      }
    }

    for (const { file, displayName } of expandedInputs) {
      try {
        const stream = await openGrepInputStream({
          context,
          file,
        });
        const report = await processStream({ stream, name: displayName });

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
