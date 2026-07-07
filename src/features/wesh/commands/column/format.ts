import { splitTextLines } from '@/features/wesh/commands/_shared/text';
import type { ColumnOptions, ColumnSelector, FillMode, TableModel, TableRow } from './types';

function escapeRegExp({
  text,
}: {
  text: string,
}): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitFields({
  line,
  separators,
  mode,
}: {
  line: string,
  separators: string | undefined,
  mode: 'list' | 'table',
}): string[] {
  if (separators === undefined) {
    const trimmed = line.trim();
    return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  }

  const pattern = new RegExp(`[${escapeRegExp({ text: separators })}]`);
  const fields = line.split(pattern);
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
  separators,
  columnsLimit,
}: {
  line: string,
  separators: string | undefined,
  columnsLimit: number | undefined,
}): string[] {
  if (columnsLimit === undefined) {
    return splitFields({
      line,
      separators,
      mode: 'table',
    });
  }

  if (separators !== undefined) {
    if (columnsLimit === 1) {
      return [line];
    }

    const fields: string[] = [];
    let fieldStart = 0;
    for (let index = 0; index < line.length && fields.length < columnsLimit - 1; index += 1) {
      const character = line[index];
      if (character === undefined || !separators.includes(character)) {
        continue;
      }
      fields.push(line.slice(fieldStart, index));
      fieldStart = index + 1;
    }
    fields.push(line.slice(fieldStart));
    return fields;
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

function isCombiningCodePoint({
  codePoint,
}: {
  codePoint: number,
}): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036F)
    || (codePoint >= 0x1AB0 && codePoint <= 0x1AFF)
    || (codePoint >= 0x1DC0 && codePoint <= 0x1DFF)
    || (codePoint >= 0x20D0 && codePoint <= 0x20FF)
    || (codePoint >= 0xFE20 && codePoint <= 0xFE2F)
  );
}

function isWideCodePoint({
  codePoint,
}: {
  codePoint: number,
}): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115F)
    || codePoint === 0x2329
    || codePoint === 0x232A
    || (codePoint >= 0x2E80 && codePoint <= 0xA4CF)
    || (codePoint >= 0xAC00 && codePoint <= 0xD7A3)
    || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
    || (codePoint >= 0xFE10 && codePoint <= 0xFE19)
    || (codePoint >= 0xFE30 && codePoint <= 0xFE6F)
    || (codePoint >= 0xFF00 && codePoint <= 0xFF60)
    || (codePoint >= 0xFFE0 && codePoint <= 0xFFE6)
  );
}

function getDisplayWidth({
  text,
}: {
  text: string,
}): number {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint === 0 || codePoint < 32 || (codePoint >= 0x7F && codePoint < 0xA0)) {
      continue;
    }
    if (isCombiningCodePoint({ codePoint })) {
      continue;
    }
    width += isWideCodePoint({ codePoint }) ? 2 : 1;
  }
  return width;
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
  for (const line of splitTextLines({ text })) {
    if (!options.keepEmptyLines && line.trim().length === 0) {
      continue;
    }

    const fields = splitFields({
      line,
      separators: options.inputSeparators,
      mode: 'list',
    });
    if (fields.length === 0) {
      if (options.keepEmptyLines) {
        items.push('');
      }
      continue;
    }
    items.push(...fields);
  }
  return items;
}

function arrangeListGrid({
  items,
  columns,
  fillMode,
}: {
  items: string[],
  columns: number,
  fillMode: FillMode,
}): string[][] {
  const rows = Math.ceil(items.length / columns);
  const grid = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ''));

  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    switch (fillMode) {
    case 'columns-before-rows': {
      const row = itemIndex % rows;
      const column = Math.floor(itemIndex / rows);
      grid[row]![column] = items[itemIndex]!;
      break;
    }
    case 'rows-before-columns': {
      const row = Math.floor(itemIndex / columns);
      const column = itemIndex % columns;
      grid[row]![column] = items[itemIndex]!;
      break;
    }
    default: {
      const _ex: never = fillMode;
      throw new Error(`Unhandled fill mode: ${_ex}`);
    }
    }
  }

  return grid;
}

