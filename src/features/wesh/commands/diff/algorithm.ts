import type { DiffChangeGroup, DiffHunk, DiffOperation } from './model';

interface DiffTask {
  readonly kind: 'diff',
  readonly leftStart: number,
  readonly leftEnd: number,
  readonly rightStart: number,
  readonly rightEnd: number,
}

interface EmitTask {
  readonly kind: 'emit',
  readonly operation: DiffOperation,
}

type AlgorithmTask = DiffTask | EmitTask;

// A bounded dynamic-programming path improves compatibility for small,
// duplicate-heavy inputs without allowing quadratic memory growth for large files.
const MAX_DYNAMIC_PROGRAMMING_CELLS = 256 * 1024;

function appendOperation({
  operations,
  operation,
}: {
  operations: DiffOperation[],
  operation: DiffOperation,
}): void {
  if (operation.length === 0) {
    return;
  }

  const previous = operations[operations.length - 1];
  if (previous === undefined || previous.kind !== operation.kind) {
    operations.push(operation);
    return;
  }

  switch (operation.kind) {
  case 'equal':
    if (
      previous.kind === 'equal'
      && previous.leftStart + previous.length === operation.leftStart
      && previous.rightStart + previous.length === operation.rightStart
    ) {
      operations[operations.length - 1] = {
        kind: 'equal',
        leftStart: previous.leftStart,
        rightStart: previous.rightStart,
        length: previous.length + operation.length,
      };
      return;
    }
    break;
  case 'delete':
    if (
      previous.kind === 'delete'
      && previous.leftStart + previous.length === operation.leftStart
      && previous.rightStart === operation.rightStart
    ) {
      operations[operations.length - 1] = {
        kind: 'delete',
        leftStart: previous.leftStart,
        rightStart: previous.rightStart,
        length: previous.length + operation.length,
      };
      return;
    }
    break;
  case 'insert':
    if (
      previous.kind === 'insert'
      && previous.leftStart === operation.leftStart
      && previous.rightStart + previous.length === operation.rightStart
    ) {
      operations[operations.length - 1] = {
        kind: 'insert',
        leftStart: previous.leftStart,
        rightStart: previous.rightStart,
        length: previous.length + operation.length,
      };
      return;
    }
    break;
  default: {
    const _ex: never = operation;
    throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
  }
  }

  operations.push(operation);
}

function tryCreateDynamicProgrammingOperations({
  leftLength,
  rightLength,
  areEqual,
}: {
  leftLength: number,
  rightLength: number,
  areEqual: ({ leftIndex, rightIndex }: { leftIndex: number, rightIndex: number }) => boolean,
}): DiffOperation[] | undefined {
  const rowWidth = rightLength + 1;
  const cellCount = (leftLength + 1) * rowWidth;
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_DYNAMIC_PROGRAMMING_CELLS) {
    return undefined;
  }

  const longestCommonSubsequenceLengths = new Uint32Array(cellCount);
  for (let leftIndex = leftLength - 1; leftIndex >= 0; leftIndex--) {
    for (let rightIndex = rightLength - 1; rightIndex >= 0; rightIndex--) {
      const index = (leftIndex * rowWidth) + rightIndex;
      if (areEqual({ leftIndex, rightIndex })) {
        longestCommonSubsequenceLengths[index] = longestCommonSubsequenceLengths[index + rowWidth + 1]! + 1;
      } else {
        longestCommonSubsequenceLengths[index] = Math.max(
          longestCommonSubsequenceLengths[index + rowWidth]!,
          longestCommonSubsequenceLengths[index + 1]!,
        );
      }
    }
  }

  const operations: DiffOperation[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < leftLength && rightIndex < rightLength) {
    if (areEqual({ leftIndex, rightIndex })) {
      appendOperation({
        operations,
        operation: {
          kind: 'equal',
          leftStart: leftIndex,
          rightStart: rightIndex,
          length: 1,
        },
      });
      leftIndex++;
      rightIndex++;
      continue;
    }

    const deleteLength = longestCommonSubsequenceLengths[((leftIndex + 1) * rowWidth) + rightIndex]!;
    const insertLength = longestCommonSubsequenceLengths[(leftIndex * rowWidth) + rightIndex + 1]!;
    if (deleteLength >= insertLength) {
      appendOperation({
        operations,
        operation: {
          kind: 'delete',
          leftStart: leftIndex,
          rightStart: rightIndex,
          length: 1,
        },
      });
      leftIndex++;
    } else {
      appendOperation({
        operations,
        operation: {
          kind: 'insert',
          leftStart: leftIndex,
          rightStart: rightIndex,
          length: 1,
        },
      });
      rightIndex++;
    }
  }

  if (leftIndex < leftLength) {
    appendOperation({
      operations,
      operation: {
        kind: 'delete',
        leftStart: leftIndex,
        rightStart: rightIndex,
        length: leftLength - leftIndex,
      },
    });
  }
  if (rightIndex < rightLength) {
    appendOperation({
      operations,
      operation: {
        kind: 'insert',
        leftStart: leftIndex,
        rightStart: rightIndex,
        length: rightLength - rightIndex,
      },
    });
  }
  return operations;
}

