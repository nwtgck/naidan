import type { CmpDifference } from './compare';

function formatOctalByte({
  byte,
}: {
  byte: number,
}): string {
  return byte.toString(8).padStart(3, ' ');
}

function formatVisibleByte({
  byte,
}: {
  byte: number,
}): string {
  const lowByte = byte & 0x7f;
  const prefix = byte >= 0x80 ? 'M-' : '';

  if (lowByte < 0x20) {
    return `${prefix}^${String.fromCharCode(lowByte + 0x40)}`;
  }
  if (lowByte === 0x7f) {
    return `${prefix}^?`;
  }
  return `${prefix}${String.fromCharCode(lowByte)}`;
}

export function formatCmpByteDifference({
  leftName,
  rightName,
  difference,
  printBytes,
}: {
  leftName: string,
  rightName: string,
  difference: Extract<CmpDifference, { kind: 'byte' }>,
  printBytes: boolean,
}): string {
  if (!printBytes) {
    return `${leftName} ${rightName} differ: char ${difference.position}, line ${difference.line}\n`;
  }

  return `${leftName} ${rightName} differ: byte ${difference.position}, line ${difference.line} is ${formatOctalByte({ byte: difference.leftByte })} ${formatVisibleByte({ byte: difference.leftByte })} ${formatOctalByte({ byte: difference.rightByte })} ${formatVisibleByte({ byte: difference.rightByte })}\n`;
}

export function formatCmpVerboseDifference({
  difference,
  printBytes,
  positionWidth,
}: {
  difference: Extract<CmpDifference, { kind: 'byte' }>,
  printBytes: boolean,
  positionWidth: number,
}): string {
  const leftOctal = formatOctalByte({ byte: difference.leftByte });
  const rightOctal = formatOctalByte({ byte: difference.rightByte });
  const position = difference.position.toString().padStart(positionWidth, ' ');
  if (!printBytes) {
    return `${position} ${leftOctal} ${rightOctal}\n`;
  }

  const leftVisible = formatVisibleByte({ byte: difference.leftByte }).padEnd(4, ' ');
  return `${position} ${leftOctal} ${leftVisible} ${rightOctal} ${formatVisibleByte({ byte: difference.rightByte })}\n`;
}

export function formatCmpEofDifference({
  shorterName,
  difference,
  mode,
}: {
  shorterName: string,
  difference: Extract<CmpDifference, { kind: 'eof' }>,
  mode: 'first-difference' | 'verbose',
}): string {
  if (difference.comparedBytes === 0n) {
    return `cmp: EOF on ${shorterName} which is empty\n`;
  }
  switch (mode) {
  case 'first-difference': {
    const linePrefix = difference.afterRecordDelimiter ? '' : 'in ';
    return `cmp: EOF on ${shorterName} after byte ${difference.comparedBytes}, ${linePrefix}line ${difference.line}\n`;
  }
  case 'verbose':
    return `cmp: EOF on ${shorterName} after byte ${difference.comparedBytes}\n`;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled cmp EOF format mode: ${_ex}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
