import { compileGitBasicRegex, testGitBasicRegex } from '@/features/wesh/commands/git/basic-regex';
import { compileGitExtendedRegex, testGitExtendedRegex } from '@/features/wesh/commands/git/extended-regex';
import { pathExists, readFileBytes } from '@/features/wesh/commands/git/files';
import { readIndex } from '@/features/wesh/commands/git/index-file';
import { matchRepositoryPathSelection } from '@/features/wesh/commands/git/pathspec';
import { discoverRepositoryFromContext } from '@/features/wesh/commands/git/repository';
import { statusPathFromCwd } from '@/features/wesh/commands/git/status-output';
import { worktreeAbsolutePath } from '@/features/wesh/commands/git/worktree';
import type { WeshCommandContext, WeshCommandResult } from '@/features/wesh/types';
import { analyzeArgvShortForm, defineArgvCatalog } from '@/features/wesh/argv-v2';
import { GitUsageError } from '@/features/wesh/commands/git/errors';

const GREP_OUTPUT_FLUSH_THRESHOLD = 64 * 1024;

const GREP_HELP = `\
usage: git grep [<options>] <pattern> [--] [<pathspec>...]

    -n                   show line numbers
    -l                   show only names of files with matches
    -i                   ignore case distinctions
    -F                   interpret the pattern as a fixed string
    -E                   use extended regular expressions
    -A <num>             show trailing context
    -B <num>             show leading context
    -C <num>             show leading and trailing context
`;

 type GrepShortSemantic =
  | 'line-number'
  | 'files-with-matches'
  | 'ignore-case'
  | 'fixed-strings'
  | 'extended-regexp'
  | 'context'
  | 'after-context'
  | 'before-context';

const GREP_SHORT_ARGV_CATALOG = defineArgvCatalog<GrepShortSemantic>({
  nonExecutableLongOptions: [],
  definitions: [
    { semantic: 'line-number', forms: [{ kind: 'short', name: 'n', value: { kind: 'none' } }] },
    { semantic: 'files-with-matches', forms: [{ kind: 'short', name: 'l', value: { kind: 'none' } }] },
    { semantic: 'ignore-case', forms: [{ kind: 'short', name: 'i', value: { kind: 'none' } }] },
    { semantic: 'fixed-strings', forms: [{ kind: 'short', name: 'F', value: { kind: 'none' } }] },
    { semantic: 'extended-regexp', forms: [{ kind: 'short', name: 'E', value: { kind: 'none' } }] },
    { semantic: 'context', forms: [{ kind: 'short', name: 'C', value: { kind: 'required-attached-or-following', missingValueName: 'num' } }] },
    { semantic: 'after-context', forms: [{ kind: 'short', name: 'A', value: { kind: 'required-attached-or-following', missingValueName: 'num' } }] },
    { semantic: 'before-context', forms: [{ kind: 'short', name: 'B', value: { kind: 'required-attached-or-following', missingValueName: 'num' } }] },
  ],
});

interface ParsedGrepArguments {
  pattern: string,
  pathOperands: readonly string[],
  lineNumber: boolean,
  filesWithMatches: boolean,
  ignoreCase: boolean,
  patternMode: 'basic' | 'extended' | 'fixed',
  beforeContext: number,
  afterContext: number,
}

function parseContextCount({ value }: { value: string }): number {
  if (!/^[0-9]+$/u.test(value)) throw new GitUsageError({ message: `invalid context length argument: ${value}` });
  const count = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(count)) throw new GitUsageError({ message: `invalid context length argument: ${value}` });
  return count;
}

