import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';
import type { ArgvOptionOccurrence } from '@/features/wesh/argv';

const MAX_SAFE_COUNT = BigInt(Number.MAX_SAFE_INTEGER);

const COUNT_SUFFIX_MULTIPLIERS = new Map<string, bigint>([
  ['', 1n],
  ['b', 512n],
  ['k', 1024n],
  ['K', 1024n],
  ['kB', 1000n],
  ['KB', 1000n],
  ['KiB', 1024n],
  ['m', 1024n ** 2n],
  ['M', 1024n ** 2n],
  ['mB', 1000n ** 2n],
  ['MB', 1000n ** 2n],
  ['miB', 1024n ** 2n],
  ['MiB', 1024n ** 2n],
  ['G', 1024n ** 3n],
  ['GB', 1000n ** 3n],
  ['GiB', 1024n ** 3n],
  ['T', 1024n ** 4n],
  ['TB', 1000n ** 4n],
  ['TiB', 1024n ** 4n],
  ['P', 1024n ** 5n],
  ['PB', 1000n ** 5n],
  ['PiB', 1024n ** 5n],
  ['E', 1024n ** 6n],
  ['EB', 1000n ** 6n],
  ['EiB', 1024n ** 6n],
  ['Z', 1024n ** 7n],
  ['ZB', 1000n ** 7n],
  ['ZiB', 1024n ** 7n],
  ['Y', 1024n ** 8n],
  ['YB', 1000n ** 8n],
  ['YiB', 1024n ** 8n],
  ['R', 1024n ** 9n],
  ['RB', 1000n ** 9n],
  ['RiB', 1024n ** 9n],
  ['Q', 1024n ** 10n],
  ['QB', 1000n ** 10n],
  ['QiB', 1024n ** 10n],
]);

export type LineOrByteCountSelection =
  | { readonly kind: 'lines', readonly value: string }
  | { readonly kind: 'bytes', readonly value: string };

export function parseCoreutilsLineOrByteCount({
  value,
  errorPrefix,
}: {
  value: string,
  errorPrefix: string,
}): { readonly ok: true, readonly value: string } | { readonly ok: false, readonly message: string } {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  const match = /^([+-]?)(\d+)([A-Za-z]*)$/.exec(numericText);
  if (match === null) {
    return { ok: false, message: `${errorPrefix}: '${value}'` };
  }

  const [, sign = '', digits = '', suffix = ''] = match;
  const multiplier = COUNT_SUFFIX_MULTIPLIERS.get(suffix);
  if (multiplier === undefined) {
    return { ok: false, message: `${errorPrefix}: '${value}'` };
  }

  const significantDigits = digits.replace(/^0+/, '') || '0';
  const boundedMagnitude = significantDigits.length > 16
    ? MAX_SAFE_COUNT
    : (() => {
      const magnitude = BigInt(significantDigits) * multiplier;
      return magnitude > MAX_SAFE_COUNT ? MAX_SAFE_COUNT : magnitude;
    })();
  return {
    ok: true,
    value: `${sign}${boundedMagnitude}`,
  };
}

export function selectLastLineOrByteCount({
  occurrences,
  defaultLineCount,
}: {
  occurrences: readonly ArgvOptionOccurrence[],
  defaultLineCount: string,
}): LineOrByteCountSelection {
  let selected: LineOrByteCountSelection = {
    kind: 'lines',
    value: defaultLineCount,
  };

  for (const occurrence of occurrences) {
    if (occurrence.kind !== 'value' || typeof occurrence.value !== 'string') {
      continue;
    }
    switch (occurrence.key) {
    case 'lines':
      selected = { kind: 'lines', value: occurrence.value };
      break;
    case 'bytes':
      selected = { kind: 'bytes', value: occurrence.value };
      break;
    default:
      break;
    }
  }

  return selected;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  parseCoreutilsLineOrByteCount,
  selectLastLineOrByteCount,
};
