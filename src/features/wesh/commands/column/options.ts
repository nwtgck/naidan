import { defineArgvCatalog, defineArgvHelpPresentation, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv';
import type {
  ColumnContext,
  ColumnSelector,
  NormalizeOptionsResult,
  OptionValues,
} from './types';

const COLUMN_MAX_LAYOUT_SIZE = 1_000_000;

function parsePositiveInteger({
  value,
  optionName,
}: {
  value: string,
  optionName: string,
}): { kind: 'parsed', value: number } | { kind: 'invalid', message: string } {
  if (!/^[1-9]\d*$/.test(value)) {
    return { kind: 'invalid', message: `${optionName} requires a positive integer` };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed > COLUMN_MAX_LAYOUT_SIZE) {
    return { kind: 'invalid', message: `${optionName} exceeds safety limit ${COLUMN_MAX_LAYOUT_SIZE}` };
  }
  return { kind: 'parsed', value: parsed };
}

function parseOutputWidth({
  rawValue: value,
}: {
  rawValue: string,
}): { kind: 'parsed', value: number } | { kind: 'invalid', message: string } {
  if (value === 'unlimited') {
    return { kind: 'parsed', value: 0 };
  }

  if (!/^\d+$/.test(value)) {
    return { kind: 'invalid', message: "--output-width requires a positive integer, 0, or 'unlimited'" };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed > COLUMN_MAX_LAYOUT_SIZE) {
    return { kind: 'invalid', message: `--output-width exceeds safety limit ${COLUMN_MAX_LAYOUT_SIZE}` };
  }
  return { kind: 'parsed', value: parsed };
}

function parseNonEmptySeparators({
  rawValue: value,
}: {
  rawValue: string,
}): { kind: 'parsed', value: string } | { kind: 'invalid', message: string } {
  if (value.length === 0) {
    return { kind: 'invalid', message: '--separator requires a non-empty separator list' };
  }

  return { kind: 'parsed', value };
}

function parseTableColumnNames({
  rawValue: value,
}: {
  rawValue: string,
}): { kind: 'parsed', value: string } | { kind: 'invalid', message: string } {
  const names = value.split(',');
  if (names.length === 0 || names.some((name) => name.length === 0)) {
    return { kind: 'invalid', message: '--table-columns requires non-empty comma-separated names' };
  }

  return { kind: 'parsed', value };
}

function parseTableRight({
  rawValue: value,
}: {
  rawValue: string,
}): { kind: 'parsed', value: string } | { kind: 'invalid', message: string } {
  if (value.length === 0) {
    return { kind: 'invalid', message: '--table-right requires non-empty column selectors' };
  }

  const selectors = value.split(',');
  if (selectors.some((selector) => selector.length === 0)) {
    return { kind: 'invalid', message: '--table-right requires non-empty column selectors' };
  }

  for (const selector of selectors) {
    const rangeMatch = /^(\d+)-(\d+)$/.exec(selector);
    if (rangeMatch === null) {
      continue;
    }

    const start = Number.parseInt(rangeMatch[1]!, 10);
    const end = Number.parseInt(rangeMatch[2]!, 10);
    if (start < 1 || end < 1 || start > end) {
      return { kind: 'invalid', message: '--table-right requires valid 1-based column ranges' };
    }
  }

  return { kind: 'parsed', value };
}

const columnArgvOptions = [
  {
    semantic: { kind: 'required-value', key: 'outputWidth', parse: parseOutputWidth },
    forms: [
      { kind: 'short', name: 'c', value: { kind: 'required-attached-or-following', missingValueName: 'width' } },
      { kind: 'long', name: 'output-width', value: { kind: 'required', missingValueName: 'width' } },
    ],
    help: { summary: 'format output to WIDTH columns; 0 means unlimited', valueName: 'WIDTH', category: 'common' },
  },
  {
    semantic: { kind: 'required-value', key: 'outputWidth', parse: parseOutputWidth },
    forms: [
      { kind: 'long', name: 'columns', value: { kind: 'required', missingValueName: 'width' } },
    ],
    help: { summary: 'deprecated alias for --output-width', valueName: 'WIDTH', category: 'advanced' },
  },
  {
    semantic: { kind: 'required-value', key: 'inputSeparators', parse: parseNonEmptySeparators },
    forms: [
      { kind: 'short', name: 's', value: { kind: 'required-attached-or-following', missingValueName: 'separators' } },
      { kind: 'long', name: 'separator', value: { kind: 'required', missingValueName: 'separators' } },
    ],
    help: { summary: 'use the possible input item delimiters from SEPARATORS', valueName: 'SEPARATORS', category: 'common' },
  },
  {
    semantic: { kind: 'required-value', key: 'inputSeparators', parse: parseNonEmptySeparators },
    forms: [
      { kind: 'long', name: 'input-separator', value: { kind: 'required', missingValueName: 'separators' } },
    ],
    help: { summary: 'alias for --separator', valueName: 'SEPARATORS', category: 'advanced' },
  },
  {
    semantic: { kind: 'required-value', key: 'useSpaces', parse: ({ rawValue: value }: { rawValue: string }) => parsePositiveInteger({ value, optionName: '--use-spaces' }) },
    forms: [
      { kind: 'short', name: 'S', value: { kind: 'required-attached-or-following', missingValueName: 'number' } },
      { kind: 'long', name: 'use-spaces', value: { kind: 'required', missingValueName: 'number' } },
    ],
    help: { summary: 'use at least NUMBER spaces between list columns', valueName: 'NUMBER', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'renderMode', value: 'table' }] },
    forms: [
      { kind: 'short', name: 't', value: { kind: 'none' } },
      { kind: 'long', name: 'table', value: { kind: 'none' } },
    ],
    help: { summary: 'create a table from input columns', category: 'common' },
  },
  {
    semantic: { kind: 'required-value', key: 'outputSeparator', parse: undefined },
    forms: [
      { kind: 'short', name: 'o', value: { kind: 'required-attached-or-following', missingValueName: 'string' } },
      { kind: 'long', name: 'output-separator', value: { kind: 'required', missingValueName: 'string' } },
    ],
    help: { summary: 'use STRING to separate table output columns', valueName: 'STRING', category: 'common' },
  },
  {
    semantic: { kind: 'required-value', key: 'tableColumns', parse: parseTableColumnNames },
    forms: [
      { kind: 'short', name: 'N', value: { kind: 'required-attached-or-following', missingValueName: 'names' } },
      { kind: 'long', name: 'table-columns', value: { kind: 'required', missingValueName: 'names' } },
    ],
    help: { summary: 'use comma-separated NAMES as table column headers', valueName: 'NAMES', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'tableNoHeadings', value: true }] },
    forms: [
      { kind: 'short', name: 'd', value: { kind: 'none' } },
      { kind: 'long', name: 'table-noheadings', value: { kind: 'none' } },
    ],
    help: { summary: 'do not print table headers', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'tableHeaderAsColumns', value: true }] },
    forms: [
      { kind: 'short', name: 'K', value: { kind: 'none' } },
      { kind: 'long', name: 'table-header-as-columns', value: { kind: 'none' } },
    ],
    help: { summary: 'use the first input line as table column headers', category: 'common' },
  },
  {
    semantic: { kind: 'required-value', key: 'tableRight', parse: parseTableRight },
    forms: [
      { kind: 'short', name: 'R', value: { kind: 'required-attached-or-following', missingValueName: 'columns' } },
      { kind: 'long', name: 'table-right', value: { kind: 'required', missingValueName: 'columns' } },
    ],
    help: { summary: 'right-align the specified table columns', valueName: 'COLUMNS', category: 'common' },
  },
  {
    semantic: { kind: 'required-value', key: 'tableColumnsLimit', parse: ({ rawValue: value }: { rawValue: string }) => parsePositiveInteger({ value, optionName: '--table-columns-limit' }) },
    forms: [
      { kind: 'short', name: 'l', value: { kind: 'required-attached-or-following', missingValueName: 'number' } },
      { kind: 'long', name: 'table-columns-limit', value: { kind: 'required', missingValueName: 'number' } },
    ],
    help: { summary: 'limit table parsing to NUMBER columns', valueName: 'NUMBER', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'keepEmptyLines', value: true }] },
    forms: [
      { kind: 'short', name: 'L', value: { kind: 'none' } },
      { kind: 'long', name: 'keep-empty-lines', value: { kind: 'none' } },
    ],
    help: { summary: 'preserve empty input lines', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'fillMode', value: 'rows-before-columns' }] },
    forms: [
      { kind: 'short', name: 'x', value: { kind: 'none' } },
      { kind: 'long', name: 'fillrows', value: { kind: 'none' } },
    ],
    help: { summary: 'fill rows before columns in list mode', category: 'common' },
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [
      { kind: 'short', name: 'h', value: { kind: 'none' } },
      { kind: 'long', name: 'help', value: { kind: 'none' } },
    ],
    help: { summary: 'display this help and exit', category: 'common' },
  },
] as const;

