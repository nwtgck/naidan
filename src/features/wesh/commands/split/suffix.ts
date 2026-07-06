import type { SuffixMode } from './parse';

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

function formatAlphabeticSuffix({
  index,
  length,
}: {
  index: number,
  length: number,
}): string {
  const digits: string[] = [];
  let remaining = index;

  for (let position = 0; position < length; position += 1) {
    digits.push(String.fromCharCode(0x61 + (remaining % 26)));
    remaining = Math.floor(remaining / 26);
  }

  if (remaining > 0) {
    throw new SuffixExhaustedError();
  }

  return digits.reverse().join('');
}

function formatNumericSuffix({
  value,
  length,
}: {
  value: number,
  length: number,
}): string {
  const raw = String(value);
  if (raw.length > length) {
    throw new SuffixExhaustedError();
  }

  return raw.padStart(length, '0');
}

export function createSplitSuffixGenerator({
  prefix,
  suffixLength,
  suffixMode,
  additionalSuffix,
}: {
  prefix: string,
  suffixLength: number,
  suffixMode: SuffixMode,
  additionalSuffix: string,
}): SplitSuffixGenerator {
  let index = 0;

  const buildName = ({ value }: { value: number }): string => {
    const suffix = (() => {
      switch (suffixMode.kind) {
      case 'alphabetic':
        return formatAlphabeticSuffix({ index: value, length: suffixLength });
      case 'numeric':
        return formatNumericSuffix({ value: suffixMode.start + value, length: suffixLength });
      default: {
        const _ex: never = suffixMode;
        throw new Error(`Unhandled suffix mode: ${JSON.stringify(_ex)}`);
      }
      }
    })();

    return `${prefix}${suffix}${additionalSuffix}`;
  };

  return {
    peekName(): string {
      return buildName({ value: index });
    },
    nextName(): string {
      const name = buildName({ value: index });
      index += 1;
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
