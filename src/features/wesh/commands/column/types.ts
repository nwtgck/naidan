import type { WeshCommandContext } from '@/features/wesh/types';

export interface ColumnOptions {
  outputWidth: number,
  inputSeparators: string | undefined,
  useSpaces: number | undefined,
  renderMode: ColumnRenderMode,
  outputSeparator: string,
  tableColumns: string[] | undefined,
  tableNoHeadings: boolean,
  tableHeaderAsColumns: boolean,
  tableRight: ColumnSelector[],
  tableColumnsLimit: number | undefined,
  keepEmptyLines: boolean,
  fillMode: FillMode,
}

export type ColumnRenderMode = 'list' | 'table';

export type FillMode = 'columns-before-rows' | 'rows-before-columns';

export type ColumnSelector =
  | { kind: 'all' }
  | { kind: 'last' }
  | { kind: 'index', value: number }
  | { kind: 'range', start: number, end: number }
  | { kind: 'name', value: string };

export interface TableModel {
  header: string[] | undefined,
  rows: string[][],
}

export type OptionValues = Record<string, boolean | string | number>;

export type NormalizeOptionsResult =
  | { ok: true, options: ColumnOptions }
  | { ok: false, message: string };

export type ColumnContext = Pick<WeshCommandContext, 'cwd' | 'env' | 'files' | 'stdin' | 'text'>;

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
