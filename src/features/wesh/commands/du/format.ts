export type DuOutputFormat =
  | {
      kind: 'blocks',
      unit: bigint,
      suffix: string,
    }
  | {
      kind: 'human',
      base: 1000 | 1024,
    };

export type DuThreshold =
  | {
      kind: 'minimum',
      value: bigint,
    }
  | {
      kind: 'maximum',
      value: bigint,
    };

const UNIT_EXPONENTS = new Map<string, number>([
  ['K', 1],
  ['M', 2],
  ['G', 3],
  ['T', 4],
  ['P', 5],
  ['E', 6],
  ['Z', 7],
  ['Y', 8],
  ['R', 9],
  ['Q', 10],
]);

function parseSizeSuffix({ suffix }: { suffix: string }):
  | {
      ok: true,
      multiplier: bigint,
      canonicalSuffix: string,
    }
  | {
      ok: false,
    } {
  if (suffix.length === 0) {
    return {
      ok: true,
      multiplier: 1n,
      canonicalSuffix: '',
    };
  }

  const matched = /^([kKmMgGtTpPeEzZyYrRqQ])(iB|B)?$/u.exec(suffix);
  if (matched === null) {
    return { ok: false };
  }

  const rawUnit = matched[1];
  const rawSuffixKind = matched[2];
  if (
    rawUnit === undefined
    || (
      rawSuffixKind !== undefined
      && rawSuffixKind !== 'B'
      && rawSuffixKind !== 'iB'
    )
  ) {
    return { ok: false };
  }
  const suffixKind: 'B' | 'iB' | undefined = rawSuffixKind;

  const unit = rawUnit.toUpperCase();
  const exponent = UNIT_EXPONENTS.get(unit);
  if (exponent === undefined) {
    return { ok: false };
  }

  switch (suffixKind) {
  case undefined:
    return {
      ok: true,
      multiplier: 1024n ** BigInt(exponent),
      canonicalSuffix: unit,
    };
  case 'B':
    return {
      ok: true,
      multiplier: 1000n ** BigInt(exponent),
      canonicalSuffix: unit === 'K' ? 'kB' : `${unit}B`,
    };
  case 'iB':
    return {
      ok: true,
      multiplier: 1024n ** BigInt(exponent),
      canonicalSuffix: `${unit}iB`,
    };
  default: {
    const _ex: never = suffixKind;
    throw new Error(`Unhandled du size suffix kind: ${_ex}`);
  }
  }
}

function parseUnsignedSize({
  value,
  diagnosticValue,
  allowImplicitOne,
}: {
  value: string,
  diagnosticValue: string,
  allowImplicitOne: boolean,
}):
  | {
      ok: true,
      bytes: bigint,
      implicitOne: boolean,
      canonicalSuffix: string,
    }
  | { ok: false, message: string } {
  const matched = /^([0-9]*)([A-Za-z]*)$/u.exec(value);
  if (matched === null) {
    return { ok: false, message: `invalid size '${diagnosticValue}'` };
  }

  const digits = matched[1];
  const suffix = matched[2];
  if (digits === undefined || suffix === undefined || (digits.length === 0 && suffix.length === 0)) {
    return { ok: false, message: `invalid size '${diagnosticValue}'` };
  }

  const parsedSuffix = parseSizeSuffix({ suffix });
  if (!parsedSuffix.ok) {
    return { ok: false, message: `invalid size suffix in '${diagnosticValue}'` };
  }

  const implicitOne = digits.length === 0;
  if (implicitOne && (!allowImplicitOne || parsedSuffix.canonicalSuffix.length === 0)) {
    return { ok: false, message: `invalid size '${diagnosticValue}'` };
  }

  return {
    ok: true,
    bytes: BigInt(implicitOne ? '1' : digits) * parsedSuffix.multiplier,
    implicitOne,
    canonicalSuffix: parsedSuffix.canonicalSuffix,
  };
}

export function parseDuBlockSize({ value }: { value: string }):
  | { ok: true, outputFormat: DuOutputFormat }
  | { ok: false, message: string } {
  if (value === 'human-readable') {
    return { ok: true, outputFormat: { kind: 'human', base: 1024 } };
  }
  if (value === 'si') {
    return { ok: true, outputFormat: { kind: 'human', base: 1000 } };
  }

  const hasLeadingPlus = value.startsWith('+');
  const unsignedValue = hasLeadingPlus ? value.slice(1) : value;
  const parsed = parseUnsignedSize({
    value: unsignedValue,
    diagnosticValue: value,
    allowImplicitOne: !hasLeadingPlus,
  });
  if (!parsed.ok) {
    return parsed;
  }
  if (parsed.bytes <= 0n) {
    return { ok: false, message: `invalid block size '${value}'` };
  }

  return {
    ok: true,
    outputFormat: {
      kind: 'blocks',
      unit: parsed.bytes,
      suffix: parsed.implicitOne ? parsed.canonicalSuffix : '',
    },
  };
}