function columnWidths({
  rows,
}: {
  rows: string[][],
}): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (let index = 0; index < row.length; index += 1) {
      widths[index] = Math.max(widths[index] ?? 0, getDisplayWidth({ text: row[index] ?? '' }));
    }
  }
  return widths;
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

function chooseListColumns({
  items,
  outputWidth,
  fillMode,
  separatorWidth,
}: {
  items: string[],
  outputWidth: number,
  fillMode: FillMode,
  separatorWidth: number,
}): number {
  if (items.length === 0) {
    return 0;
  }

  if (outputWidth === 0) {
    return items.length;
  }

  for (let columns = items.length; columns >= 1; columns -= 1) {
    const grid = arrangeListGrid({ items, columns, fillMode });
    const widths = columnWidths({ rows: grid });
    if (listGridWidth({ widths, separatorWidth }) <= outputWidth) {
      return columns;
    }
  }

  return 1;
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
  const columns = chooseListColumns({
    items,
    outputWidth: options.outputWidth,
    fillMode: options.fillMode,
    separatorWidth,
  });
  const grid = arrangeListGrid({
    items,
    columns,
    fillMode: options.fillMode,
  });
  const widths = columnWidths({ rows: grid });
  const outputRows: string[] = [];

  for (const row of grid) {
    let lastColumn = row.length - 1;
    while (lastColumn >= 0 && (row[lastColumn] ?? '') === '') {
      lastColumn -= 1;
    }
    if (lastColumn < 0) {
      outputRows.push('');
      continue;
    }

    let output = '';
    for (let column = 0; column <= lastColumn; column += 1) {
      const cell = row[column] ?? '';
      output += cell;
      if (column < lastColumn) {
        if (minSpaces > 0) {
          const padding = (widths[column] ?? 0) - getDisplayWidth({ text: cell }) + minSpaces;
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
  const rows: TableRow[] = [];
  for (const line of splitTextLines({ text })) {
    if (!options.keepEmptyLines && line.trim().length === 0) {
      continue;
    }

    const fields = splitTableFields({
      line,
      separators: options.inputSeparators,
      columnsLimit: options.tableColumnsLimit,
    });
    rows.push({ fields });
  }

  if (options.tableColumns !== undefined) {
    return { header: options.tableColumns, rows };
  }

  if (options.tableHeaderAsColumns) {
    const [headerRow, ...dataRows] = rows;
    return {
      header: headerRow?.fields ?? [],
      rows: dataRows,
    };
  }

  return { header: undefined, rows };
}

function normalizeTableRows({
  model,
}: {
  model: TableModel,
}): { rows: string[][], header: string[] | undefined } {
  const columnCount = Math.max(
    model.header?.length ?? 0,
    ...model.rows.map((row) => row.fields.length),
    0,
  );
  const normalize = ({ fields }: { fields: string[] }): string[] => [
    ...fields,
    ...Array.from({ length: Math.max(0, columnCount - fields.length) }, () => ''),
  ];

  return {
    header: model.header === undefined ? undefined : normalize({ fields: model.header }),
    rows: model.rows.map((row) => normalize({ fields: row.fields })),
  };
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
    const width = getDisplayWidth({ text: cell });
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
  const { rows, header } = normalizeTableRows({ model });
  const visibleRows = header !== undefined && !options.tableNoHeadings ? [header, ...rows] : rows;
  if (visibleRows.length === 0) {
    return '';
  }

  const widths = columnWidths({ rows: visibleRows });
  const rightAligned = rightAlignedColumns({
    selectors: options.tableRight,
    header,
    columnCount: widths.length,
  });
  const lines = visibleRows.map((row) => renderTableRow({
    row,
    widths,
    rightAligned,
    outputSeparator: options.outputSeparator,
  }));

  return `${lines.join('\n')}\n`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