function findSingleLineMatch({
  leftStart,
  leftEnd,
  rightStart,
  rightEnd,
  areEqual,
}: {
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
  areEqual: ({ leftIndex, rightIndex }: { leftIndex: number, rightIndex: number }) => boolean,
}): { leftIndex: number, rightIndex: number } | undefined {
  if (leftEnd - leftStart === 1) {
    for (let rightIndex = rightStart; rightIndex < rightEnd; rightIndex++) {
      if (areEqual({ leftIndex: leftStart, rightIndex })) {
        return { leftIndex: leftStart, rightIndex };
      }
    }
    return undefined;
  }

  if (rightEnd - rightStart === 1) {
    for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex++) {
      if (areEqual({ leftIndex, rightIndex: rightStart })) {
        return { leftIndex, rightIndex: rightStart };
      }
    }
  }

  return undefined;
}

function findBisectSplit({
  leftStart,
  leftEnd,
  rightStart,
  rightEnd,
  areEqual,
}: {
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
  areEqual: ({ leftIndex, rightIndex }: { leftIndex: number, rightIndex: number }) => boolean,
}): { leftIndex: number, rightIndex: number } | undefined {
  const leftLength = leftEnd - leftStart;
  const rightLength = rightEnd - rightStart;
  const maximumDistance = Math.ceil((leftLength + rightLength) / 2);
  const vectorOffset = maximumDistance + 1;
  const vectorLength = (maximumDistance * 2) + 3;
  const forward = new Int32Array(vectorLength);
  const reverse = new Int32Array(vectorLength);
  forward.fill(-1);
  reverse.fill(-1);
  forward[vectorOffset + 1] = 0;
  reverse[vectorOffset + 1] = 0;

  const delta = leftLength - rightLength;
  const overlapOnForwardPass = (delta & 1) !== 0;
  let forwardStartAdjustment = 0;
  let forwardEndAdjustment = 0;
  let reverseStartAdjustment = 0;
  let reverseEndAdjustment = 0;

  for (let distance = 0; distance <= maximumDistance; distance++) {
    for (
      let diagonal = -distance + forwardStartAdjustment;
      diagonal <= distance - forwardEndAdjustment;
      diagonal += 2
    ) {
      const vectorIndex = vectorOffset + diagonal;
      let x: number;
      if (
        diagonal === -distance
        || (diagonal !== distance && forward[vectorIndex - 1]! < forward[vectorIndex + 1]!)
      ) {
        x = forward[vectorIndex + 1]!;
      } else {
        x = forward[vectorIndex - 1]! + 1;
      }
      let y = x - diagonal;

      while (
        x < leftLength
        && y < rightLength
        && areEqual({ leftIndex: leftStart + x, rightIndex: rightStart + y })
      ) {
        x++;
        y++;
      }
      forward[vectorIndex] = x;

      if (x > leftLength) {
        forwardEndAdjustment += 2;
      } else if (y > rightLength) {
        forwardStartAdjustment += 2;
      } else if (overlapOnForwardPass) {
        const reverseDiagonal = delta - diagonal;
        const reverseIndex = vectorOffset + reverseDiagonal;
        if (
          reverseIndex >= 0
          && reverseIndex < vectorLength
          && reverse[reverseIndex]! !== -1
          && x >= leftLength - reverse[reverseIndex]!
        ) {
          return {
            leftIndex: leftStart + x,
            rightIndex: rightStart + y,
          };
        }
      }
    }

    for (
      let diagonal = -distance + reverseStartAdjustment;
      diagonal <= distance - reverseEndAdjustment;
      diagonal += 2
    ) {
      const vectorIndex = vectorOffset + diagonal;
      let x: number;
      if (
        diagonal === -distance
        || (diagonal !== distance && reverse[vectorIndex - 1]! < reverse[vectorIndex + 1]!)
      ) {
        x = reverse[vectorIndex + 1]!;
      } else {
        x = reverse[vectorIndex - 1]! + 1;
      }
      let y = x - diagonal;

      while (
        x < leftLength
        && y < rightLength
        && areEqual({ leftIndex: leftEnd - x - 1, rightIndex: rightEnd - y - 1 })
      ) {
        x++;
        y++;
      }
      reverse[vectorIndex] = x;

      if (x > leftLength) {
        reverseEndAdjustment += 2;
      } else if (y > rightLength) {
        reverseStartAdjustment += 2;
      } else if (!overlapOnForwardPass) {
        const forwardDiagonal = delta - diagonal;
        const forwardIndex = vectorOffset + forwardDiagonal;
        if (
          forwardIndex >= 0
          && forwardIndex < vectorLength
          && forward[forwardIndex]! !== -1
        ) {
          const forwardX = forward[forwardIndex]!;
          const reverseX = leftLength - x;
          if (forwardX >= reverseX) {
            return {
              leftIndex: leftStart + forwardX,
              rightIndex: rightStart + (forwardX - forwardDiagonal),
            };
          }
        }
      }
    }
  }

  return undefined;
}

