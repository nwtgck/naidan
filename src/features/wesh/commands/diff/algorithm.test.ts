import { describe, expect, it } from 'vitest';
import { createChangeGroups, createDiffOperations, createHunks } from './algorithm';
import type { DiffOperation } from './model';

function applyOperations({
  left,
  right,
  operations,
}: {
  left: readonly string[],
  right: readonly string[],
  operations: readonly DiffOperation[],
}): string[] {
  const result: string[] = [];
  for (const operation of operations) {
    switch (operation.kind) {
    case 'equal':
      result.push(...left.slice(operation.leftStart, operation.leftStart + operation.length));
      break;
    case 'delete':
      break;
    case 'insert':
      result.push(...right.slice(operation.rightStart, operation.rightStart + operation.length));
      break;
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled operation: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return result;
}

function editCost({ operations }: { operations: readonly DiffOperation[] }): number {
  return operations.reduce((total, operation) => (
    operation.kind === 'equal' ? total : total + operation.length
  ), 0);
}

function dynamicProgrammingEditCost({
  left,
  right,
}: {
  left: readonly string[],
  right: readonly string[],
}): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
    const current = new Array<number>(right.length + 1);
    current[0] = leftIndex + 1;
    for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
      current[rightIndex + 1] = left[leftIndex] === right[rightIndex]
        ? previous[rightIndex]!
        : Math.min(previous[rightIndex + 1]!, current[rightIndex]!) + 1;
    }
    previous = current;
  }
  return previous[right.length]!;
}

function createOperations({
  left,
  right,
  preferSpeedOverCompatibility = false,
}: {
  left: readonly string[],
  right: readonly string[],
  preferSpeedOverCompatibility?: boolean,
}): DiffOperation[] {
  return createDiffOperations({
    leftLength: left.length,
    rightLength: right.length,
    areEqual: ({ leftIndex, rightIndex }) => left[leftIndex] === right[rightIndex],
    areExactlyEqual: ({ leftIndex, rightIndex }) => left[leftIndex] === right[rightIndex],
    preferSpeedOverCompatibility,
  });
}

function sequences({ alphabet, maximumLength }: { alphabet: readonly string[], maximumLength: number }): string[][] {
  const result: string[][] = [[]];
  for (let length = 1; length <= maximumLength; length++) {
    const previous = result.filter((value) => value.length === length - 1);
    for (const prefix of previous) {
      for (const value of alphabet) {
        result.push([...prefix, value]);
      }
    }
  }
  return result;
}

