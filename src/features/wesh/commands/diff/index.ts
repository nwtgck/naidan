import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import {
  analyzeArgvLongForm,
  analyzeArgvShortForm,
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  HELP_VERSION_EARLY_EXIT_OPTIONS,
  parseStandardArgv,
  stopArgvAtFirstEarlyExit,
  type StandardArgvAction,
  type StandardArgvOccurrence,
  type StandardArgvPolicy,
  type StandardArgvRawValue,
} from '@/features/wesh/argv-v2';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { resolvePath } from '@/features/wesh/path';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { readAllFileBytes } from '@/features/wesh/utils/fs';
import { compareDiffInputs, type DiffCompareSettings } from './compare';
import {
  comparePathOperands,
  type DiffCompareStatus,
  type DiffDirectoryOptions,
} from './directory';
import { createDiffInput, readFileInput, readStdinBytes } from './input';
import type { DiffComparisonOptions, DiffOutputMode, DiffOutputOptions } from './model';
import { resolveCharacterLocaleMode } from '@/features/wesh/commands/_shared/locale';
import { compileBasicRegularExpression } from '@/features/wesh/commands/_shared/posix-regexp';
import { compileFileNameGlob } from './patterns';
import { createDiffByteWriter } from './output';

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_SIDE_BY_SIDE_WIDTH = 130;
const DEFAULT_TAB_SIZE = 8;
const MAX_OPTION_NUMBER = 1_000_000;
const DEFAULT_C_FUNCTION_PATTERN = /^[A-Za-z_$].*\([^;]*\)[^{;]*(?:\{|$)/u;

function parseNonnegativeInteger({ rawValue: value }: { rawValue: string }): { kind: 'parsed', value: number } | { kind: 'invalid', message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  if (!/^\+?\d+$/u.test(numericText)) {
    return { kind: 'invalid', message: `invalid numeric value '${value}'` };
  }
  const parsed = Number(numericText);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_OPTION_NUMBER) {
    return { kind: 'invalid', message: `numeric value is too large: '${value}'` };
  }
  return { kind: 'parsed', value: parsed };
}

// Flag arguments are rejected by the precheck up to the first raw `--`.
// A required option can claim that token as its value and leave later flags to the scanner.
const diffOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'outputKind', value: 'normal' }] },
    forms: [{ kind: 'long', name: 'normal', value: { kind: 'optional-inline' } }],
    summary: 'output a normal diff (the default)',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'outputKind', value: 'brief' }] },
    forms: [
      { kind: 'short', name: 'q', value: { kind: 'none' } },
      { kind: 'long', name: 'brief', value: { kind: 'optional-inline' } },
    ],
    summary: 'report only when files differ',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'reportIdenticalFiles', value: true }] },
    forms: [
      { kind: 'short', name: 's', value: { kind: 'none' } },
      { kind: 'long', name: 'report-identical-files', value: { kind: 'optional-inline' } },
    ],
    summary: 'report when two files are the same',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'outputKind', value: 'context' }, { key: 'contextLines', value: DEFAULT_CONTEXT_LINES }] },
    forms: [{ kind: 'short', name: 'c', value: { kind: 'none' } }],
    summary: 'output 3 lines of copied context',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'contextLines', parse: parseNonnegativeInteger },
    forms: [{ kind: 'short', name: 'C', value: { kind: 'required-attached-or-following', missingValueName: 'NUM' } }],
    summary: 'output NUM lines of copied context',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'outputKind', value: 'unified' }, { key: 'contextLines', value: DEFAULT_CONTEXT_LINES }] },
    forms: [{ kind: 'short', name: 'u', value: { kind: 'none' } }],
    summary: 'output 3 lines of unified context',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'unifiedLines', parse: parseNonnegativeInteger },
    forms: [{ kind: 'short', name: 'U', value: { kind: 'required-attached-or-following', missingValueName: 'NUM' } }],
    summary: 'output NUM lines of unified context',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'outputKind', value: 'ed' }] },
    forms: [
      { kind: 'short', name: 'e', value: { kind: 'none' } },
      { kind: 'long', name: 'ed', value: { kind: 'optional-inline' } },
    ],
    summary: 'output an ed script',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'outputKind', value: 'rcs' }] },
    forms: [
      { kind: 'short', name: 'n', value: { kind: 'none' } },
      { kind: 'long', name: 'rcs', value: { kind: 'optional-inline' } },
    ],
    summary: 'output an RCS format diff',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'outputKind', value: 'side-by-side' }] },
    forms: [
      { kind: 'short', name: 'y', value: { kind: 'none' } },
      { kind: 'long', name: 'side-by-side', value: { kind: 'optional-inline' } },
    ],
    summary: 'output in two columns',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'width', parse: parseNonnegativeInteger },
    forms: [
      { kind: 'short', name: 'W', value: { kind: 'required-attached-or-following', missingValueName: 'NUM' } },
      { kind: 'long', name: 'width', value: { kind: 'required', missingValueName: 'NUM' } },
    ],
    summary: 'output at most NUM print columns',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'commonLineMode', value: 'left-only' }] },
    forms: [{ kind: 'long', name: 'left-column', value: { kind: 'optional-inline' } }],
    summary: 'output only the left column of common lines',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'commonLineMode', value: 'suppress' }] },
    forms: [{ kind: 'long', name: 'suppress-common-lines', value: { kind: 'optional-inline' } }],
    summary: 'do not output common lines in side-by-side mode',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'showCFunction', value: true }] },
    forms: [
      { kind: 'short', name: 'p', value: { kind: 'none' } },
      { kind: 'long', name: 'show-c-function', value: { kind: 'optional-inline' } },
    ],
    summary: 'show which C function each change is in',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'functionLinePattern', parse: undefined },
    forms: [
      { kind: 'short', name: 'F', value: { kind: 'required-attached-or-following', missingValueName: 'RE' } },
      { kind: 'long', name: 'show-function-line', value: { kind: 'required', missingValueName: 'RE' } },
    ],
    summary: 'show the most recent line matching RE',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'label', parse: undefined },
    forms: [{ kind: 'long', name: 'label', value: { kind: 'required', missingValueName: 'LABEL' } }],
    summary: 'use LABEL instead of file name and timestamp',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'expandTabs', value: true }] },
    forms: [
      { kind: 'short', name: 't', value: { kind: 'none' } },
      { kind: 'long', name: 'expand-tabs', value: { kind: 'optional-inline' } },
    ],
    summary: 'expand tabs to spaces in output',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'initialTab', value: true }] },
    forms: [
      { kind: 'short', name: 'T', value: { kind: 'none' } },
      { kind: 'long', name: 'initial-tab', value: { kind: 'optional-inline' } },
    ],
    summary: 'prepend a tab to align output',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'tabSize', parse: parseNonnegativeInteger },
    forms: [{ kind: 'long', name: 'tabsize', value: { kind: 'required', missingValueName: 'NUM' } }],
    summary: 'tab stops every NUM columns',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'suppressBlankEmpty', value: true }] },
    forms: [{ kind: 'long', name: 'suppress-blank-empty', value: { kind: 'optional-inline' } }],
    summary: 'suppress a prefix before empty output lines',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'recursive', value: true }] },
    forms: [
      { kind: 'short', name: 'r', value: { kind: 'none' } },
      { kind: 'long', name: 'recursive', value: { kind: 'optional-inline' } },
    ],
    summary: 'recursively compare subdirectories',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'noDereference', value: true }] },
    forms: [{ kind: 'long', name: 'no-dereference', value: { kind: 'optional-inline' } }],
    summary: 'do not follow symbolic links',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'missingFileMode', value: 'both-empty' }] },
    forms: [
      { kind: 'short', name: 'N', value: { kind: 'none' } },
      { kind: 'long', name: 'new-file', value: { kind: 'optional-inline' } },
    ],
    summary: 'treat absent files as empty',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'missingFileMode', value: 'left-empty' }] },
    forms: [{ kind: 'long', name: 'unidirectional-new-file', value: { kind: 'optional-inline' } }],
    summary: 'treat absent first files as empty',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'fileNameCaseMode', value: 'insensitive' }] },
    forms: [{ kind: 'long', name: 'ignore-file-name-case', value: { kind: 'optional-inline' } }],
    summary: 'ignore case when comparing file names',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'fileNameCaseMode', value: 'sensitive' }] },
    forms: [{ kind: 'long', name: 'no-ignore-file-name-case', value: { kind: 'optional-inline' } }],
    summary: 'consider case when comparing file names',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'exclude', parse: undefined },
    forms: [
      { kind: 'short', name: 'x', value: { kind: 'required-attached-or-following', missingValueName: 'PAT' } },
      { kind: 'long', name: 'exclude', value: { kind: 'required', missingValueName: 'PAT' } },
    ],
    summary: 'exclude files matching PAT',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'excludeFrom', parse: undefined },
    forms: [
      { kind: 'short', name: 'X', value: { kind: 'required-attached-or-following', missingValueName: 'FILE' } },
      { kind: 'long', name: 'exclude-from', value: { kind: 'required', missingValueName: 'FILE' } },
    ],
    summary: 'exclude patterns listed in FILE',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'startingFile', parse: undefined },
    forms: [
      { kind: 'short', name: 'S', value: { kind: 'required-attached-or-following', missingValueName: 'FILE' } },
      { kind: 'long', name: 'starting-file', value: { kind: 'required', missingValueName: 'FILE' } },
    ],
    summary: 'start with FILE when comparing directories',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'fromFile', parse: undefined },
    forms: [{ kind: 'long', name: 'from-file', value: { kind: 'required', missingValueName: 'FILE' } }],
    summary: 'compare FILE to every operand',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'toFile', parse: undefined },
    forms: [{ kind: 'long', name: 'to-file', value: { kind: 'required', missingValueName: 'FILE' } }],
    summary: 'compare every operand to FILE',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'ignoreCase', value: true }] },
    forms: [
      { kind: 'short', name: 'i', value: { kind: 'none' } },
      { kind: 'long', name: 'ignore-case', value: { kind: 'optional-inline' } },
    ],
    summary: 'ignore case differences in file contents',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'ignoreTabExpansion', value: true }] },
    forms: [
      { kind: 'short', name: 'E', value: { kind: 'none' } },
      { kind: 'long', name: 'ignore-tab-expansion', value: { kind: 'optional-inline' } },
    ],
    summary: 'ignore changes due to tab expansion',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'ignoreTrailingSpace', value: true }] },
    forms: [
      { kind: 'short', name: 'Z', value: { kind: 'none' } },
      { kind: 'long', name: 'ignore-trailing-space', value: { kind: 'optional-inline' } },
    ],
    summary: 'ignore white space at line end',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'ignoreSpaceChange', value: true }] },
    forms: [
      { kind: 'short', name: 'b', value: { kind: 'none' } },
      { kind: 'long', name: 'ignore-space-change', value: { kind: 'optional-inline' } },
    ],
    summary: 'ignore changes in the amount of white space',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'ignoreAllSpace', value: true }] },
    forms: [
      { kind: 'short', name: 'w', value: { kind: 'none' } },
      { kind: 'long', name: 'ignore-all-space', value: { kind: 'optional-inline' } },
    ],
    summary: 'ignore all white space',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'ignoreBlankLineChanges', value: true }] },
    forms: [
      { kind: 'short', name: 'B', value: { kind: 'none' } },
      { kind: 'long', name: 'ignore-blank-lines', value: { kind: 'optional-inline' } },
    ],
    summary: 'ignore changes where lines are all blank',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'ignoreMatchingLines', parse: undefined },
    forms: [
      { kind: 'short', name: 'I', value: { kind: 'required-attached-or-following', missingValueName: 'RE' } },
      { kind: 'long', name: 'ignore-matching-lines', value: { kind: 'required', missingValueName: 'RE' } },
    ],
    summary: 'ignore changes where all lines match RE',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'binaryMode', value: 'text' }] },
    forms: [
      { kind: 'short', name: 'a', value: { kind: 'none' } },
      { kind: 'long', name: 'text', value: { kind: 'optional-inline' } },
    ],
    summary: 'treat all files as text',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'stripTrailingCarriageReturn', value: true }] },
    forms: [{ kind: 'long', name: 'strip-trailing-cr', value: { kind: 'optional-inline' } }],
    summary: 'strip trailing carriage return on input',
    category: 'advanced',
  },
  {
    semantic: { kind: 'required-value', key: 'ifdefName', parse: undefined },
    forms: [
      { kind: 'short', name: 'D', value: { kind: 'required-attached-or-following', missingValueName: 'NAME' } },
      { kind: 'long', name: 'ifdef', value: { kind: 'required', missingValueName: 'NAME' } },
    ],
    summary: 'output merged file with ifdef differences',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'minimal', value: true }] },
    forms: [
      { kind: 'short', name: 'd', value: { kind: 'none' } },
      { kind: 'long', name: 'minimal', value: { kind: 'optional-inline' } },
    ],
    summary: 'try hard to find a smaller set of changes',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'speedLargeFiles', value: true }] },
    forms: [{ kind: 'long', name: 'speed-large-files', value: { kind: 'optional-inline' } }],
    summary: 'optimize for large files with scattered changes',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'optional-inline' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'version', value: true }] },
    forms: [
      { kind: 'short', name: 'v', value: { kind: 'none' } },
      { kind: 'long', name: 'version', value: { kind: 'optional-inline' } },
    ],
    summary: 'output version information and exit',
    category: 'common',
  },
] as const;

