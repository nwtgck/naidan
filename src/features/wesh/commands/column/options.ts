import type { StandardArgvParserSpec } from '@/features/wesh/argv';
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
}): { ok: true, value: number } | { ok: false, message: string } {
  if (!/^[1-9]\d*$/.test(value)) {
    return { ok: false, message: `${optionName} requires a positive integer` };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed > COLUMN_MAX_LAYOUT_SIZE) {
    return { ok: false, message: `${optionName} exceeds safety limit ${COLUMN_MAX_LAYOUT_SIZE}` };
  }
  return { ok: true, value: parsed };
}

function parseOutputWidth({
  value,
}: {
  value: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  if (value === 'unlimited') {
    return { ok: true, value: 0 };
  }

  if (!/^\d+$/.test(value)) {
    return { ok: false, message: "--output-width requires a positive integer, 0, or 'unlimited'" };
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed > COLUMN_MAX_LAYOUT_SIZE) {
    return { ok: false, message: `--output-width exceeds safety limit ${COLUMN_MAX_LAYOUT_SIZE}` };
  }
  return { ok: true, value: parsed };
}

function parseNonEmptySeparators({
  value,
}: {
  value: string,
}): { ok: true, value: string } | { ok: false, message: string } {
  if (value.length === 0) {
    return { ok: false, message: '--separator requires a non-empty separator list' };
  }

  return { ok: true, value };
}

function parseTableColumnNames({
  value,
}: {
  value: string,
}): { ok: true, value: string } | { ok: false, message: string } {
  const names = value.split(',');
  if (names.length === 0 || names.some((name) => name.length === 0)) {
    return { ok: false, message: '--table-columns requires non-empty comma-separated names' };
  }

  return { ok: true, value };
}

function parseTableRight({
  value,
}: {
  value: string,
}): { ok: true, value: string } | { ok: false, message: string } {
  if (value.length === 0) {
    return { ok: false, message: '--table-right requires non-empty column selectors' };
  }

  const selectors = value.split(',');
  if (selectors.some((selector) => selector.length === 0)) {
    return { ok: false, message: '--table-right requires non-empty column selectors' };
  }

  for (const selector of selectors) {
    const rangeMatch = /^(\d+)-(\d+)$/.exec(selector);
    if (rangeMatch === null) {
      continue;
    }

    const start = Number.parseInt(rangeMatch[1]!, 10);
    const end = Number.parseInt(rangeMatch[2]!, 10);
    if (start < 1 || end < 1 || start > end) {
      return { ok: false, message: '--table-right requires valid 1-based column ranges' };
    }
  }

  return { ok: true, value };
}

export const columnArgvSpec: StandardArgvParserSpec = {
  options: [
    {
      kind: 'value',
      short: 'c',
      long: 'output-width',
      key: 'outputWidth',
      valueName: 'width',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseOutputWidth({ value }),
      help: { summary: 'format output to WIDTH columns; 0 means unlimited', valueName: 'WIDTH', category: 'common' },
    },
    {
      kind: 'value',
      short: undefined,
      long: 'columns',
      key: 'outputWidth',
      valueName: 'width',
      allowAttachedValue: false,
      parseValue: ({ value }) => parseOutputWidth({ value }),
      help: { summary: 'deprecated alias for --output-width', valueName: 'WIDTH', category: 'advanced' },
    },
    {
      kind: 'value',
      short: 's',
      long: 'separator',
      key: 'inputSeparators',
      valueName: 'separators',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseNonEmptySeparators({ value }),
      help: { summary: 'use the possible input item delimiters from SEPARATORS', valueName: 'SEPARATORS', category: 'common' },
    },
    {
      kind: 'value',
      short: undefined,
      long: 'input-separator',
      key: 'inputSeparators',
      valueName: 'separators',
      allowAttachedValue: false,
      parseValue: ({ value }) => parseNonEmptySeparators({ value }),
      help: { summary: 'alias for --separator', valueName: 'SEPARATORS', category: 'advanced' },
    },
    {
      kind: 'value',
      short: 'S',
      long: 'use-spaces',
      key: 'useSpaces',
      valueName: 'number',
      allowAttachedValue: true,
      parseValue: ({ value }) => parsePositiveInteger({ value, optionName: '--use-spaces' }),
      help: { summary: 'use at least NUMBER spaces between list columns', valueName: 'NUMBER', category: 'common' },
    },
    {
      kind: 'flag',
      short: 't',
      long: 'table',
      effects: [{ key: 'renderMode', value: 'table' }],
      help: { summary: 'create a table from input columns', category: 'common' },
    },
    {
      kind: 'value',
      short: 'o',
      long: 'output-separator',
      key: 'outputSeparator',
      valueName: 'string',
      allowAttachedValue: true,
      parseValue: undefined,
      help: { summary: 'use STRING to separate table output columns', valueName: 'STRING', category: 'common' },
    },
    {
      kind: 'value',
      short: 'N',
      long: 'table-columns',
      key: 'tableColumns',
      valueName: 'names',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseTableColumnNames({ value }),
      help: { summary: 'use comma-separated NAMES as table column headers', valueName: 'NAMES', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'd',
      long: 'table-noheadings',
      effects: [{ key: 'tableNoHeadings', value: true }],
      help: { summary: 'do not print table headers', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'K',
      long: 'table-header-as-columns',
      effects: [{ key: 'tableHeaderAsColumns', value: true }],
      help: { summary: 'use the first input line as table column headers', category: 'common' },
    },
    {
      kind: 'value',
      short: 'R',
      long: 'table-right',
      key: 'tableRight',
      valueName: 'columns',
      allowAttachedValue: true,
      parseValue: ({ value }) => parseTableRight({ value }),
      help: { summary: 'right-align the specified table columns', valueName: 'COLUMNS', category: 'common' },
    },
    {
      kind: 'value',
      short: 'l',
      long: 'table-columns-limit',
      key: 'tableColumnsLimit',
      valueName: 'number',
      allowAttachedValue: true,
      parseValue: ({ value }) => parsePositiveInteger({ value, optionName: '--table-columns-limit' }),
      help: { summary: 'limit table parsing to NUMBER columns', valueName: 'NUMBER', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'L',
      long: 'keep-empty-lines',
      effects: [{ key: 'keepEmptyLines', value: true }],
      help: { summary: 'preserve empty input lines', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'x',
      long: 'fillrows',
      effects: [{ key: 'fillMode', value: 'rows-before-columns' }],
      help: { summary: 'fill rows before columns in list mode', category: 'common' },
    },
    {
      kind: 'flag',
      short: 'h',
      long: 'help',
      effects: [{ key: 'help', value: true }],
      help: { summary: 'display this help and exit', category: 'common' },
    },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
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