function pushSingleLineDiffTasks({
  tasks,
  leftStart,
  leftEnd,
  rightStart,
  rightEnd,
  match,
}: {
  tasks: AlgorithmTask[],
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
  match: { leftIndex: number, rightIndex: number } | undefined,
}): void {
  if (match === undefined) {
    if (rightEnd > rightStart) {
      tasks.push({
        kind: 'emit',
        operation: {
          kind: 'insert',
          leftStart,
          rightStart,
          length: rightEnd - rightStart,
        },
      });
    }
    if (leftEnd > leftStart) {
      tasks.push({
        kind: 'emit',
        operation: {
          kind: 'delete',
          leftStart,
          rightStart,
          length: leftEnd - leftStart,
        },
      });
    }
    return;
  }

  if (rightEnd > match.rightIndex + 1) {
    tasks.push({
      kind: 'emit',
      operation: {
        kind: 'insert',
        leftStart: match.leftIndex + 1,
        rightStart: match.rightIndex + 1,
        length: rightEnd - match.rightIndex - 1,
      },
    });
  }
  if (leftEnd > match.leftIndex + 1) {
    tasks.push({
      kind: 'emit',
      operation: {
        kind: 'delete',
        leftStart: match.leftIndex + 1,
        rightStart: match.rightIndex + 1,
        length: leftEnd - match.leftIndex - 1,
      },
    });
  }
  tasks.push({
    kind: 'emit',
    operation: {
      kind: 'equal',
      leftStart: match.leftIndex,
      rightStart: match.rightIndex,
      length: 1,
    },
  });
  if (rightStart < match.rightIndex) {
    tasks.push({
      kind: 'emit',
      operation: {
        kind: 'insert',
        leftStart: match.leftIndex,
        rightStart,
        length: match.rightIndex - rightStart,
      },
    });
  }
  if (leftStart < match.leftIndex) {
    tasks.push({
      kind: 'emit',
      operation: {
        kind: 'delete',
        leftStart,
        rightStart,
        length: match.leftIndex - leftStart,
      },
    });
  }
}