type DiffArgvAction = StandardArgvAction<'context' | 'unified'>;
type DiffArgvOccurrence = StandardArgvOccurrence<DiffArgvAction>;
const diffArgvDefinitions = [
  ...diffOptions,
  {
    semantic: { kind: 'deferred', tag: 'context' },
    forms: [{ kind: 'long', name: 'context', value: { kind: 'optional-inline' } }],
  },
  {
    semantic: { kind: 'deferred', tag: 'unified' },
    forms: [{ kind: 'long', name: 'unified', value: { kind: 'optional-inline' } }],
  },
] as const;
const diffArgvCatalog = defineArgvCatalog<DiffArgvAction>({ definitions: diffArgvDefinitions, nonExecutableLongOptions: [] });
const diffArgvHelp = defineArgvHelpPresentation({ catalog: diffArgvCatalog, rows: diffOptions });
const diffArgvUsageSummary = formatArgvUsageSummary({ presentation: diffArgvHelp });
const diffArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'all',
};

function normalizeOptionalShortContextCounts({
  args,
}: {
  args: readonly string[],
}): string[] {
  const normalized: string[] = [];
  let optionsEnded = false;

  for (const token of args) {
    if (optionsEnded) {
      normalized.push(token);
      continue;
    }
    if (token === '--') {
      normalized.push(token);
      optionsEnded = true;
      continue;
    }
    if (!token.startsWith('-') || token.startsWith('--') || token === '-') {
      normalized.push(token);
      continue;
    }

    const match = /^(.*)([cu])(\d+)$/u.exec(token.slice(1));
    if (match === null) {
      normalized.push(token);
      continue;
    }
    const prefix = match[1] ?? '';
    const outputKind = match[2];
    const lineCount = match[3];
    if ((outputKind !== 'c' && outputKind !== 'u') || lineCount === undefined) {
      normalized.push(token);
      continue;
    }
    if (![...prefix].every((short) => {
      const result = analyzeArgvShortForm({ token: `-${short}`, prefix: '-', bodyOffset: 1, catalog: diffArgvCatalog });
      return result.kind === 'matched' && result.value.kind === 'none';
    })) {
      normalized.push(token);
      continue;
    }
    if (prefix.length > 0) {
      normalized.push(`-${prefix}`);
    }
    const explicitOption = (() => {
      switch (outputKind) {
      case 'c': return 'C';
      case 'u': return 'U';
      default: {
        const _ex: never = outputKind;
        throw new Error(`Unhandled diff output kind: ${_ex}`);
      }
      }
    })();
    normalized.push(`-${explicitOption}${lineCount}`);
  }

  return normalized;
}

