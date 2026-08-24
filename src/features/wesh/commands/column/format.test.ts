import { describe, expect, it } from 'vitest';
import type { FillMode } from './types';
import { TEST_ONLY } from './format';

function referenceListColumnWidths({
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
    const column = fillMode === 'columns-before-rows'
      ? Math.floor(itemIndex / rows)
      : itemIndex % columns;
    widths[column] = Math.max(widths[column] ?? 0, itemWidths[itemIndex] ?? 0);
  }
  return widths;
}

function referenceListGridWidth({
  widths,
  separatorWidth,
}: {
  widths: number[],
  separatorWidth: number,
}): number {
  if (widths.length === 0) return 0;
  let width = separatorWidth * (widths.length - 1);
  for (const columnWidth of widths) width += columnWidth;
  return width;
}

function referenceChooseListLayout({
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
  if (itemWidths.length === 0) return { columns: 0, widths: [] };
  for (let columns = itemWidths.length; columns >= 1; columns -= 1) {
    const widths = referenceListColumnWidths({ itemWidths, columns, fillMode });
    if (outputWidth === 0 || referenceListGridWidth({ widths, separatorWidth }) <= outputWidth) {
      return { columns, widths };
    }
  }
  let maximumWidth = 0;
  for (const itemWidth of itemWidths) maximumWidth = Math.max(maximumWidth, itemWidth);
  return { columns: 1, widths: [maximumWidth] };
}

function seededWidths({ seed, count }: { seed: number, count: number }): number[] {
  let state = seed >>> 0;
  return Array.from({ length: count }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state % 17;
  });
}

function exhaustiveWidths({ maximumLength }: { maximumLength: number }): number[][] {
  const inputs: number[][] = [];
  for (let length = 0; length <= maximumLength; length += 1) {
    const combinationCount = 4 ** length;
    for (let encoded = 0; encoded < combinationCount; encoded += 1) {
      let remaining = encoded;
      const widths: number[] = [];
      for (let index = 0; index < length; index += 1) {
        widths.push(remaining % 4);
        remaining = Math.floor(remaining / 4);
      }
      inputs.push(widths);
    }
  }
  return inputs;
}

describe('column list layout', () => {
  it('matches exhaustive candidate selection for fixed and generated layouts', () => {
    const inputs: number[][] = [
      ...exhaustiveWidths({ maximumLength: 5 }),
      [10, 0, 2, 7, 1],
    ];
    for (let seed = 1; seed <= 80; seed += 1) {
      inputs.push(seededWidths({ seed, count: seed % 31 }));
    }

    for (const itemWidths of inputs) {
      for (const fillMode of ['columns-before-rows', 'rows-before-columns'] as const) {
        for (const separatorWidth of [1, 2, 8]) {
          for (const outputWidth of [0, 1, 7, 8, 9, 15, 40, 80, 121]) {
            expect(TEST_ONLY.chooseListLayout({
              itemWidths,
              outputWidth,
              fillMode,
              separatorWidth,
            })).toEqual(referenceChooseListLayout({
              itemWidths,
              outputWidth,
              fillMode,
              separatorWidth,
            }));
          }
        }
      }
    }
  });
});