export function createDiffOperations({
  leftLength,
  rightLength,
  areEqual,
  preferSpeedOverCompatibility = false,
}: {
  leftLength: number,
  rightLength: number,
  areEqual: ({ leftIndex, rightIndex }: { leftIndex: number, rightIndex: number }) => boolean,
  preferSpeedOverCompatibility?: boolean,
}): DiffOperation[] {
  if (!preferSpeedOverCompatibility) {
    const dynamicProgrammingOperations = tryCreateDynamicProgrammingOperations({
      leftLength,
      rightLength,
      areEqual,
    });
    if (dynamicProgrammingOperations !== undefined) {
      return dynamicProgrammingOperations;
    }
  }

  const operations: DiffOperation[] = [];
  const tasks: AlgorithmTask[] = [{
    kind: 'diff',
    leftStart: 0,
    leftEnd: leftLength,
    rightStart: 0,
    rightEnd: rightLength,
  }];

  while (tasks.length > 0) {
    const task = tasks.pop();
    if (task === undefined) {
      break;
    }

    switch (task.kind) {
    case 'emit':
      appendOperation({ operations, operation: task.operation });
      continue;
    case 'diff':
      break;
    default: {
      const _ex: never = task;
      throw new Error(`Unhandled algorithm task: ${JSON.stringify(_ex)}`);
    }
    }

    let leftStart = task.leftStart;
    let rightStart = task.rightStart;
    let leftEnd = task.leftEnd;
    let rightEnd = task.rightEnd;

    while (
      leftStart < leftEnd
      && rightStart < rightEnd
      && areEqual({ leftIndex: leftStart, rightIndex: rightStart })
    ) {
      leftStart++;
      rightStart++;
    }

    let suffixLength = 0;
    while (
      leftStart < leftEnd
      && rightStart < rightEnd
      && areEqual({ leftIndex: leftEnd - 1, rightIndex: rightEnd - 1 })
    ) {
      leftEnd--;
      rightEnd--;
      suffixLength++;
    }

    if (suffixLength > 0) {
      tasks.push({
        kind: 'emit',
        operation: {
          kind: 'equal',
          leftStart: leftEnd,
          rightStart: rightEnd,
          length: suffixLength,
        },
      });
    }

    const leftMiddleLength = leftEnd - leftStart;
    const rightMiddleLength = rightEnd - rightStart;

    if (leftMiddleLength === 0) {
      if (rightMiddleLength > 0) {
        tasks.push({
          kind: 'emit',
          operation: {
            kind: 'insert',
            leftStart,
            rightStart,
            length: rightMiddleLength,
          },
        });
      }
    } else if (rightMiddleLength === 0) {
      tasks.push({
        kind: 'emit',
        operation: {
          kind: 'delete',
          leftStart,
          rightStart,
          length: leftMiddleLength,
        },
      });
    } else if (leftMiddleLength === 1 || rightMiddleLength === 1) {
      pushSingleLineDiffTasks({
        tasks,
        leftStart,
        leftEnd,
        rightStart,
        rightEnd,
        match: findSingleLineMatch({
          leftStart,
          leftEnd,
          rightStart,
          rightEnd,
          areEqual,
        }),
      });
    } else {
      const split = findBisectSplit({
        leftStart,
        leftEnd,
        rightStart,
        rightEnd,
        areEqual,
      });

      if (
        split === undefined
        || (split.leftIndex === leftStart && split.rightIndex === rightStart)
        || (split.leftIndex === leftEnd && split.rightIndex === rightEnd)
      ) {
        tasks.push({
          kind: 'emit',
          operation: {
            kind: 'insert',
            leftStart,
            rightStart,
            length: rightMiddleLength,
          },
        });
        tasks.push({
          kind: 'emit',
          operation: {
            kind: 'delete',
            leftStart,
            rightStart,
            length: leftMiddleLength,
          },
        });
      } else {
        tasks.push({
          kind: 'diff',
          leftStart: split.leftIndex,
          leftEnd,
          rightStart: split.rightIndex,
          rightEnd,
        });
        tasks.push({
          kind: 'diff',
          leftStart,
          leftEnd: split.leftIndex,
          rightStart,
          rightEnd: split.rightIndex,
        });
      }
    }

    const prefixLength = leftStart - task.leftStart;
    if (prefixLength > 0) {
      tasks.push({
        kind: 'emit',
        operation: {
          kind: 'equal',
          leftStart: task.leftStart,
          rightStart: task.rightStart,
          length: prefixLength,
        },
      });
    }
  }

  return operations;
}