function findUnexpectedLongFlagArgument({
  args,
}: {
  args: readonly string[],
}): string | undefined {
  for (const token of args) {
    if (token === '--') {
      break;
    }
    if (!token.startsWith('--')) {
      continue;
    }
    if (!token.includes('=')) {
      continue;
    }
    const result = analyzeArgvLongForm({ token, catalog: diffArgvCatalog, longNameMatch: diffArgvPolicy.longNameMatch });
    if (result.kind === 'matched' && result.value.kind === 'inline' && result.semantic.kind === 'effects') {
      return result.option;
    }
  }
  return undefined;
}

function getRawValue({ value }: { value: StandardArgvRawValue }): string | undefined {
  switch (value.kind) {
  case 'inline':
  case 'next-argv':
    return value.rawValue;
  case 'none':
    return undefined;
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled diff option value: ${JSON.stringify(_ex)}`);
  }
  }
}

function getRequiredValue({ action, value }: {
  action: Extract<DiffArgvAction, { kind: 'required-value' }>,
  value: StandardArgvRawValue,
}): boolean | string | number {
  const rawValue = getRawValue({ value });
  if (rawValue === undefined) {
    throw new Error(`Missing parsed value for ${action.key}`);
  }
  const parsed = action.parse?.({ rawValue });
  switch (parsed?.kind) {
  case undefined:
    return rawValue;
  case 'parsed':
    return parsed.value;
  case 'invalid':
    throw new Error(parsed.message);
  default: {
    const _ex: never = parsed;
    throw new Error(`Unhandled diff option parse result: ${JSON.stringify(_ex)}`);
  }
  }
}

function getEffectValue({
  occurrence,
  key,
}: {
  occurrence: DiffArgvOccurrence,
  key: string,
}): boolean | string | number | undefined {
  const { semantic, value } = occurrence;
  switch (semantic.kind) {
  case 'required-value':
    return semantic.key === key ? getRequiredValue({ action: semantic, value }) : undefined;
  case 'effects':
    return semantic.effects.find((effect) => effect.key === key)?.value;
  case 'deferred': {
    if (key === 'outputKind') {
      return semantic.tag;
    }
    if (key !== 'contextLines') {
      return undefined;
    }
    const rawValue = getRawValue({ value });
    return rawValue === undefined ? DEFAULT_CONTEXT_LINES : Number(rawValue);
  }
  default: {
    const _ex: never = semantic;
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
  occurrences: readonly DiffArgvOccurrence[],
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
  occurrences: readonly DiffArgvOccurrence[],
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
    case 'brief': brief = true;
      break;
    case 'normal':
    case 'context':
    case 'unified':
    case 'ed':
    case 'rcs':
    case 'side-by-side': detailedKinds.add(kindValue);
      break;
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
    case 'suppress': commonLineMode = commonValue;
      break;
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
    const lines = new TextDecoder('utf-8', { ignoreBOM: true })
      .decode(bytes)
      .split('\n');
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
    for (const line of lines) {
      patterns.push(line.endsWith('\r') ? line.slice(0, -1) : line);
    }
  }
  return patterns;
}

function shouldForwardSignal({ context }: { context: WeshCommandContext }): boolean {
  const waitStatus = context.process.getWaitStatus();
  if (waitStatus === undefined) {
    return false;
  }
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
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function restoreShortFlagBundles({
  tokens,
  args,
}: {
  tokens: string[],
  args: readonly string[],
}): string[] {
  const restored = [...tokens];
  for (const arg of args) {
    if (!/^-[A-Za-z]{2,}$/u.test(arg)) {
      continue;
    }
    const expanded = [...arg.slice(1)].map(character => `-${character}`);
    const firstCandidate = restored.findIndex((token, index) => (
      token === expanded[0]
      && expanded.every((expected, offset) => restored[index + offset] === expected)
    ));
    if (firstCandidate < 0) {
      continue;
    }
    restored.splice(firstCandidate, expanded.length, arg);
  }
  return restored;
}

function createRecursiveCommandPrefix({
  occurrences,
  args,
}: {
  occurrences: readonly DiffArgvOccurrence[],
  args: readonly string[],
}): string {
  const parts = ['diff'];
  for (const { resolved, semantic, value } of occurrences) {
    const form = diffArgvDefinitions[resolved.definitionIndex]!.forms[resolved.formIndex]!;
    const option = (() => {
      switch (form.kind) {
      case 'short': return `-${form.name}`;
      case 'long': return `--${form.name}`;
      default: {
        const _ex: never = form;
        throw new Error(`Unhandled diff option spelling: ${JSON.stringify(_ex)}`);
      }
      }
    })();
    switch (semantic.kind) {
    case 'effects':
      parts.push(shellQuote({ value: option }));
      break;
    case 'deferred': {
      const rawValue = getRawValue({ value });
      parts.push(shellQuote({ value: rawValue === undefined ? option : `${option}=${rawValue}` }));
      break;
    }
    case 'required-value':
      parts.push(shellQuote({ value: option }));
      parts.push(shellQuote({ value: String(getRequiredValue({ action: semantic, value })) }));
      break;
    default: {
      const _ex: never = semantic;
      throw new Error(`Unhandled option occurrence: ${JSON.stringify(_ex)}`);
    }
    }
  }
  const [command, ...optionTokens] = parts;
  const restoredOptions = restoreShortFlagBundles({ tokens: optionTokens, args });
  return [command, ...restoredOptions].join(' ');
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

export const diffCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const flagWithArgument = findUnexpectedLongFlagArgument({ args: context.args });
    if (flagWithArgument !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'diff',
        message: `diff: option '${flagWithArgument}' doesn't allow an argument`,
        usageSummary: diffArgvUsageSummary,
      });
      return { exitCode: 2 };
    }

    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: normalizeOptionalShortContextCounts({ args: context.args }),
        catalog: diffArgvCatalog,
        policy: diffArgvPolicy,
        earlyExitOptions: HELP_VERSION_EARLY_EXIT_OPTIONS,
      }),
      catalog: diffArgvCatalog,
      policy: diffArgvPolicy,
    });
    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      const message = (() => {
        switch (diagnostic.kind) {
        case 'unknown_long_option':
          return `unrecognized option '${diagnostic.option.split('=', 1)[0]}'`;
        case 'unknown_short_option':
        case 'ambiguous_long_option':
        case 'missing_option_value':
        case 'unexpected_option_value':
        case 'invalid_option_value':
          return diagnostic.message;
        default: {
          const _ex: never = diagnostic;
          throw new Error(`Unhandled argv diagnostic: ${JSON.stringify(_ex)}`);
        }
        }
      })();
      await writeCommandUsageError({
        context,
        command: 'diff',
        message: `diff: ${message}`,
        usageSummary: diffArgvUsageSummary,
      });
      return { exitCode: 2 };
    }

    const occurrences = parsed.occurrences ?? [];
    const invalidContext = parsed.deferred.map(({ value }) => getRawValue({ value }))
      .findLast(rawValue => rawValue !== undefined && parseNonnegativeInteger({ rawValue }).kind === 'invalid');
    if (invalidContext !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'diff',
        message: `diff: invalid context length '${invalidContext}'`,
        usageSummary: diffArgvUsageSummary,
      });
      return { exitCode: 2 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({ context, command: 'diff', optionLines: formatArgvOptionHelp({ presentation: diffArgvHelp }) });
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
          usageSummary: diffArgvUsageSummary,
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
          usageSummary: diffArgvUsageSummary,
        });
        return { exitCode: 2 };
      }
      if (parsed.positionals.length > 2) {
        await writeCommandUsageError({
          context,
          command: 'diff',
          message: `diff: extra operand '${parsed.positionals[2]}'`,
          usageSummary: diffArgvUsageSummary,
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

    const labels = collectOccurrenceValues({ occurrences, key: 'label' });
    if (labels.length > 2) {
      await context.text().error({ text: 'diff: too many file label options\n' });
      return { exitCode: 2 };
    }

    const characterLocaleMode = resolveCharacterLocaleMode({ env: context.env });
    const ignorePatterns: RegExp[] = [];
    let functionLinePattern: RegExp | undefined;
    try {
      for (const source of collectOccurrenceValues({ occurrences, key: 'ignoreMatchingLines' })) {
        ignorePatterns.push(compileBasicRegularExpression({
          source,
          flags: '',
          characterClassMode: characterLocaleMode,
          gnuWordOperators: true,
          basicOperatorMode: 'gnu',
          dotMode: 'non-newline',
          excludeSurrogateEscapes: characterLocaleMode === 'unicode',
        }));
      }
      const functionPatternSources = collectOccurrenceValues({
        occurrences,
        key: 'functionLinePattern',
      });
      const functionPatternSource = functionPatternSources[functionPatternSources.length - 1];
      if (functionPatternSource !== undefined) {
        functionLinePattern = compileBasicRegularExpression({
          source: functionPatternSource,
          flags: '',
          characterClassMode: characterLocaleMode,
          gnuWordOperators: true,
          basicOperatorMode: 'gnu',
          dotMode: 'non-newline',
          excludeSurrogateEscapes: characterLocaleMode === 'unicode',
        });
      } else if (parsed.optionValues.showCFunction === true) {
        functionLinePattern = DEFAULT_C_FUNCTION_PATTERN;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `diff: invalid regular expression: ${message}\n` });
      return { exitCode: 2 };
    }

    try {
      const excludeSources = collectOccurrenceValues({ occurrences, key: 'exclude' });
      const excludedFromFiles = await readExcludePatterns({
        context,
        paths: collectOccurrenceValues({ occurrences, key: 'excludeFrom' }),
      });
      for (const excluded of excludedFromFiles) {
        excludeSources.push(excluded);
      }
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
        mode: resolveOutputMode({ occurrences }),
        characterLocaleMode,
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
      const recursiveCommandPrefix = createRecursiveCommandPrefix({ occurrences, args: context.args });
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
  diffArgvCatalog,
  resolveOutputMode,
};