function parseGrepArguments({ args }: { args: readonly string[] }): ParsedGrepArguments {
  let lineNumber = false;
  let filesWithMatches = false;
  let ignoreCase = false;
  let patternMode: 'basic' | 'extended' | 'fixed' = 'basic';
  let beforeContext = 0;
  let afterContext = 0;
  let optionTerminated = false;
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!optionTerminated && arg === '--') {
      optionTerminated = true;
      continue;
    }
    if (!optionTerminated && arg.startsWith('-') && !arg.startsWith('--') && arg.length > 1) {
      let bodyOffset = 1;
      while (bodyOffset < arg.length) {
        const analysis = analyzeArgvShortForm({ token: arg, bodyOffset, prefix: '-', catalog: GREP_SHORT_ARGV_CATALOG });
        switch (analysis.kind) {
        case 'unknown':
          throw new GitUsageError({ message: `unknown option: ${arg}` });
        case 'matched':
          break;
        default: {
          const _ex: never = analysis;
          throw new Error(`Unhandled grep argv analysis: ${JSON.stringify(_ex)}`);
        }
        }
        switch (analysis.semantic) {
        case 'line-number':
          lineNumber = true;
          break;
        case 'files-with-matches':
          filesWithMatches = true;
          break;
        case 'ignore-case':
          ignoreCase = true;
          break;
        case 'fixed-strings':
          patternMode = 'fixed';
          break;
        case 'extended-regexp':
          patternMode = 'extended';
          break;
        case 'context':
        case 'after-context':
        case 'before-context': {
          const rawValue = (() => {
            switch (analysis.value.kind) {
            case 'inline':
              return analysis.value.rawValue;
            case 'following-required': {
              const value = args[index + 1];
              if (value === undefined) throw new GitUsageError({ message: `option '${analysis.option}' requires a value` });
              index += 1;
              return value;
            }
            case 'none':
            case 'following-optional':
              throw new Error(`Grep ${analysis.option} produced invalid value claim: ${analysis.value.kind}`);
            default: {
              const _ex: never = analysis.value;
              throw new Error(`Unhandled grep value claim: ${JSON.stringify(_ex)}`);
            }
            }
          })();
          const count = parseContextCount({ value: rawValue });
          switch (analysis.semantic) {
          case 'context':
            beforeContext = count;
            afterContext = count;
            break;
          case 'after-context':
            afterContext = count;
            break;
          case 'before-context':
            beforeContext = count;
            break;
          default: {
            const _ex: never = analysis.semantic;
            throw new Error(`Unhandled grep context semantic: ${_ex}`);
          }
          }
          break;
        }
        default: {
          const _ex: never = analysis.semantic;
          throw new Error(`Unhandled grep option semantic: ${_ex}`);
        }
        }
        bodyOffset = analysis.nextBodyOffset;
      }
      continue;
    }
    if (!optionTerminated && arg.startsWith('--')) throw new GitUsageError({ message: `unknown option: ${arg}` });
    positionals.push(arg);
  }

  const pattern = positionals[0];
  if (pattern === undefined) throw new GitUsageError({ message: 'no pattern given' });
  return {
    pattern,
    pathOperands: positionals.slice(1),
    lineNumber,
    filesWithMatches,
    ignoreCase,
    patternMode,
    beforeContext,
    afterContext,
  };
}

function asciiFold({ value }: { value: string }): string {
  return value.replace(/[A-Z]/gu, character => character.toLowerCase());
}