export function createChangeGroups({
  operations,
}: {
  operations: readonly DiffOperation[],
}): DiffChangeGroup[] {
  const groups: DiffChangeGroup[] = [];
  let operationIndex = 0;

  while (operationIndex < operations.length) {
    const operation = operations[operationIndex];
    if (operation === undefined) {
      break;
    }
    switch (operation.kind) {
    case 'equal':
      operationIndex++;
      continue;
    case 'delete':
    case 'insert':
      break;
    default: {
      const _ex: never = operation;
      throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
    }
    }

    const operationStart = operationIndex;
    const leftStart = operation.leftStart;
    const rightStart = operation.rightStart;
    let leftCount = 0;
    let rightCount = 0;

    while (operationIndex < operations.length) {
      const current = operations[operationIndex];
      if (current === undefined || current.kind === 'equal') {
        break;
      }
      switch (current.kind) {
      case 'delete':
        leftCount += current.length;
        break;
      case 'insert':
        rightCount += current.length;
        break;
      default: {
        const _ex: never = current;
        throw new Error(`Unhandled change operation: ${JSON.stringify(_ex)}`);
      }
      }
      operationIndex++;
    }

    groups.push({
      operationStart,
      operationEnd: operationIndex,
      leftStart,
      leftCount,
      rightStart,
      rightCount,
    });
  }

  return groups;
}

function findOperationIndexAtOrBefore({
  operations,
  leftLine,
  rightLine,
}: {
  operations: readonly DiffOperation[],
  leftLine: number,
  rightLine: number,
}): number {
  for (let index = 0; index < operations.length; index++) {
    const operation = operations[index];
    if (operation === undefined) {
      break;
    }
    const { leftEnd, rightEnd } = (() => {
      switch (operation.kind) {
      case 'equal':
        return {
          leftEnd: operation.leftStart + operation.length,
          rightEnd: operation.rightStart + operation.length,
        };
      case 'delete':
        return {
          leftEnd: operation.leftStart + operation.length,
          rightEnd: operation.rightStart,
        };
      case 'insert':
        return {
          leftEnd: operation.leftStart,
          rightEnd: operation.rightStart + operation.length,
        };
      default: {
        const _ex: never = operation;
        throw new Error(`Unhandled diff operation: ${JSON.stringify(_ex)}`);
      }
      }
    })();
    if (leftEnd >= leftLine && rightEnd >= rightLine) {
      return index;
    }
  }
  return operations.length;
}

function findOperationIndexAfter({
  operations,
  leftLine,
  rightLine,
}: {
  operations: readonly DiffOperation[],
  leftLine: number,
  rightLine: number,
}): number {
  for (let index = operations.length - 1; index >= 0; index--) {
    const operation = operations[index];
    if (operation === undefined) {
      continue;
    }
    if (operation.leftStart <= leftLine && operation.rightStart <= rightLine) {
      return index + 1;
    }
  }
  return 0;
}

export function createHunks({
  operations,
  changeGroups,
  contextLines,
  leftLength,
  rightLength,
}: {
  operations: readonly DiffOperation[],
  changeGroups: readonly DiffChangeGroup[],
  contextLines: number,
  leftLength: number,
  rightLength: number,
}): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let groupIndex = 0;

  while (groupIndex < changeGroups.length) {
    const first = changeGroups[groupIndex];
    if (first === undefined) {
      break;
    }
    let last = first;
    groupIndex++;

    while (groupIndex < changeGroups.length) {
      const next = changeGroups[groupIndex];
      if (next === undefined) {
        break;
      }
      const leftGap = next.leftStart - (last.leftStart + last.leftCount);
      const rightGap = next.rightStart - (last.rightStart + last.rightCount);
      if (Math.max(leftGap, rightGap) > contextLines * 2) {
        break;
      }
      last = next;
      groupIndex++;
    }

    const leftStart = Math.max(0, first.leftStart - contextLines);
    const rightStart = Math.max(0, first.rightStart - contextLines);
    const leftEnd = Math.min(leftLength, last.leftStart + last.leftCount + contextLines);
    const rightEnd = Math.min(rightLength, last.rightStart + last.rightCount + contextLines);

    hunks.push({
      operationStart: findOperationIndexAtOrBefore({ operations, leftLine: leftStart, rightLine: rightStart }),
      operationEnd: findOperationIndexAfter({ operations, leftLine: leftEnd, rightLine: rightEnd }),
      leftStart,
      leftCount: leftEnd - leftStart,
      rightStart,
      rightCount: rightEnd - rightStart,
    });
  }

  return hunks;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  findBisectSplit,
  tryCreateDynamicProgrammingOperations,
};
