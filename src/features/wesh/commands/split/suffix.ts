import type { SplitSuffixLength, SuffixMode } from './parse';

export interface SplitSuffixGenerator {
  peekName(): string,
  nextName(): string,
}

class SuffixExhaustedError extends Error {
  constructor() {
    super('output file suffixes exhausted');
    this.name = 'SuffixExhaustedError';
  }
}

function formatFixedRadixSuffix({
  value,
  length,
  radix,
  firstCodePoint,
}: {
  value: bigint,
  length: number,
  radix: bigint,
  firstCodePoint: number,
}): string {
  const digits = Array<string>(length);
  let remaining = value;

  for (let position = length - 1; position >= 0; position -= 1) {
    const digit = Number(remaining % radix);
    digits[position] = String.fromCharCode(firstCodePoint + digit);
    remaining /= radix;
  }

  if (remaining > 0n) {
    throw new SuffixExhaustedError();
  }

  return digits.join('');
}

function formatAutoRadixSuffix({
  index,
  initialLength,
  radix,
  extensionDigit,
  firstCodePoint,
}: {
  index: bigint,
  initialLength: number,
  radix: bigint,
  extensionDigit: string,
  firstCodePoint: number,
}): string {
  let remaining = index;
  let extensionCount = 0;
  let variableLength = initialLength;

  while (true) {
    const blockSize = (radix - 1n) * (radix ** BigInt(variableLength - 1));
    if (remaining < blockSize) {
      return `${extensionDigit.repeat(extensionCount)}${formatFixedRadixSuffix({
        value: remaining,
        length: variableLength,
        radix,
        firstCodePoint,
      })}`;
    }

    remaining -= blockSize;
    extensionCount += 1;
    variableLength += 1;
  }
}

function formatSuffix({
  index,
  suffixLength,
  suffixMode,
}: {
  index: bigint,
  suffixLength: SplitSuffixLength,
  suffixMode: SuffixMode,
}): string {
  switch (suffixLength.kind) {
  case 'auto':
    switch (suffixMode.kind) {
    case 'alphabetic':
      return formatAutoRadixSuffix({
        index,
        initialLength: suffixLength.initialLength,
        radix: 26n,
        extensionDigit: 'z',
        firstCodePoint: 0x61,
      });
    case 'numeric':
      return formatAutoRadixSuffix({
        index: BigInt(suffixMode.start) + index,
        initialLength: suffixLength.initialLength,
        radix: 10n,
        extensionDigit: '9',
        firstCodePoint: 0x30,
      });
    default: {
      const _ex: never = suffixMode;
      throw new Error(`Unhandled suffix mode: ${JSON.stringify(_ex)}`);
    }
    }
  case 'fixed':
    switch (suffixMode.kind) {
    case 'alphabetic':
      return formatFixedRadixSuffix({
        value: index,
        length: suffixLength.length,
        radix: 26n,
        firstCodePoint: 0x61,
      });
    case 'numeric':
      return formatFixedRadixSuffix({
        value: BigInt(suffixMode.start) + index,
        length: suffixLength.length,
        radix: 10n,
        firstCodePoint: 0x30,
      });
    default: {
      const _ex: never = suffixMode;
      throw new Error(`Unhandled suffix mode: ${JSON.stringify(_ex)}`);
    }
    }
  default: {
    const _ex: never = suffixLength;
    throw new Error(`Unhandled suffix length: ${JSON.stringify(_ex)}`);
  }
  }
}

export function createSplitSuffixGenerator({
  prefix,
  suffixLength,
  suffixMode,
  additionalSuffix,
}: {
  prefix: string,
  suffixLength: SplitSuffixLength,
  suffixMode: SuffixMode,
  additionalSuffix: string,
}): SplitSuffixGenerator {
  let index = 0n;

  const buildName = ({ value }: { value: bigint }): string => (
    `${prefix}${formatSuffix({ index: value, suffixLength, suffixMode })}${additionalSuffix}`
  );

  return {
    peekName(): string {
      return buildName({ value: index });
    },
    nextName(): string {
      const name = buildName({ value: index });
      index += 1n;
      return name;
    },
  };
}

export function isSuffixExhaustedError({
  error,
}: {
  error: unknown,
}): boolean {
  return error instanceof SuffixExhaustedError;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  createSplitSuffixGenerator,
  isSuffixExhaustedError,
};