export function parseDuThreshold({ value }: { value: string }):
  | { ok: true, threshold: DuThreshold }
  | { ok: false, message: string } {
  const hasExplicitSign = value.startsWith('-') || value.startsWith('+');
  const sign = value.startsWith('-') ? 'negative' : 'positive';
  const unsigned = hasExplicitSign ? value.slice(1) : value;
  const parsed = parseUnsignedSize({
    value: unsigned,
    diagnosticValue: value,
    allowImplicitOne: !hasExplicitSign,
  });
  if (!parsed.ok) {
    return parsed;
  }
  if (sign === 'negative' && parsed.bytes === 0n) {
    return { ok: false, message: `invalid threshold '${value}'` };
  }

  const threshold = (() => {
    switch (sign) {
    case 'negative':
      return { kind: 'maximum' as const, value: parsed.bytes };
    case 'positive':
      return { kind: 'minimum' as const, value: parsed.bytes };
    default: {
      const _ex: never = sign;
      throw new Error(`Unhandled du threshold sign: ${_ex}`);
    }
    }
  })();

  return {
    ok: true,
    threshold,
  };
}

function divideRoundUp({ value, divisor }: { value: bigint, divisor: bigint }): bigint {
  if (value === 0n) {
    return 0n;
  }
  return (value + divisor - 1n) / divisor;
}

function formatHuman({ value, base }: { value: bigint, base: 1000 | 1024 }): string {
  if (value < BigInt(base)) {
    return value.toString();
  }

  const suffixes = base === 1024
    ? ['', 'K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q']
    : ['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y', 'R', 'Q'];
  const baseBigInt = BigInt(base);
  let unit = 1n;
  let suffixIndex = 0;
  while (suffixIndex < suffixes.length - 1 && value >= unit * baseBigInt) {
    unit *= baseBigInt;
    suffixIndex += 1;
  }

  const suffix = suffixes[suffixIndex] ?? '';
  if (value >= unit * 10n) {
    return `${divideRoundUp({ value, divisor: unit })}${suffix}`;
  }

  const tenths = divideRoundUp({ value: value * 10n, divisor: unit });
  if (tenths >= 100n) {
    return `${divideRoundUp({ value, divisor: unit })}${suffix}`;
  }
  const whole = tenths / 10n;
  const fraction = tenths % 10n;
  return `${whole}.${fraction}${suffix}`;
}

export function formatDuValue({
  value,
  outputFormat,
  metric,
}: {
  value: bigint,
  outputFormat: DuOutputFormat,
  metric: 'logical-bytes' | 'inodes',
}): string {
  switch (metric) {
  case 'inodes':
    switch (outputFormat.kind) {
    case 'blocks':
      return value.toString();
    case 'human':
      return formatHuman({ value, base: outputFormat.base });
    default: {
      const _ex: never = outputFormat;
      throw new Error(`Unhandled du inode output format: ${_ex}`);
    }
    }
  case 'logical-bytes':
    break;
  default: {
    const _ex: never = metric;
    throw new Error(`Unhandled du metric: ${_ex}`);
  }
  }

  switch (outputFormat.kind) {
  case 'blocks':
    return `${divideRoundUp({ value, divisor: outputFormat.unit })}${outputFormat.suffix}`;
  case 'human':
    return formatHuman({ value, base: outputFormat.base });
  default: {
    const _ex: never = outputFormat;
    throw new Error(`Unhandled du output format: ${_ex}`);
  }
  }
}

export function duThresholdAllows({
  value,
  threshold,
}: {
  value: bigint,
  threshold: DuThreshold | undefined,
}): boolean {
  if (threshold === undefined) {
    return true;
  }

  switch (threshold.kind) {
  case 'minimum':
    return value >= threshold.value;
  case 'maximum':
    return value <= threshold.value;
  default: {
    const _ex: never = threshold;
    throw new Error(`Unhandled du threshold: ${_ex}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