export const columnArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({ definitions: columnArgvOptions, nonExecutableLongOptions: [] });
export const columnArgvHelp = defineArgvHelpPresentation({
  catalog: columnArgvCatalog,
  rows: columnArgvOptions.map(({ forms, help }) => ({ forms, ...help })),
});
export const columnArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

function parseColumnsEnv({
  value,
}: {
  value: string | undefined,
}): number | undefined {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed <= COLUMN_MAX_LAYOUT_SIZE
    ? parsed
    : undefined;
}

function parseSelectors({
  value,
}: {
  value: string,
}): ColumnSelector[] {
  return value.split(',').map((selector) => {
    if (selector === '0') {
      return { kind: 'all' };
    }
    if (selector === '-1') {
      return { kind: 'last' };
    }

    const rangeMatch = /^(\d+)-(\d+)$/.exec(selector);
    if (rangeMatch !== null) {
      const start = Number.parseInt(rangeMatch[1]!, 10);
      const end = Number.parseInt(rangeMatch[2]!, 10);
      return { kind: 'range', start, end };
    }

    if (/^[1-9]\d*$/.test(selector)) {
      return { kind: 'index', value: Number.parseInt(selector, 10) };
    }

    return { kind: 'name', value: selector };
  });
}

export function normalizeOptions({
  context,
  optionValues,
}: {
  context: ColumnContext,
  optionValues: OptionValues,
}): NormalizeOptionsResult {
  const outputWidth = typeof optionValues.outputWidth === 'number'
    ? optionValues.outputWidth
    : parseColumnsEnv({ value: context.env.get('COLUMNS') }) ?? 80;
  const tableColumns = typeof optionValues.tableColumns === 'string'
    ? optionValues.tableColumns.split(',')
    : undefined;
  const tableHeaderAsColumns = optionValues.tableHeaderAsColumns === true;

  if (tableHeaderAsColumns && tableColumns !== undefined) {
    return { ok: false, message: 'column: --table-header-as-columns cannot be used with --table-columns' };
  }

  return {
    ok: true,
    options: {
      outputWidth,
      inputSeparators: typeof optionValues.inputSeparators === 'string' ? optionValues.inputSeparators : undefined,
      useSpaces: typeof optionValues.useSpaces === 'number' ? optionValues.useSpaces : undefined,
      renderMode: optionValues.renderMode === 'table' ? 'table' : 'list',
      outputSeparator: typeof optionValues.outputSeparator === 'string' ? optionValues.outputSeparator : '  ',
      tableColumns,
      tableNoHeadings: optionValues.tableNoHeadings === true,
      tableHeaderAsColumns,
      tableRight: typeof optionValues.tableRight === 'string' ? parseSelectors({ value: optionValues.tableRight }) : [],
      tableColumnsLimit: typeof optionValues.tableColumnsLimit === 'number' ? optionValues.tableColumnsLimit : undefined,
      keepEmptyLines: optionValues.keepEmptyLines === true,
      fillMode: optionValues.fillMode === 'rows-before-columns' ? 'rows-before-columns' : 'columns-before-rows',
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