function createLineMatcher({ pattern, mode, ignoreCase }: {
  pattern: string,
  mode: ParsedGrepArguments['patternMode'],
  ignoreCase: boolean,
}): ({ line }: { line: string }) => boolean {
  const preparedPattern = ignoreCase ? asciiFold({ value: pattern }) : pattern;
  switch (mode) {
  case 'fixed':
    return ({ line }) => (ignoreCase ? asciiFold({ value: line }) : line).includes(preparedPattern);
  case 'basic': {
    const regex = compileGitBasicRegex({ pattern: preparedPattern });
    return ({ line }) => testGitBasicRegex({ regex, value: ignoreCase ? asciiFold({ value: line }) : line });
  }
  case 'extended': {
    const regex = compileGitExtendedRegex({ pattern: preparedPattern });
    return ({ line }) => testGitExtendedRegex({ regex, value: ignoreCase ? asciiFold({ value: line }) : line });
  }
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled grep pattern mode: ${_ex}`);
  }
  }
}

interface GrepOutputLine {
  lineIndex: number,
  matched: boolean,
}

function selectedOutputLines({ matchingLineIndexes, lineCount, beforeContext, afterContext }: {
  matchingLineIndexes: readonly number[],
  lineCount: number,
  beforeContext: number,
  afterContext: number,
}): GrepOutputLine[] {
  const output: GrepOutputLine[] = [];
  let matchOffset = 0;
  let previousSelectedEnd = -1;
  for (const lineIndex of matchingLineIndexes) {
    const start = Math.max(previousSelectedEnd + 1, lineIndex - beforeContext, 0);
    const end = Math.min(lineCount - 1, lineIndex + afterContext);
    while (matchOffset < matchingLineIndexes.length && matchingLineIndexes[matchOffset]! < start) matchOffset += 1;
    for (let current = start; current <= end; current += 1) {
      while (matchOffset < matchingLineIndexes.length && matchingLineIndexes[matchOffset]! < current) matchOffset += 1;
      output.push({ lineIndex: current, matched: matchingLineIndexes[matchOffset] === current });
    }
    previousSelectedEnd = Math.max(previousSelectedEnd, end);
  }
  return output;
}

export async function runGrep({ context, args }: {
  context: WeshCommandContext,
  args: readonly string[],
}): Promise<WeshCommandResult> {
  if (args.length === 1 && args[0] === '--help') {
    await context.text().print({ text: GREP_HELP });
    return { exitCode: 0 };
  }
  const parsed = parseGrepArguments({ args });
  const repository = await discoverRepositoryFromContext({ context });
  const indexEntries = (await readIndex({ files: context.files, repository }))
    .filter(entry => entry.stage === 0 && entry.mode !== 0o160000);
  const selectedPaths = parsed.pathOperands.length === 0
    ? undefined
    : matchRepositoryPathSelection({
      repository,
      cwd: context.cwd,
      operands: parsed.pathOperands,
      availablePaths: indexEntries.map(entry => entry.path),
    }).selected;
  const matchesLine = createLineMatcher({ pattern: parsed.pattern, mode: parsed.patternMode, ignoreCase: parsed.ignoreCase });
  const decoder = new TextDecoder();
  let found = false;
  let outputBuffer = '';

  for (const entry of indexEntries) {
    if (selectedPaths !== undefined && !selectedPaths.has(entry.path)) continue;
    const absolutePath = worktreeAbsolutePath({ repository, path: entry.path });
    if (!await pathExists({ files: context.files, path: absolutePath })) continue;
    const stat = await context.files.lstat({ path: absolutePath });
    switch (stat.type) {
    case 'file':
      break;
    case 'directory':
    case 'symlink':
    case 'fifo':
    case 'chardev':
      continue;
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled grep worktree type: ${_ex}`);
    }
    }
    const bytes = await readFileBytes({ files: context.files, path: absolutePath });
    if (bytes.includes(0)) continue;
    const text = decoder.decode(bytes);
    const lines = text.split('\n');
    if (lines.length > 0 && lines.at(-1) === '') lines.pop();
    const displayPath = statusPathFromCwd({ context, repository, path: entry.path });
    if (parsed.filesWithMatches) {
      if (!lines.some(line => matchesLine({ line }))) continue;
      found = true;
      outputBuffer += `${displayPath}\n`;
      if (outputBuffer.length >= GREP_OUTPUT_FLUSH_THRESHOLD) {
        await context.text().print({ text: outputBuffer });
        outputBuffer = '';
      }
      continue;
    }
    const matchingLineIndexes: number[] = [];
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      if (matchesLine({ line: lines[lineIndex]! })) matchingLineIndexes.push(lineIndex);
    }
    if (matchingLineIndexes.length === 0) continue;
    found = true;
    const outputLines = selectedOutputLines({
      matchingLineIndexes,
      lineCount: lines.length,
      beforeContext: parsed.beforeContext,
      afterContext: parsed.afterContext,
    });
    let previousLineIndex: number | undefined;
    let fileOutput = '';
    for (const output of outputLines) {
      if ((parsed.beforeContext > 0 || parsed.afterContext > 0)
        && previousLineIndex !== undefined
        && output.lineIndex > previousLineIndex + 1) {
        fileOutput += '--\n';
      }
      const separator = output.matched ? ':' : '-';
      const number = parsed.lineNumber ? `${output.lineIndex + 1}${separator}` : '';
      fileOutput += `${displayPath}${separator}${number}${lines[output.lineIndex]!}\n`;
      previousLineIndex = output.lineIndex;
    }
    outputBuffer += fileOutput;
    if (outputBuffer.length >= GREP_OUTPUT_FLUSH_THRESHOLD) {
      await context.text().print({ text: outputBuffer });
      outputBuffer = '';
    }
  }
  if (outputBuffer.length > 0) await context.text().print({ text: outputBuffer });
  return { exitCode: found ? 0 : 1 };
}

export const TEST_ONLY = {
  parseGrepArguments,
  selectedOutputLines,
};
