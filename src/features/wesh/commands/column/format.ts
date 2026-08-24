import { splitTextLines } from '@/features/wesh/commands/_shared/text';
import { getWeshTextDisplayWidth } from '@/features/wesh/utils/display-width';
import type { ColumnOptions, ColumnSelector, FillMode, TableModel } from './types';

function splitAtSeparators({
  line,
  separatorCharacters,
  columnsLimit,
}: {
  line: string,
  separatorCharacters: ReadonlySet<string>,
  columnsLimit: number | undefined,
}): string[] {
  if (columnsLimit === 1) return [line];

  const fields: string[] = [];
  let fieldStart = 0;
  let offset = 0;
  for (const character of line) {
    const characterStart = offset;
    offset += character.length;
    if (!separatorCharacters.has(character)) continue;
    if (columnsLimit !== undefined && fields.length >= columnsLimit - 1) continue;
    fields.push(line.slice(fieldStart, characterStart));
    fieldStart = offset;
  }
  fields.push(line.slice(fieldStart));
  return fields;
}

function splitFields({
  line,
  separatorCharacters,
  mode,
}: {
  line: string,
  separatorCharacters: ReadonlySet<string> | undefined,
  mode: 'list' | 'table',
}): string[] {
  if (separatorCharacters === undefined) {
    const trimmed = line.trim();
    return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  }

  const fields = splitAtSeparators({
    line,
    separatorCharacters,
    columnsLimit: undefined,
  });
  switch (mode) {
  case 'table':
    return fields;
  case 'list':
    return fields.filter((field) => field.length > 0);
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled split mode: ${_ex}`);
  }
  }
}

function splitTableFields({
  line,
  separatorCharacters,
  columnsLimit,
}: {
  line: string,
  separatorCharacters: ReadonlySet<string> | undefined,
  columnsLimit: number | undefined,
}): string[] {
  if (columnsLimit === undefined) {
    return splitFields({
      line,
      separatorCharacters,
      mode: 'table',
    });
  }

  if (separatorCharacters !== undefined) {
    return splitAtSeparators({
      line,
      separatorCharacters,
      columnsLimit,
    });
  }

  let remaining = line.trim();
  if (remaining.length === 0) {
    return [];
  }

  if (columnsLimit === 1) {
    return [remaining];
  }

  const fields: string[] = [];
  while (fields.length < columnsLimit - 1 && remaining.length > 0) {
    const match = /^(\S+)(?:\s+(.*))?$/.exec(remaining);
    if (match === null) {
      break;
    }
    fields.push(match[1]!);
    remaining = match[2] ?? '';
  }

  if (remaining.length > 0) {
    fields.push(remaining);
  }

  return fields;
}

function spaces({
  count,
}: {
  count: number,
}): string {
  return ' '.repeat(Math.max(0, count));
}

function collectListItems({
  text,
  options,
}: {
  text: string,
  options: ColumnOptions,
}): string[] {
  const items: string[] = [];
  const separatorCharacters = options.inputSeparators === undefined
    ? undefined
    : new Set(options.inputSeparators);
  for (const line of splitTextLines({ text })) {
    if (!options.keepEmptyLines && line.trim().length === 0) {
      continue;
    }

    const fields = splitFields({
      line,
      separatorCharacters,
      mode: 'list',
    });
    if (fields.length === 0) {
      if (options.keepEmptyLines) {
        items.push('');
      }
      continue;
    }
    for (const field of fields) items.push(field);
  }
  return items;
}

function listItemIndex({
  row,
  column,
  rows,
  columns,
  fillMode,
  itemCount,
}: {
  row: number,
  column: number,
  rows: number,
  columns: number,
  fillMode: FillMode,
  itemCount: number,
}): number | undefined {
  const itemIndex = (() => {
    switch (fillMode) {
    case 'columns-before-rows':
      return column * rows + row;
    case 'rows-before-columns':
      return row * columns + column;
    default: {
      const _ex: never = fillMode;
      throw new Error(`Unhandled fill mode: ${_ex}`);
    }
    }
  })();
  return itemIndex < itemCount ? itemIndex : undefined;
}

function includeTableRowWidths({
  widths,
  row,
}: {
  widths: number[],
  row: string[],
}): void {
  for (let index = 0; index < row.length; index += 1) {
    widths[index] = Math.max(widths[index] ?? 0, getWeshTextDisplayWidth({ text: row[index] ?? '', initialColumn: 0, tabSize: undefined }));
  }
}

function listGridWidth({
  widths,
  separatorWidth,
}: {
  widths: number[],
  separatorWidth: number,
}): number {
  if (widths.length === 0) {
    return 0;
  }

  return widths.reduce((sum, width) => sum + width, 0) + separatorWidth * (widths.length - 1);
}

function listColumnWidths({
  itemWidths,
  columns,
  fillMode,
}: {
  itemWidths: number[],
  columns: number,
  fillMode: FillMode,
}): number[] {
  const rows = Math.ceil(itemWidths.length / columns);
  const widths = Array.from({ length: columns }, () => 0);
  for (let itemIndex = 0; itemIndex < itemWidths.length; itemIndex += 1) {
    const column = (() => {
      switch (fillMode) {
      case 'columns-before-rows':
        return Math.floor(itemIndex / rows);
      case 'rows-before-columns':
        return itemIndex % columns;
      default: {
        const _ex: never = fillMode;
        throw new Error(`Unhandled fill mode: ${_ex}`);
      }
      }
    })();
    widths[column] = Math.max(widths[column] ?? 0, itemWidths[itemIndex] ?? 0);
  }
  return widths;
}

function maximumListColumnsByLowerBound({
  itemWidths,
  maximumColumns,
  outputWidth,
  fillMode,
  separatorWidth,
}: {
  itemWidths: number[],
  maximumColumns: number,
  outputWidth: number,
  fillMode: FillMode,
  separatorWidth: number,
}): number {
  let totalWidth = 0;
  let minimumWidth = Number.POSITIVE_INFINITY;
  let maximumWidth = 0;
  for (const width of itemWidths) {
    totalWidth += width;
    minimumWidth = Math.min(minimumWidth, width);
    maximumWidth = Math.max(maximumWidth, width);
  }

  // This bound is monotonic even though the exact grid width is not. Every
  // populated column contributes at least the minimum item width, one column
  // contributes the maximum, and a column maximum can account for at most
  // `rows` item widths. Binary search only removes candidates that cannot fit;
  // chooseListLayout still evaluates the remaining candidates exactly.
  const lowerBound = ({ columns }: { columns: number }): number => {
    const rows = Math.ceil(itemWidths.length / columns);
    const usedColumns = (() => {
      switch (fillMode) {
      case 'columns-before-rows':
        return Math.ceil(itemWidths.length / rows);
      case 'rows-before-columns':
        return columns;
      default: {
        const _ex: never = fillMode;
        throw new Error(`Unhandled fill mode: ${_ex}`);
      }
      }
    })();
    const maximaFromMinimum = maximumWidth + Math.max(0, usedColumns - 1) * minimumWidth;
    const maximaFromAverage = Math.ceil(totalWidth / rows);
    return Math.max(maximaFromMinimum, maximaFromAverage) + separatorWidth * (columns - 1);
  };

  let low = 1;
  let high = maximumColumns;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (lowerBound({ columns: middle }) <= outputWidth) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

function chooseListLayout({
  itemWidths,
  outputWidth,
  fillMode,
  separatorWidth,
}: {
  itemWidths: number[],
  outputWidth: number,
  fillMode: FillMode,
  separatorWidth: number,
}): { columns: number, widths: number[] } {
  if (itemWidths.length === 0) {
    return { columns: 0, widths: [] };
  }

  const separatorBound = outputWidth === 0
    ? itemWidths.length
    : Math.min(itemWidths.length, Math.floor(outputWidth / separatorWidth) + 1);
  const maximumColumns = outputWidth === 0
    ? separatorBound
    : maximumListColumnsByLowerBound({
      itemWidths,
      maximumColumns: separatorBound,
      outputWidth,
      fillMode,
      separatorWidth,
    });
  for (let columns = maximumColumns; columns >= 1; columns -= 1) {
    const widths = listColumnWidths({ itemWidths, columns, fillMode });
    if (outputWidth === 0 || listGridWidth({ widths, separatorWidth }) <= outputWidth) {
      return { columns, widths };
    }
  }

  let maximumWidth = 0;
  for (const itemWidth of itemWidths) maximumWidth = Math.max(maximumWidth, itemWidth);
  return { columns: 1, widths: [maximumWidth] };
}

export function renderList({
  text,
  options,
}: {
  text: string,
  options: ColumnOptions,
}): string {
  const items = collectListItems({ text, options });
  if (items.length === 0) {
    return '';
  }

  const minSpaces = options.useSpaces ?? 0;
  const separatorWidth = minSpaces > 0 ? minSpaces : 8;
  const itemWidths = items.map((item) => getWeshTextDisplayWidth({ text: item, initialColumn: 0, tabSize: undefined }));
  const { columns, widths } = chooseListLayout({
    itemWidths,
    outputWidth: options.outputWidth,
    fillMode: options.fillMode,
    separatorWidth,
  });
  const rowCount = Math.ceil(items.length / columns);
  const outputRows: string[] = [];

  for (let row = 0; row < rowCount; row += 1) {
    let lastColumn = columns - 1;
    while (lastColumn >= 0) {
      const itemIndex = listItemIndex({
        row,
        column: lastColumn,
        rows: rowCount,
        columns,
        fillMode: options.fillMode,
        itemCount: items.length,
      });
      if (itemIndex !== undefined && items[itemIndex] !== '') {
        break;
      }
      lastColumn -= 1;
    }
    if (lastColumn < 0) {
      outputRows.push('');
      continue;
    }

    let output = '';
    for (let column = 0; column <= lastColumn; column += 1) {
      const itemIndex = listItemIndex({
        row,
        column,
        rows: rowCount,
        columns,
        fillMode: options.fillMode,
        itemCount: items.length,
      });
      const cell = itemIndex === undefined ? '' : items[itemIndex]!;
      output += cell;
      if (column < lastColumn) {
        if (minSpaces > 0) {
          const cellWidth = itemIndex === undefined ? 0 : itemWidths[itemIndex] ?? 0;
          const padding = (widths[column] ?? 0) - cellWidth + minSpaces;
          output += spaces({ count: padding });
        } else {
          output += '\t';
        }
      }
    }
    outputRows.push(output);
  }

  return `${outputRows.join('\n')}\n`;
}

function buildTableModel({
  text,
  options,
}: {
  text: string,
  options: ColumnOptions,
}): TableModel {
  const rows: string[][] = [];
  let inputHeader: string[] | undefined;
  const separatorCharacters = options.inputSeparators === undefined
    ? undefined
    : new Set(options.inputSeparators);
  for (const line of splitTextLines({ text })) {
    if (!options.keepEmptyLines && line.trim().length === 0) {
      continue;
    }

    const fields = splitTableFields({
      line,
      separatorCharacters,
      columnsLimit: options.tableColumnsLimit,
    });
    if (options.tableHeaderAsColumns && inputHeader === undefined) {
      inputHeader = fields;
    } else {
      rows.push(fields);
    }
  }

  if (options.tableColumns !== undefined) {
    return { header: options.tableColumns, rows };
  }

  if (options.tableHeaderAsColumns) {
    return { header: inputHeader ?? [], rows };
  }

  return { header: undefined, rows };
}

function tableColumnCount({ model }: { model: TableModel }): number {
  let columnCount = model.header?.length ?? 0;
  for (const row of model.rows) columnCount = Math.max(columnCount, row.length);
  return columnCount;
}

function selectorMatches({
  selector,
  columnIndex,
  header,
  columnCount,
}: {
  selector: ColumnSelector,
  columnIndex: number,
  header: string[] | undefined,
  columnCount: number,
}): boolean {
  const oneBased = columnIndex + 1;
  switch (selector.kind) {
  case 'all':
    return true;
  case 'last':
    return columnIndex === columnCount - 1;
  case 'index':
    return oneBased === selector.value;
  case 'range':
    return oneBased >= selector.start && oneBased <= selector.end;
  case 'name':
    return (header?.[columnIndex] ?? undefined) === selector.value;
  default: {
    const _ex: never = selector;
    throw new Error(`Unhandled column selector: ${JSON.stringify(_ex)}`);
  }
  }
}

function rightAlignedColumns({
  selectors,
  header,
  columnCount,
}: {
  selectors: ColumnSelector[],
  header: string[] | undefined,
  columnCount: number,
}): Set<number> {
  const result = new Set<number>();
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    if (selectors.some((selector) => selectorMatches({ selector, columnIndex, header, columnCount }))) {
      result.add(columnIndex);
    }
  }

  return result;
}

function renderTableRow({
  row,
  widths,
  rightAligned,
  outputSeparator,
}: {
  row: string[],
  widths: number[],
  rightAligned: Set<number>,
  outputSeparator: string,
}): string {
  let output = '';
  let lastColumn = row.length - 1;
  while (lastColumn >= 0 && (row[lastColumn] ?? '') === '') {
    lastColumn -= 1;
  }

  if (lastColumn < 0) {
    return '';
  }

  for (let column = 0; column <= lastColumn; column += 1) {
    const cell = row[column] ?? '';
    const width = getWeshTextDisplayWidth({ text: cell, initialColumn: 0, tabSize: undefined });
    const padding = (widths[column] ?? 0) - width;
    if (rightAligned.has(column)) {
      output += spaces({ count: padding }) + cell;
    } else {
      output += cell;
    }

    if (column < lastColumn) {
      if (!rightAligned.has(column)) {
        output += spaces({ count: padding });
      }
      output += outputSeparator;
    }
  }

  return output;
}

export function renderTable({
  text,
  options,
}: {
  text: string,
  options: ColumnOptions,
}): string {
  const model = buildTableModel({ text, options });
  const { rows, header } = model;
  const showHeader = header !== undefined && !options.tableNoHeadings;
  if (!showHeader && rows.length === 0) {
    return '';
  }

  const widths: number[] = [];
  if (showHeader) includeTableRowWidths({ widths, row: header });
  for (const row of rows) includeTableRowWidths({ widths, row });
  const rightAligned = rightAlignedColumns({
    selectors: options.tableRight,
    header,
    columnCount: tableColumnCount({ model }),
  });
  const lines: string[] = [];
  if (showHeader) {
    lines.push(renderTableRow({
      row: header,
      widths,
      rightAligned,
      outputSeparator: options.outputSeparator,
    }));
  }
  for (const row of rows) {
    lines.push(renderTableRow({
      row,
      widths,
      rightAligned,
      outputSeparator: options.outputSeparator,
    }));
  }

  return `${lines.join('\n')}\n`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  chooseListLayout,
};
