import { containsNonAsciiDateWhitespace, trimAsciiDateWhitespace } from './date-whitespace';
import { foldAsciiCase } from './locale';

const relativeDateUnitsMilliseconds = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
} as const;

type RelativeDateUnit = keyof typeof relativeDateUnitsMilliseconds;

function getRelativeUnitMilliseconds({ value }: { value: string }): number | undefined {
  const singularUnit = value.replace(/s$/u, '') as RelativeDateUnit;
  return relativeDateUnitsMilliseconds[singularUnit];
}

function applyRelativeOffset({
  baseTime,
  amount,
  unitMilliseconds,
  direction,
}: {
  baseTime: number,
  amount: number,
  unitMilliseconds: number,
  direction: 1 | -1,
}): number | undefined {
  const result = baseTime + amount * unitMilliseconds * direction;
  return Number.isSafeInteger(result) ? result : undefined;
}

function parseStandaloneRelativeDateValue({
  value,
  baseTime,
}: {
  value: string,
  baseTime: number,
}): number | undefined {
  const normalized = foldAsciiCase({ value: trimAsciiDateWhitespace({ value }) });
  switch (normalized) {
  case 'now':
  case 'today':
    return baseTime;
  case 'yesterday':
    return baseTime - relativeDateUnitsMilliseconds.day;
  case 'tomorrow':
    return baseTime + relativeDateUnitsMilliseconds.day;
  default:
    break;
  }

  const match = /^(?:(next|last)[\t\n\v\f\r ]+)?([+-]?\d+)?[\t\n\v\f\r ]*(seconds?|minutes?|hours?|days?|weeks?)(?:[\t\n\v\f\r ]+(ago))?$/u.exec(normalized);
  if (match === null) return undefined;

  const directionWord = match[1];
  const rawAmount = match[2];
  const ago = match[4] !== undefined;
  if (directionWord !== undefined && rawAmount !== undefined) return undefined;

  const unitMilliseconds = match[3] === undefined
    ? undefined
    : getRelativeUnitMilliseconds({ value: match[3] });
  if (unitMilliseconds === undefined) return undefined;

  const amount = rawAmount === undefined ? 1 : Number(rawAmount);
  if (!Number.isFinite(amount)) return undefined;

  const direction: 1 | -1 = directionWord === 'last' || ago ? -1 : 1;
  return applyRelativeOffset({ baseTime, amount, unitMilliseconds, direction });
}

function parseEpochDateValue({ value }: { value: string }): number | undefined {
  const match = /^@([+-]?\d+)(?:\.(\d+))?$/u.exec(value);
  if (match === null) return undefined;

  const wholeSeconds = Number(match[1]);
  const fractionalDigits = match[2] ?? '';
  const milliseconds = Number((fractionalDigits + '000').slice(0, 3));
  const sign = wholeSeconds < 0 || match[1]?.startsWith('-') === true ? -1 : 1;
  const result = wholeSeconds * 1000 + sign * milliseconds;
  return Number.isSafeInteger(result) ? result : undefined;
}

function parseAnchoredRelativeDateValue({ value }: { value: string }): number | undefined {
  const match = /^(.*?\S)[\t\n\v\f\r ]+([+-])?[\t\n\v\f\r ]*(\d+)[\t\n\v\f\r ]*(seconds?|minutes?|hours?|days?|weeks?)(?:[\t\n\v\f\r ]+(ago))?$/iu.exec(value);
  if (match === null) return undefined;

  const anchor = trimAsciiDateWhitespace({ value: match[1] ?? '' });
  const anchorTime = Date.parse(anchor);
  if (!Number.isSafeInteger(anchorTime)) return undefined;

  const amount = Number(match[3]);
  if (!Number.isFinite(amount)) return undefined;
  const unitName = foldAsciiCase({ value: match[4] ?? '' });
  const unitMilliseconds = getRelativeUnitMilliseconds({ value: unitName });
  if (unitMilliseconds === undefined) return undefined;

  const explicitNegative = match[2] === '-';
  const ago = match[5] !== undefined;
  const direction: 1 | -1 = explicitNegative !== ago ? -1 : 1;
  return applyRelativeOffset({ baseTime: anchorTime, amount, unitMilliseconds, direction });
}

/**
 * Parse the intentionally bounded GNU-like date-expression subset shared by commands that
 * consume millisecond mtime thresholds. This is not intended to clone GNU parse_datetime.
 */
export function parseDateExpressionMilliseconds({
  value,
  baseTime,
}: {
  value: string,
  baseTime: number,
}): number | undefined {
  if (containsNonAsciiDateWhitespace({ value })) return undefined;

  const trimmed = trimAsciiDateWhitespace({ value });
  const epoch = parseEpochDateValue({ value: trimmed });
  if (epoch !== undefined) return epoch;

  const standaloneRelative = parseStandaloneRelativeDateValue({ value: trimmed, baseTime });
  if (standaloneRelative !== undefined) return standaloneRelative;

  const anchoredRelative = parseAnchoredRelativeDateValue({ value: trimmed });
  if (anchoredRelative !== undefined) return anchoredRelative;

  const absolute = Date.parse(trimmed);
  return Number.isSafeInteger(absolute) ? absolute : undefined;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  parseAnchoredRelativeDateValue,
  parseEpochDateValue,
  parseStandaloneRelativeDateValue,
};