describe('wesh diff algorithm', () => {
  it('reconstructs the right input and finds a minimum edit sequence exhaustively', () => {
    const values = sequences({ alphabet: ['a', 'b'], maximumLength: 5 });
    for (const left of values) {
      for (const right of values) {
        for (const preferSpeedOverCompatibility of [false, true]) {
          const operations = createOperations({ left, right, preferSpeedOverCompatibility });
          expect(applyOperations({ left, right, operations })).toEqual(right);
          expect(editCost({ operations })).toBe(dynamicProgrammingEditCost({ left, right }));
        }
      }
    }
  });

  it('is deterministic for repeated and ambiguous lines', () => {
    const left = ['a', 'b', 'a', 'b', 'a'];
    const right = ['b', 'a', 'b', 'a', 'b'];
    const first = createOperations({ left, right });
    const second = createOperations({ left, right });

    expect(second).toEqual(first);
    expect(applyOperations({ left, right, operations: first })).toEqual(right);
  });

  it('shifts duplicate anchors to join adjacent changes without reducing the LCS', () => {
    const left = ['same', 'left-only', 'duplicate'];
    const right = ['same', 'duplicate', 'duplicate'];
    const operations = createOperations({ left, right });

    expect(operations).toEqual([
      { kind: 'equal', leftStart: 0, rightStart: 0, length: 1 },
      { kind: 'delete', leftStart: 1, rightStart: 1, length: 1 },
      { kind: 'insert', leftStart: 2, rightStart: 1, length: 1 },
      { kind: 'equal', leftStart: 2, rightStart: 2, length: 1 },
    ]);
  });

  it('prefers a raw-exact anchor when comparison-equivalent duplicates tie', () => {
    const left = ['BETA', 'Beta'];
    const right = ['Beta'];
    const operations = createDiffOperations({
      leftLength: left.length,
      rightLength: right.length,
      areEqual: ({ leftIndex, rightIndex }) => (
        left[leftIndex]?.toLowerCase() === right[rightIndex]?.toLowerCase()
      ),
      areExactlyEqual: ({ leftIndex, rightIndex }) => left[leftIndex] === right[rightIndex],
      preferSpeedOverCompatibility: false,
    });

    expect(operations).toEqual([
      { kind: 'delete', leftStart: 0, rightStart: 0, length: 1 },
      { kind: 'equal', leftStart: 1, rightStart: 0, length: 1 },
    ]);
  });

  it('preserves raw-exact anchor preference above the bounded dynamic-programming threshold', () => {
    const tail = Array.from({ length: 511 }, (_value, index) => `tail-${index}`);
    const left = ['BETA', 'Beta', ...tail];
    const right = ['Beta', ...tail];
    const operations = createDiffOperations({
      leftLength: left.length,
      rightLength: right.length,
      areEqual: ({ leftIndex, rightIndex }) => (
        left[leftIndex]?.toLowerCase() === right[rightIndex]?.toLowerCase()
      ),
      areExactlyEqual: ({ leftIndex, rightIndex }) => left[leftIndex] === right[rightIndex],
      preferSpeedOverCompatibility: false,
    });

    expect(operations).toEqual([
      { kind: 'delete', leftStart: 0, rightStart: 0, length: 1 },
      { kind: 'equal', leftStart: 1, rightStart: 0, length: 512 },
    ]);
  });

  it('keeps a later raw-exact fallback anchor across a non-equivalent changed line', () => {
    const tail = Array.from({ length: 510 }, (_value, index) => `tail-${index}`);
    const left = ['BETA', 'changed', 'Beta', ...tail];
    const right = ['Beta', ...tail];
    const operations = createDiffOperations({
      leftLength: left.length,
      rightLength: right.length,
      areEqual: ({ leftIndex, rightIndex }) => (
        left[leftIndex]?.toLowerCase() === right[rightIndex]?.toLowerCase()
      ),
      areExactlyEqual: ({ leftIndex, rightIndex }) => left[leftIndex] === right[rightIndex],
      preferSpeedOverCompatibility: false,
    });

    expect(operations).toEqual([
      { kind: 'delete', leftStart: 0, rightStart: 0, length: 2 },
      { kind: 'equal', leftStart: 2, rightStart: 0, length: 511 },
    ]);
  });

  it('groups changes and merges hunks at the context boundary', () => {
    const left = ['a', 'b', 'c', 'd', 'e', 'f'];
    const right = ['a', 'B', 'c', 'd', 'E', 'f'];
    const operations = createOperations({ left, right });
    const groups = createChangeGroups({ operations });

    expect(groups).toHaveLength(2);
    expect(createHunks({
      operations,
      changeGroups: groups,
      contextLines: 1,
      leftLength: left.length,
      rightLength: right.length,
    })).toHaveLength(1);
    expect(createHunks({
      operations,
      changeGroups: groups,
      contextLines: 0,
      leftLength: left.length,
      rightLength: right.length,
    })).toHaveLength(2);
  });

  it('handles long common prefixes and suffixes without recursion overflow', () => {
    const prefix = Array.from({ length: 20_000 }, (_, index) => `same-${index}`);
    const left = [...prefix, 'left-only', ...prefix];
    const right = [...prefix, 'right-only', ...prefix];
    const operations = createOperations({ left, right });

    expect(applyOperations({ left, right, operations })).toEqual(right);
    expect(editCost({ operations })).toBe(2);
  });
});
