import {
  parseStandardArgv,
  type ArgvOptionOccurrence,
  type ArgvSpecialTokenParser,
  type StandardArgvParserSpec,
} from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { readAllFileBytes } from '@/features/wesh/utils/fs';
import { compareDiffInputs, type DiffCompareSettings } from './compare';
import {
  comparePathOperands,
  type DiffCompareStatus,
  type DiffDirectoryOptions,
} from './directory';
import { createDiffInput, readFileInput, readStdinBytes } from './input';
import type { DiffComparisonOptions, DiffOutputMode, DiffOutputOptions } from './model';
import { compileBasicRegularExpression, compileFileNameGlob } from './patterns';
import { createDiffByteWriter } from './output';

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_SIDE_BY_SIDE_WIDTH = 130;
const DEFAULT_TAB_SIZE = 8;
const MAX_OPTION_NUMBER = 1_000_000;
const DEFAULT_C_FUNCTION_PATTERN = /^[A-Za-z_$].*\([^;]*\)[^{;]*(?:\{|$)/u;

function parseNonnegativeInteger({ value }: { value: string }): { ok: true, value: number } | { ok: false, message: string } {
  if (!/^\d+$/u.test(value)) {
    return { ok: false, message: `invalid numeric value '${value}'` };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_OPTION_NUMBER) {
    return { ok: false, message: `numeric value is too large: '${value}'` };
  }
  return { ok: true, value: parsed };
}

function createOptionalContextParser({
  longName,
  outputKind,
}: {
  longName: 'context' | 'unified',
  outputKind: 'context' | 'unified',
}): ArgvSpecialTokenParser {
  return ({ token }) => {
    if (token === `--${longName}`) {
      return {
        kind: 'matched',
        consumeCount: 1,
        effects: [
          { key: 'outputKind', value: outputKind },
          { key: 'contextLines', value: DEFAULT_CONTEXT_LINES },
        ],
        occurrences: [{
          kind: 'special',
          option: token,
          effects: [
            { key: 'outputKind', value: outputKind },
            { key: 'contextLines', value: DEFAULT_CONTEXT_LINES },
          ],
        }],
      };
    }
    const prefix = `--${longName}=`;
    if (!token.startsWith(prefix)) {
      return undefined;
    }
    const rawValue = token.slice(prefix.length);
    const parsed = parseNonnegativeInteger({ value: rawValue });
    if (!parsed.ok) {
      return {
        kind: 'matched',
        consumeCount: 1,
        effects: [{ key: 'invalidContextLength', value: rawValue }],
        occurrences: [{
          kind: 'special',
          option: token,
          effects: [{ key: 'invalidContextLength', value: rawValue }],
        }],
      };
    }
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [
        { key: 'outputKind', value: outputKind },
        { key: 'contextLines', value: parsed.value },
      ],
      occurrences: [{
        kind: 'special',
        option: token,
        effects: [
          { key: 'outputKind', value: outputKind },
          { key: 'contextLines', value: parsed.value },
        ],
      }],
    };
  };
}

const diffArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: undefined, long: 'normal', effects: [{ key: 'outputKind', value: 'normal' }], help: { summary: 'output a normal diff (the default)', category: 'common' } },
    { kind: 'flag', short: 'q', long: 'brief', effects: [{ key: 'outputKind', value: 'brief' }], help: { summary: 'report only when files differ', category: 'common' } },
    { kind: 'flag', short: 's', long: 'report-identical-files', effects: [{ key: 'reportIdenticalFiles', value: true }], help: { summary: 'report when two files are the same', category: 'common' } },
    { kind: 'flag', short: 'c', long: undefined, effects: [{ key: 'outputKind', value: 'context' }, { key: 'contextLines', value: DEFAULT_CONTEXT_LINES }], help: { summary: 'output 3 lines of copied context', category: 'common' } },
    { kind: 'value', short: 'C', long: undefined, key: 'contextLines', valueName: 'NUM', allowAttachedValue: true, parseValue: parseNonnegativeInteger, help: { summary: 'output NUM lines of copied context', valueName: 'NUM', category: 'common' } },
    { kind: 'flag', short: 'u', long: undefined, effects: [{ key: 'outputKind', value: 'unified' }, { key: 'contextLines', value: DEFAULT_CONTEXT_LINES }], help: { summary: 'output 3 lines of unified context', category: 'common' } },
    { kind: 'value', short: 'U', long: undefined, key: 'unifiedLines', valueName: 'NUM', allowAttachedValue: true, parseValue: parseNonnegativeInteger, help: { summary: 'output NUM lines of unified context', valueName: 'NUM', category: 'common' } },
    { kind: 'flag', short: 'e', long: 'ed', effects: [{ key: 'outputKind', value: 'ed' }], help: { summary: 'output an ed script', category: 'advanced' } },
    { kind: 'flag', short: 'n', long: 'rcs', effects: [{ key: 'outputKind', value: 'rcs' }], help: { summary: 'output an RCS format diff', category: 'advanced' } },
    { kind: 'flag', short: 'y', long: 'side-by-side', effects: [{ key: 'outputKind', value: 'side-by-side' }], help: { summary: 'output in two columns', category: 'common' } },
    { kind: 'value', short: 'W', long: 'width', key: 'width', valueName: 'NUM', allowAttachedValue: true, parseValue: parseNonnegativeInteger, help: { summary: 'output at most NUM print columns', valueName: 'NUM', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'left-column', effects: [{ key: 'commonLineMode', value: 'left-only' }], help: { summary: 'output only the left column of common lines', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'suppress-common-lines', effects: [{ key: 'commonLineMode', value: 'suppress' }], help: { summary: 'do not output common lines in side-by-side mode', category: 'advanced' } },
    { kind: 'flag', short: 'p', long: 'show-c-function', effects: [{ key: 'showCFunction', value: true }], help: { summary: 'show which C function each change is in', category: 'advanced' } },
    { kind: 'value', short: 'F', long: 'show-function-line', key: 'functionLinePattern', valueName: 'RE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'show the most recent line matching RE', valueName: 'RE', category: 'advanced' } },
    { kind: 'value', short: undefined, long: 'label', key: 'label', valueName: 'LABEL', allowAttachedValue: false, parseValue: undefined, help: { summary: 'use LABEL instead of file name and timestamp', valueName: 'LABEL', category: 'advanced' } },
    { kind: 'flag', short: 't', long: 'expand-tabs', effects: [{ key: 'expandTabs', value: true }], help: { summary: 'expand tabs to spaces in output', category: 'advanced' } },
    { kind: 'flag', short: 'T', long: 'initial-tab', effects: [{ key: 'initialTab', value: true }], help: { summary: 'prepend a tab to align output', category: 'advanced' } },
    { kind: 'value', short: undefined, long: 'tabsize', key: 'tabSize', valueName: 'NUM', allowAttachedValue: false, parseValue: parseNonnegativeInteger, help: { summary: 'tab stops every NUM columns', valueName: 'NUM', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'suppress-blank-empty', effects: [{ key: 'suppressBlankEmpty', value: true }], help: { summary: 'suppress a prefix before empty output lines', category: 'advanced' } },
    { kind: 'flag', short: 'r', long: 'recursive', effects: [{ key: 'recursive', value: true }], help: { summary: 'recursively compare subdirectories', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'no-dereference', effects: [{ key: 'noDereference', value: true }], help: { summary: 'do not follow symbolic links', category: 'advanced' } },
    { kind: 'flag', short: 'N', long: 'new-file', effects: [{ key: 'missingFileMode', value: 'both-empty' }], help: { summary: 'treat absent files as empty', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'unidirectional-new-file', effects: [{ key: 'missingFileMode', value: 'left-empty' }], help: { summary: 'treat absent first files as empty', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'ignore-file-name-case', effects: [{ key: 'fileNameCaseMode', value: 'insensitive' }], help: { summary: 'ignore case when comparing file names', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'no-ignore-file-name-case', effects: [{ key: 'fileNameCaseMode', value: 'sensitive' }], help: { summary: 'consider case when comparing file names', category: 'advanced' } },
    { kind: 'value', short: 'x', long: 'exclude', key: 'exclude', valueName: 'PAT', allowAttachedValue: true, parseValue: undefined, help: { summary: 'exclude files matching PAT', valueName: 'PAT', category: 'advanced' } },
    { kind: 'value', short: 'X', long: 'exclude-from', key: 'excludeFrom', valueName: 'FILE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'exclude patterns listed in FILE', valueName: 'FILE', category: 'advanced' } },
    { kind: 'value', short: 'S', long: 'starting-file', key: 'startingFile', valueName: 'FILE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'start with FILE when comparing directories', valueName: 'FILE', category: 'advanced' } },
    { kind: 'value', short: undefined, long: 'from-file', key: 'fromFile', valueName: 'FILE', allowAttachedValue: false, parseValue: undefined, help: { summary: 'compare FILE to every operand', valueName: 'FILE', category: 'advanced' } },
    { kind: 'value', short: undefined, long: 'to-file', key: 'toFile', valueName: 'FILE', allowAttachedValue: false, parseValue: undefined, help: { summary: 'compare every operand to FILE', valueName: 'FILE', category: 'advanced' } },
    { kind: 'flag', short: 'i', long: 'ignore-case', effects: [{ key: 'ignoreCase', value: true }], help: { summary: 'ignore case differences in file contents', category: 'common' } },
    { kind: 'flag', short: 'E', long: 'ignore-tab-expansion', effects: [{ key: 'ignoreTabExpansion', value: true }], help: { summary: 'ignore changes due to tab expansion', category: 'advanced' } },
    { kind: 'flag', short: 'Z', long: 'ignore-trailing-space', effects: [{ key: 'ignoreTrailingSpace', value: true }], help: { summary: 'ignore white space at line end', category: 'common' } },
    { kind: 'flag', short: 'b', long: 'ignore-space-change', effects: [{ key: 'ignoreSpaceChange', value: true }], help: { summary: 'ignore changes in the amount of white space', category: 'common' } },
    { kind: 'flag', short: 'w', long: 'ignore-all-space', effects: [{ key: 'ignoreAllSpace', value: true }], help: { summary: 'ignore all white space', category: 'common' } },
    { kind: 'flag', short: 'B', long: 'ignore-blank-lines', effects: [{ key: 'ignoreBlankLineChanges', value: true }], help: { summary: 'ignore changes where lines are all blank', category: 'advanced' } },
    { kind: 'value', short: 'I', long: 'ignore-matching-lines', key: 'ignoreMatchingLines', valueName: 'RE', allowAttachedValue: true, parseValue: undefined, help: { summary: 'ignore changes where all lines match RE', valueName: 'RE', category: 'advanced' } },
    { kind: 'flag', short: 'a', long: 'text', effects: [{ key: 'binaryMode', value: 'text' }], help: { summary: 'treat all files as text', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'strip-trailing-cr', effects: [{ key: 'stripTrailingCarriageReturn', value: true }], help: { summary: 'strip trailing carriage return on input', category: 'advanced' } },
    { kind: 'value', short: 'D', long: 'ifdef', key: 'ifdefName', valueName: 'NAME', allowAttachedValue: true, parseValue: undefined, help: { summary: 'output merged file with ifdef differences', valueName: 'NAME', category: 'advanced' } },
    { kind: 'flag', short: 'd', long: 'minimal', effects: [{ key: 'minimal', value: true }], help: { summary: 'try hard to find a smaller set of changes', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'speed-large-files', effects: [{ key: 'speedLargeFiles', value: true }], help: { summary: 'optimize for large files with scattered changes', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
    { kind: 'flag', short: 'v', long: 'version', effects: [{ key: 'version', value: true }], help: { summary: 'output version information and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [
    createOptionalContextParser({ longName: 'context', outputKind: 'context' }),
    createOptionalContextParser({ longName: 'unified', outputKind: 'unified' }),
  ],
};

function findUnexpectedLongFlagArgument({
  args,
}: {
  args: readonly string[],
}): string | undefined {
  const longFlags = new Set(
    diffArgvSpec.options
      .filter((option) => option.kind === 'flag' && option.long !== undefined)
      .map((option) => option.long!),
  );
  for (const token of args) {
    if (token === '--') {
      break;
    }
    if (!token.startsWith('--')) {
      continue;
    }
    const equalsIndex = token.indexOf('=');
    if (equalsIndex < 0) {
      continue;
    }
    const name = token.slice(2, equalsIndex);
    if (longFlags.has(name)) {
      return `--${name}`;
    }
  }
  return undefined;
}

function getEffectValue({
  occurrence,
  key,
}: {
  occurrence: ArgvOptionOccurrence,
  key: string,
}): boolean | string | number | undefined {
  switch (occurrence.kind) {
  case 'value':
    return occurrence.key === key ? occurrence.value : undefined;
  case 'flag':
  case 'special':
    return occurrence.effects.find((effect) => effect.key === key)?.value;
  default: {
    const _ex: never = occurrence;
    throw new Error(`Unhandled option occurrence: ${JSON.stringify(_ex)}`);
  }
  }
}

function resolveMissingFileMode({
  value,
}: {
  value: boolean | string | number | undefined,
}): DiffDirectoryOptions['missingFileMode'] {
  switch (value) {
  case 'both-empty': return 'both-empty';
  case 'left-empty': return 'left-empty';
  default: return 'report';
  }
}

function compareStatusToExitCode({ status }: { status: DiffCompareStatus }): number {
  switch (status) {
  case 'same': return 0;
  case 'different': return 1;
  case 'trouble': return 2;
  default: {
    const _ex: never = status;
    throw new Error(`Unhandled compare status: ${_ex}`);
  }
  }
}

function collectOccurrenceValues({
  occurrences,
  key,
}: {
  occurrences: readonly ArgvOptionOccurrence[],
  key: string,
}): string[] {
  const values: string[] = [];
  for (const occurrence of occurrences) {
    const value = getEffectValue({ occurrence, key });
    if (typeof value === 'string') {
      values.push(value);
    }
  }
  return values;
}

function resolveOutputMode({
  occurrences,
}: {
  occurrences: readonly ArgvOptionOccurrence[],
}): DiffOutputMode {
  type DetailedOutputKind = 'normal' | 'context' | 'unified' | 'ed' | 'rcs' | 'side-by-side' | 'ifdef';

  const detailedKinds = new Set<DetailedOutputKind>();
  let brief = false;
  let contextLines = 0;
  let width = DEFAULT_SIDE_BY_SIDE_WIDTH;
  let commonLineMode: 'both' | 'left-only' | 'suppress' = 'both';
  let ifdefName = '';
  let showCFunction = false;

  for (const occurrence of occurrences) {
    const kindValue = getEffectValue({ occurrence, key: 'outputKind' });
    switch (kindValue) {
    case 'brief': brief = true; break;
    case 'normal':
    case 'context':
    case 'unified':
    case 'ed':
    case 'rcs':
    case 'side-by-side': detailedKinds.add(kindValue); break;
    default: break;
    }

    const contextValue = getEffectValue({ occurrence, key: 'contextLines' });
    if (typeof contextValue === 'number') {
      if (kindValue !== 'unified') {
        detailedKinds.add('context');
      }
      contextLines = Math.max(contextLines, contextValue);
    }
    const unifiedValue = getEffectValue({ occurrence, key: 'unifiedLines' });
    if (typeof unifiedValue === 'number') {
      detailedKinds.add('unified');
      contextLines = Math.max(contextLines, unifiedValue);
    }
    const widthValue = getEffectValue({ occurrence, key: 'width' });
    if (typeof widthValue === 'number') {
      width = widthValue;
    }
    const commonValue = getEffectValue({ occurrence, key: 'commonLineMode' });
    switch (commonValue) {
    case 'left-only':
    case 'suppress': commonLineMode = commonValue; break;
    default: break;
    }
    const ifdefValue = getEffectValue({ occurrence, key: 'ifdefName' });
    if (typeof ifdefValue === 'string') {
      detailedKinds.add('ifdef');
      ifdefName = ifdefValue;
    }
    if (getEffectValue({ occurrence, key: 'showCFunction' }) === true) {
      showCFunction = true;
    }
  }

  if (brief) {
    return { kind: 'brief' };
  }
  if (detailedKinds.size > 1) {
    throw new Error('conflicting output style options');
  }

  if (detailedKinds.size === 0 && showCFunction) {
    detailedKinds.add('context');
    contextLines = DEFAULT_CONTEXT_LINES;
  }

  const outputKind: DetailedOutputKind = detailedKinds.values().next().value ?? 'normal';
  switch (outputKind) {
  case 'normal': return { kind: 'normal' };
  case 'context': return { kind: 'context', contextLines };
  case 'unified': return { kind: 'unified', contextLines };
  case 'ed': return { kind: 'ed' };
  case 'rcs': return { kind: 'rcs' };
  case 'side-by-side': return { kind: 'side-by-side', width, commonLineMode };
  case 'ifdef': return { kind: 'ifdef', name: ifdefName };
  default: {
    const _ex: never = outputKind;
    throw new Error(`Unhandled output kind: ${_ex}`);
  }
  }
}

async function readExcludePatterns({
  context,
  paths,
}: {
  context: WeshCommandContext,
  paths: readonly string[],
}): Promise<string[]> {
  const patterns: string[] = [];
  for (const path of paths) {
    const bytes = await readAllFileBytes({
      files: context.files,
      path: resolvePath({ cwd: context.cwd, path }),
    });
    const lines = new TextDecoder().decode(bytes).split(/\r?\n/u);
    if (lines[lines.length - 1] === '') lines.pop();
    patterns.push(...lines);
  }
  return patterns;
}

function shouldForwardSignal({ context }: { context: WeshCommandContext }): boolean {
  const waitStatus = context.process.getWaitStatus();
  if (waitStatus === undefined) return false;
  switch (waitStatus.kind) {
  case 'signaled': return true;
  case 'exited':
  case 'stopped': return false;
  default: {
    const _ex: never = waitStatus;
    throw new Error(`Unhandled wait status: ${JSON.stringify(_ex)}`);
  }
  }
}

interface DiffOperandPair {
  readonly left: string,
  readonly right: string,
}

interface DiffStdinCache {
  bytes: Uint8Array | undefined,
  mtime: number | undefined,
}

function mergeCompareStatus({
  current,
  next,
}: {
  current: DiffCompareStatus,
  next: DiffCompareStatus,
}): DiffCompareStatus {
  switch (next) {
  case 'trouble': return 'trouble';
  case 'different':
    switch (current) {
    case 'trouble': return 'trouble';
    case 'different':
    case 'same': return 'different';
    default: {
      const _ex: never = current;
      throw new Error(`Unhandled compare status: ${_ex}`);
    }
    }
  case 'same': return current;
  default: {
    const _ex: never = next;
    throw new Error(`Unhandled compare status: ${_ex}`);
  }
  }
}

function shellQuote({ value }: { value: string }): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createRecursiveCommandPrefix({
  occurrences,
}: {
  occurrences: readonly ArgvOptionOccurrence[],
}): string {
  const parts = ['diff'];
  for (const occurrence of occurrences) {
    switch (occurrence.kind) {
    case 'flag':
    case 'special':
      parts.push(shellQuote({ value: occurrence.option }));
      break;
    case 'value':
      parts.push(shellQuote({ value: occurrence.option }));
      parts.push(shellQuote({ value: String(occurrence.value) }));
      break;
    default: {
      const _ex: never = occurrence;
      throw new Error(`Unhandled option occurrence: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return parts.join(' ');
}

async function getStdinDiffInput({
  context,
  cache,
}: {
  context: WeshCommandContext,
  cache: DiffStdinCache,
}) {
  if (cache.bytes === undefined) {
    cache.bytes = await readStdinBytes({ context });
    cache.mtime = Date.now();
  }
  return createDiffInput({
    displayName: '-',
    resolvedPath: undefined,
    mtime: cache.mtime,
    bytes: cache.bytes,
  });
}

async function compareOperandPair({
  context,
  stdout,
  stderr,
  pair,
  directoryOptions,
  settings,
  recursiveCommandPrefix,
  stdinCache,
}: {
  context: WeshCommandContext,
  stdout: ReturnType<typeof createDiffByteWriter>,
  stderr: ReturnType<typeof createDiffByteWriter>,
  pair: DiffOperandPair,
  directoryOptions: DiffDirectoryOptions,
  settings: DiffCompareSettings,
  recursiveCommandPrefix: string,
  stdinCache: DiffStdinCache,
}): Promise<DiffCompareStatus> {
  if (pair.left !== '-' && pair.right !== '-') {
    return await comparePathOperands({
      context,
      stdout,
      stderr,
      leftOperand: pair.left,
      rightOperand: pair.right,
      options: directoryOptions,
      settings,
      recursiveCommandPrefix,
    });
  }

  const left = pair.left === '-'
    ? await getStdinDiffInput({ context, cache: stdinCache })
    : (await readFileInput({ context, operand: pair.left })).input;
  const right = pair.right === '-'
    ? await getStdinDiffInput({ context, cache: stdinCache })
    : (await readFileInput({ context, operand: pair.right })).input;
  const result = await compareDiffInputs({ writer: stdout, left, right, settings });
  return result.different ? 'different' : 'same';
}

export const diffCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'diff',
    description: 'Compare files line by line',
    usage: 'diff [OPTION]... FILE1 FILE2',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const flagWithArgument = findUnexpectedLongFlagArgument({ args: context.args });
    if (flagWithArgument !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'diff',
        message: `diff: option '${flagWithArgument}' doesn't allow an argument`,
        argvSpec: diffArgvSpec,
      });
      return { exitCode: 2 };
    }

    const parsed = parseStandardArgv({ args: context.args, spec: diffArgvSpec });
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'diff',
        message: `diff: ${diagnostic.message}`,
        argvSpec: diffArgvSpec,
      });
      return { exitCode: 2 };
    }

    const invalidContextLength = collectOccurrenceValues({
      occurrences: parsed.occurrences,
      key: 'invalidContextLength',
    }).at(-1);
    if (invalidContextLength !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'diff',
        message: `diff: invalid context length '${invalidContextLength}'`,
        argvSpec: diffArgvSpec,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({ context, command: 'diff', argvSpec: diffArgvSpec });
      return { exitCode: 0 };
    }
    if (parsed.optionValues.version === true) {
      await context.text().print({ text: 'diff (Wesh diffutils) 1.0\n' });
      return { exitCode: 0 };
    }

    const fromFile = typeof parsed.optionValues.fromFile === 'string'
      ? parsed.optionValues.fromFile
      : undefined;
    const toFile = typeof parsed.optionValues.toFile === 'string'
      ? parsed.optionValues.toFile
      : undefined;
    if (fromFile !== undefined && toFile !== undefined) {
      await context.text().error({ text: 'diff: --from-file and --to-file both specified\n' });
      return { exitCode: 2 };
    }

    let operandPairs: DiffOperandPair[];
    if (fromFile !== undefined || toFile !== undefined) {
      if (parsed.positionals.length === 0) {
        await writeCommandUsageError({
          context,
          command: 'diff',
          message: 'diff: missing operand',
          argvSpec: diffArgvSpec,
        });
        return { exitCode: 2 };
      }
      operandPairs = parsed.positionals.map((operand) => ({
        left: fromFile ?? operand,
        right: toFile ?? operand,
      }));
    } else {
      if (parsed.positionals.length < 2) {
        await writeCommandUsageError({
          context,
          command: 'diff',
          message: 'diff: missing operand',
          argvSpec: diffArgvSpec,
        });
        return { exitCode: 2 };
      }
      if (parsed.positionals.length > 2) {
        await writeCommandUsageError({
          context,
          command: 'diff',
          message: `diff: extra operand '${parsed.positionals[2]}'`,
          argvSpec: diffArgvSpec,
        });
        return { exitCode: 2 };
      }
      operandPairs = [{
        left: parsed.positionals[0]!,
        right: parsed.positionals[1]!,
      }];
    }

    const tabSizeValue = parsed.optionValues.tabSize;
    const tabSize = typeof tabSizeValue === 'number' ? tabSizeValue : DEFAULT_TAB_SIZE;
    if (tabSize === 0) {
      await context.text().error({ text: 'diff: tab size cannot be zero\n' });
      return { exitCode: 2 };
    }
    if (parsed.optionValues.width === 0) {
      await context.text().error({ text: "diff: invalid width '0'\n" });
      return { exitCode: 2 };
    }

    const labels = collectOccurrenceValues({ occurrences: parsed.occurrences, key: 'label' });
    if (labels.length > 2) {
      await context.text().error({ text: 'diff: too many file label options\n' });
      return { exitCode: 2 };
    }

    const ignorePatterns: RegExp[] = [];
    let functionLinePattern: RegExp | undefined;
    try {
      for (const source of collectOccurrenceValues({ occurrences: parsed.occurrences, key: 'ignoreMatchingLines' })) {
        ignorePatterns.push(compileBasicRegularExpression({ pattern: source }));
      }
      const functionPatternSources = collectOccurrenceValues({
        occurrences: parsed.occurrences,
        key: 'functionLinePattern',
      });
      const functionPatternSource = functionPatternSources[functionPatternSources.length - 1];
      if (functionPatternSource !== undefined) {
        functionLinePattern = compileBasicRegularExpression({ pattern: functionPatternSource });
      } else if (parsed.optionValues.showCFunction === true) {
        functionLinePattern = DEFAULT_C_FUNCTION_PATTERN;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `diff: invalid regular expression: ${message}\n` });
      return { exitCode: 2 };
    }

    try {
      const excludeSources = collectOccurrenceValues({ occurrences: parsed.occurrences, key: 'exclude' });
      excludeSources.push(...await readExcludePatterns({
        context,
        paths: collectOccurrenceValues({ occurrences: parsed.occurrences, key: 'excludeFrom' }),
      }));
      const fileNameCaseMode = parsed.optionValues.fileNameCaseMode === 'insensitive' ? 'insensitive' : 'sensitive';
      const comparisonOptions: DiffComparisonOptions = {
        stripTrailingCarriageReturn: parsed.optionValues.stripTrailingCarriageReturn === true,
        ignoreCase: parsed.optionValues.ignoreCase === true,
        ignoreTabExpansion: parsed.optionValues.ignoreTabExpansion === true,
        ignoreTrailingSpace: parsed.optionValues.ignoreTrailingSpace === true,
        ignoreSpaceChange: parsed.optionValues.ignoreSpaceChange === true,
        ignoreAllSpace: parsed.optionValues.ignoreAllSpace === true,
        tabSize,
      };
      const outputOptions: DiffOutputOptions = {
        mode: resolveOutputMode({ occurrences: parsed.occurrences }),
        functionLinePattern,
        expandTabs: parsed.optionValues.expandTabs === true,
        initialTab: parsed.optionValues.initialTab === true,
        tabSize,
        suppressBlankEmpty: parsed.optionValues.suppressBlankEmpty === true,
        labels,
      };
      const settings: DiffCompareSettings = {
        comparisonOptions,
        outputOptions,
        binaryMode: parsed.optionValues.binaryMode === 'text' ? 'text' : 'detect',
        reportIdenticalFiles: parsed.optionValues.reportIdenticalFiles === true,
        ignoreBlankLineChanges: parsed.optionValues.ignoreBlankLineChanges === true,
        ignoreMatchingLinePatterns: ignorePatterns,
        preferSpeedOverCompatibility: parsed.optionValues.speedLargeFiles === true
          && parsed.optionValues.minimal !== true,
      };
      const directoryOptions: DiffDirectoryOptions = {
        recursive: parsed.optionValues.recursive === true,
        noDereference: parsed.optionValues.noDereference === true,
        missingFileMode: resolveMissingFileMode({ value: parsed.optionValues.missingFileMode }),
        fileNameCaseMode,
        excludePatterns: excludeSources.map((pattern) => compileFileNameGlob({ pattern, ignoreCase: fileNameCaseMode === 'insensitive' })),
        startingFile: typeof parsed.optionValues.startingFile === 'string' ? parsed.optionValues.startingFile : undefined,
      };

      const stdout = createDiffByteWriter({ handle: context.stdout });
      const stderr = createDiffByteWriter({ handle: context.stderr });
      const recursiveCommandPrefix = createRecursiveCommandPrefix({ occurrences: parsed.occurrences });
      const stdinCache: DiffStdinCache = {
        bytes: undefined,
        mtime: undefined,
      };
      let overall: DiffCompareStatus = 'same';
      for (const pair of operandPairs) {
        const status = await compareOperandPair({
          context,
          stdout,
          stderr,
          pair,
          directoryOptions,
          settings,
          recursiveCommandPrefix,
          stdinCache,
        });
        overall = mergeCompareStatus({ current: overall, next: status });
      }
      return { exitCode: compareStatusToExitCode({ status: overall }) };
    } catch (error) {
      if (shouldForwardSignal({ context })) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `diff: ${message}\n` });
      return { exitCode: 2 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  diffArgvSpec,
  resolveOutputMode,
};
