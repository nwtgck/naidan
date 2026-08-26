import { stripLeadingCLocaleWhitespace } from '@/features/wesh/commands/_shared/numeric-whitespace';

const MAX_CMP_BYTE_COUNT = (1n << 63n) - 1n;

function getCmpByteCountSuffixMultiplier({ suffix }: { suffix: string }): bigint | undefined {
  switch (suffix) {
  case '': return 1n;
  case 'kB':
  case 'KB': return 1000n;
  case 'MB': return 1000n ** 2n;
  case 'GB': return 1000n ** 3n;
  case 'TB': return 1000n ** 4n;
  case 'PB': return 1000n ** 5n;
  case 'EB': return 1000n ** 6n;
  case 'ZB': return 1000n ** 7n;
  case 'YB': return 1000n ** 8n;
  case 'k':
  case 'K':
  case 'KiB': return 1024n;
  case 'M':
  case 'MiB': return 1024n ** 2n;
  case 'G':
  case 'GiB': return 1024n ** 3n;
  case 'T':
  case 'TiB': return 1024n ** 4n;
  case 'P':
  case 'PiB': return 1024n ** 5n;
  case 'E':
  case 'EiB': return 1024n ** 6n;
  case 'Z':
  case 'ZiB': return 1024n ** 7n;
  case 'Y':
  case 'YiB': return 1024n ** 8n;
  default: return undefined;
  }
}

type CmpByteCountParseResult =
  | { ok: true, value: bigint }
  | { ok: false, message: string };

function invalidByteCount({
  option,
  value,
}: {
  option: '--bytes' | '--ignore-initial',
  value: string,
}): { ok: false, message: string } {
  return {
    ok: false,
    message: `cmp: invalid ${option} value '${value}'`,
  };
}

export function parseCmpByteCount({
  value,
  option,
}: {
  value: string,
  option: '--bytes' | '--ignore-initial',
}): CmpByteCountParseResult {
  const numericText = stripLeadingCLocaleWhitespace({ value });
  const match = /^\+?(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([A-Za-z]*)$/.exec(numericText);
  if (match === null) {
    return invalidByteCount({ option, value });
  }

  const digits = match[1];
  const suffix = match[2];
  if (digits === undefined || suffix === undefined) {
    return invalidByteCount({ option, value });
  }

  const multiplier = getCmpByteCountSuffixMultiplier({ suffix });
  if (multiplier === undefined) {
    return invalidByteCount({ option, value });
  }

  let count: bigint;
  try {
    if (/^0[xX]/.test(digits)) {
      count = BigInt(digits);
    } else if (digits.length > 1 && digits.startsWith('0')) {
      count = BigInt(`0o${digits.slice(1)}`);
    } else {
      count = BigInt(digits);
    }
  } catch {
    return invalidByteCount({ option, value });
  }

  const multiplied = count * multiplier;
  if (multiplied > MAX_CMP_BYTE_COUNT) {
    return invalidByteCount({ option, value });
  }

  return {
    ok: true,
    value: multiplied,
  };
}

export function parseCmpIgnoreInitial({
  value,
}: {
  value: string,
}):
  | { ok: true, left: bigint, right: bigint }
  | { ok: false, message: string } {
  const separatorIndex = value.indexOf(':');
  if (separatorIndex < 0) {
    const parsed = parseCmpByteCount({
      value,
      option: '--ignore-initial',
    });
    if (!parsed.ok) {
      return parsed;
    }
    return {
      ok: true,
      left: parsed.value,
      right: parsed.value,
    };
  }

  if (value.indexOf(':', separatorIndex + 1) >= 0) {
    return invalidByteCount({
      option: '--ignore-initial',
      value,
    });
  }

  const leftValue = value.slice(0, separatorIndex);
  const rightValue = value.slice(separatorIndex + 1);
  const left = parseCmpByteCount({
    value: leftValue,
    option: '--ignore-initial',
  });
  if (!left.ok) {
    return left;
  }
  const right = parseCmpByteCount({
    value: rightValue,
    option: '--ignore-initial',
  });
  if (!right.ok) {
    return right;
  }

  return {
    ok: true,
    left: left.value,
    right: right.value,
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
