import { parseStandardArgv, type ArgvSpecialTokenParser, type StandardArgvParserSpec } from '@/features/wesh/argv';
import {
  STANDARD_HELP_EARLY_EXIT_OPTIONS,
  standardSemanticIssuePrecedesDiagnostic,
  stopStandardArgvAtFirstEarlyExit,
} from '@/features/wesh/commands/_shared/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { containsNonAsciiDateWhitespace } from '@/features/wesh/commands/_shared/date-whitespace';

type IsoPrecision = 'date' | 'hours' | 'minutes' | 'seconds' | 'ns';
type Rfc3339Precision = 'date' | 'seconds' | 'ns';

const parseIsoToken: ArgvSpecialTokenParser = ({ token }) => {
  if (token === '-I' || token === '--iso-8601') {
    const effects = [{ key: 'isoPrecision', value: 'date' }] as const;
    return {
      kind: 'matched',
      consumeCount: 1,
      effects: [...effects],
      occurrences: [{ kind: 'special', option: token, effects: [...effects] }],
    };
  }
  if (token.startsWith('-I') && token.length > 2) {
    const effects = [{ key: 'isoPrecision', value: token.slice(2) }];
    return {
      kind: 'matched',
      consumeCount: 1,
      effects,
      occurrences: [{ kind: 'special', option: token, effects }],
    };
  }
  if (token.startsWith('--iso-8601=')) {
    const effects = [{ key: 'isoPrecision', value: token.slice('--iso-8601='.length) }];
    return {
      kind: 'matched',
      consumeCount: 1,
      effects,
      occurrences: [{ kind: 'special', option: token, effects }],
    };
  }
  return undefined;
};

const dateArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'u', long: 'utc', effects: [{ key: 'utc', value: true }], help: { summary: 'display the time in UTC' } },
    { kind: 'value', short: 'd', long: 'date', key: 'dateString', valueName: 'STRING', allowAttachedValue: true, parseValue: undefined, help: { summary: 'display the time described by STRING', valueName: 'STRING', category: 'common' } },
    { kind: 'value', short: undefined, long: 'rfc-3339', key: 'rfc3339Precision', valueName: 'TIMESPEC', allowAttachedValue: false, parseValue: undefined, help: { summary: 'output date/time in RFC 3339 format', valueName: 'TIMESPEC', category: 'common' } },
    { kind: 'flag', short: 'R', long: 'rfc-email', effects: [{ key: 'rfcEmail', value: true }], help: { summary: 'output date and time in RFC 5322 format', category: 'common' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: false,
  specialTokenParsers: [parseIsoToken],
};

const DATE_SHORT_OPTIONS = new Map(
  dateArgvSpec.options.flatMap((option) => option.short === undefined ? [] : [[option.short, option] as const]),
);
const DATE_LONG_OPTIONS = new Map(
  dateArgvSpec.options.flatMap((option) => option.long === undefined ? [] : [[option.long, option] as const]),
);

function normalizeDateIsoShortBundles({
  args,
}: {
  args: string[],
}): string[] {
  const normalized: string[] = [];

  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === undefined) break;

    if (token === '--') {
      normalized.push(...args.slice(index));
      break;
    }

    const special = parseIsoToken({
      token,
      nextToken: args[index + 1],
    });
    if (special !== undefined) {
      normalized.push(...args.slice(index, index + special.consumeCount));
      index += special.consumeCount;
      continue;
    }

    if (token.startsWith('--') && token.length > 2) {
      normalized.push(token);
      const optionBody = token.slice(2);
      const equalsIndex = optionBody.indexOf('=');
      const key = equalsIndex >= 0 ? optionBody.slice(0, equalsIndex) : optionBody;
      const option = DATE_LONG_OPTIONS.get(key);
      index += 1;
      if (option?.kind === 'value' && equalsIndex < 0 && index < args.length) {
        normalized.push(args[index]!);
        index += 1;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1 && token !== '-') {
      const shortBody = token.slice(1);
      let consumesNextValue = false;
      let rewritten = false;

      for (let shortIndex = 0; shortIndex < shortBody.length; shortIndex += 1) {
        const short = shortBody[shortIndex];
        if (short === undefined) continue;

        if (shortIndex > 0 && short === 'I') {
          normalized.push(
            `-${shortBody.slice(0, shortIndex)}`,
            `-${shortBody.slice(shortIndex)}`,
          );
          rewritten = true;
          break;
        }

        const option = DATE_SHORT_OPTIONS.get(short);
        if (option === undefined) break;
        switch (option.kind) {
        case 'flag':
          continue;
        case 'value': {
          const attachedValue = shortBody.slice(shortIndex + 1);
          consumesNextValue = !(option.allowAttachedValue && attachedValue.length > 0);
          shortIndex = shortBody.length;
          break;
        }
        default: {
          const _ex: never = option;
          throw new Error(`Unhandled date option kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
      }

      if (!rewritten) {
        normalized.push(token);
      }
      index += 1;
      if (!rewritten && consumesNextValue && index < args.length) {
        normalized.push(args[index]!);
        index += 1;
      }
      continue;
    }

    normalized.push(token);
    index += 1;
  }

  return normalized;
}

function parseIsoPrecision({ value }: { value: string }): IsoPrecision | undefined {
  switch (value) {
  case 'date':
  case 'hours':
  case 'minutes':
  case 'seconds':
  case 'ns':
    return value;
  default:
    return undefined;
  }
}

function parseRfc3339Precision({ value }: { value: string }): Rfc3339Precision | undefined {
  switch (value) {
  case 'date':
  case 'seconds':
  case 'ns':
    return value;
  default:
    return undefined;
  }
}

function countOutputFormatSelections({
  parsed,
}: {
  parsed: ReturnType<typeof parseStandardArgv>,
}): number {
  const optionCount = parsed.occurrences.reduce((count, occurrence) => {
    switch (occurrence.kind) {
    case 'value':
      return occurrence.key === 'rfc3339Precision' ? count + 1 : count;
    case 'flag':
    case 'special':
      return occurrence.effects.some((effect) => (
        effect.key === 'rfcEmail' || effect.key === 'isoPrecision'
      )) ? count + 1 : count;
    default: {
      const _ex: never = occurrence;
      throw new Error(`Unhandled date option occurrence: ${String(_ex)}`);
    }
    }
  }, 0);
  const positionalCount = parsed.positionals[0]?.startsWith('+') === true ? 1 : 0;
  return optionCount + positionalCount;
}

type DatePreHelpSemanticIssue =
  | { readonly kind: 'iso-precision', readonly value: string }
  | { readonly kind: 'rfc3339-precision', readonly value: string }
  | { readonly kind: 'multiple-formats' };

function findDatePreHelpSemanticIssue({
  parsed,
}: {
  parsed: ReturnType<typeof parseStandardArgv>,
}): DatePreHelpSemanticIssue | undefined {
  for (const occurrence of parsed.occurrences) {
    switch (occurrence.kind) {
    case 'special':
      for (const effect of occurrence.effects) {
        if (
          effect.key === 'isoPrecision'
          && typeof effect.value === 'string'
          && parseIsoPrecision({ value: effect.value }) === undefined
        ) {
          return { kind: 'iso-precision', value: effect.value };
        }
      }
      break;
    case 'flag':
    case 'value':
      break;
    default: {
      const _ex: never = occurrence;
      throw new Error(`Unhandled date argv occurrence: ${JSON.stringify(_ex)}`);
    }
    }
  }

  for (const occurrence of parsed.occurrences) {
    switch (occurrence.kind) {
    case 'value':
      if (
        occurrence.key === 'rfc3339Precision'
        && typeof occurrence.value === 'string'
        && parseRfc3339Precision({ value: occurrence.value }) === undefined
      ) {
        return { kind: 'rfc3339-precision', value: occurrence.value };
      }
      break;
    case 'flag':
    case 'special':
      break;
    default: {
      const _ex: never = occurrence;
      throw new Error(`Unhandled date argv occurrence: ${JSON.stringify(_ex)}`);
    }
    }
  }

  return countOutputFormatSelections({ parsed }) > 1
    ? { kind: 'multiple-formats' }
    : undefined;
}

function pad2({ value }: { value: number }): string {
  return value.toString().padStart(2, '0');
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEKDAY_FULL_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTH_FULL_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;

type DateZone =
  | { readonly kind: 'utc' }
  | { readonly kind: 'local' }
  | { readonly kind: 'iana', readonly name: string };

interface DateFields {
  readonly year: number,
  readonly month: number,
  readonly day: number,
  readonly weekdayIndex: number,
  readonly weekday: string,
  readonly hours: number,
  readonly minutes: number,
  readonly seconds: number,
  readonly timezoneOffset: string,
  readonly timezoneName: string,
}

interface DateInstant {
  readonly date: Date,
  readonly nanosecondsWithinSecond: number,
}

const NANOSECONDS_PER_SECOND = 1_000_000_000n;
const MILLISECONDS_PER_SECOND = 1_000n;
const MAXIMUM_DATE_MILLISECONDS = 8_640_000_000_000_000n;

function normalizeTimezoneOffsetName({ value }: { value: string }): string {
  if (value === 'GMT' || value === 'UTC') {
    return '+0000';
  }

  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/u.exec(value);
  if (match === null) {
    return '+0000';
  }

  return `${match[1]}${match[2]!.padStart(2, '0')}${match[3] ?? '00'}`;
}

function getIntlPart({
  parts,
  type,
}: {
  parts: readonly Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
}): string {
  return parts.find((part) => part.type === type)?.value ?? '';
}

function resolveDateZone({
  utc,
  timezone,
}: {
  utc: boolean,
  timezone: string | undefined,
}): DateZone {
  if (utc) {
    return { kind: 'utc' };
  }
  if (timezone === undefined || timezone.length === 0) {
    return { kind: 'local' };
  }

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
    return { kind: 'iana', name: timezone };
  } catch {
    return { kind: 'local' };
  }
}

function getLocalTimezoneName({ date }: { date: Date }): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZoneName: 'short',
  }).formatToParts(date);
  return getIntlPart({ parts, type: 'timeZoneName' }) || 'UTC';
}

function getDateFields({
  date,
  zone,
}: {
  date: Date,
  zone: DateZone,
}): DateFields {
  switch (zone.kind) {
  case 'utc':
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      weekdayIndex: date.getUTCDay(),
      weekday: WEEKDAY_NAMES[date.getUTCDay()] ?? '',
      hours: date.getUTCHours(),
      minutes: date.getUTCMinutes(),
      seconds: date.getUTCSeconds(),
      timezoneOffset: '+0000',
      timezoneName: 'UTC',
    };
  case 'local': {
    const totalMinutes = -date.getTimezoneOffset();
    const sign = totalMinutes >= 0 ? '+' : '-';
    const absoluteMinutes = Math.abs(totalMinutes);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      weekdayIndex: date.getDay(),
      weekday: WEEKDAY_NAMES[date.getDay()] ?? '',
      hours: date.getHours(),
      minutes: date.getMinutes(),
      seconds: date.getSeconds(),
      timezoneOffset: `${sign}${pad2({ value: Math.floor(absoluteMinutes / 60) })}${pad2({ value: absoluteMinutes % 60 })}`,
      timezoneName: getLocalTimezoneName({ date }),
    };
  }
  case 'iana': {
    const valueParts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: zone.name,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    }).formatToParts(date);
    const offsetParts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: zone.name,
      hour: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    }).formatToParts(date);
    return {
      year: Number.parseInt(getIntlPart({ parts: valueParts, type: 'year' }), 10),
      month: Number.parseInt(getIntlPart({ parts: valueParts, type: 'month' }), 10),
      day: Number.parseInt(getIntlPart({ parts: valueParts, type: 'day' }), 10),
      weekdayIndex: new Date(Date.UTC(
        Number.parseInt(getIntlPart({ parts: valueParts, type: 'year' }), 10),
        Number.parseInt(getIntlPart({ parts: valueParts, type: 'month' }), 10) - 1,
        Number.parseInt(getIntlPart({ parts: valueParts, type: 'day' }), 10),
      )).getUTCDay(),
      weekday: getIntlPart({ parts: valueParts, type: 'weekday' }),
      hours: Number.parseInt(getIntlPart({ parts: valueParts, type: 'hour' }), 10),
      minutes: Number.parseInt(getIntlPart({ parts: valueParts, type: 'minute' }), 10),
      seconds: Number.parseInt(getIntlPart({ parts: valueParts, type: 'second' }), 10),
      timezoneOffset: normalizeTimezoneOffsetName({
        value: getIntlPart({ parts: offsetParts, type: 'timeZoneName' }),
      }),
      timezoneName: getIntlPart({ parts: valueParts, type: 'timeZoneName' }) || zone.name,
    };
  }
  default: {
    const _exhaustive: never = zone;
    throw new Error(`Unhandled date zone: ${JSON.stringify(_exhaustive)}`);
  }
  }
}

function getCalendarMetrics({
  fields,
}: {
  fields: DateFields,
}): {
  dayOfYear: number,
  sundayWeek: number,
  mondayWeek: number,
  isoWeek: number,
  isoYear: number,
} {
  const current = new Date(Date.UTC(fields.year, fields.month - 1, fields.day));
  const yearStart = new Date(Date.UTC(fields.year, 0, 1));
  const dayOfYearZeroBased = Math.floor((current.getTime() - yearStart.getTime()) / 86_400_000);
  const mondayWeekday = (fields.weekdayIndex + 6) % 7;

  const isoThursday = new Date(current);
  const isoWeekday = fields.weekdayIndex === 0 ? 7 : fields.weekdayIndex;
  isoThursday.setUTCDate(isoThursday.getUTCDate() + 4 - isoWeekday);
  const isoYear = isoThursday.getUTCFullYear();
  const isoYearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.floor((isoThursday.getTime() - isoYearStart.getTime()) / 86_400_000 / 7) + 1;

  return {
    dayOfYear: dayOfYearZeroBased + 1,
    sundayWeek: Math.floor((dayOfYearZeroBased + 7 - fields.weekdayIndex) / 7),
    mondayWeek: Math.floor((dayOfYearZeroBased + 7 - mondayWeekday) / 7),
    isoWeek,
    isoYear,
  };
}

function formatTimezoneOffset({
  offset,
  colonCount,
}: {
  offset: string,
  colonCount: number,
}): string {
  if (colonCount === 0) return offset;
  const hours = offset.slice(0, 3);
  const minutes = offset.slice(3, 5);
  if (colonCount === 1) return `${hours}:${minutes}`;
  if (colonCount === 2) return `${hours}:${minutes}:00`;
  return minutes === '00' ? hours : `${hours}:${minutes}`;
}

function formatDateToken({
  token,
  date,
  fields,
  nanosecondsWithinSecond = date.getUTCMilliseconds() * 1_000_000,
}: {
  token: string,
  date: Date,
  fields: DateFields,
  nanosecondsWithinSecond?: number,
}): string {
  const nanosecondMatch = /^%([1-9])?N$/u.exec(token);
  if (nanosecondMatch !== null) {
    const digits = nanosecondsWithinSecond.toString().padStart(9, '0');
    const precision = nanosecondMatch[1] === undefined ? 9 : Number.parseInt(nanosecondMatch[1], 10);
    return digits.slice(0, precision);
  }

  switch (token) {
  case '%a':
    return fields.weekday;
  case '%A':
    return WEEKDAY_FULL_NAMES[fields.weekdayIndex] ?? '';
  case '%b':
  case '%h':
    return MONTH_NAMES[fields.month - 1] ?? '';
  case '%B':
    return MONTH_FULL_NAMES[fields.month - 1] ?? '';
  case '%C':
    return Math.floor(fields.year / 100).toString().padStart(2, '0');
  case '%Y':
    return fields.year.toString().padStart(4, '0');
  case '%y':
    return Math.abs(fields.year % 100).toString().padStart(2, '0');
  case '%m':
    return pad2({ value: fields.month });
  case '%d':
    return pad2({ value: fields.day });
  case '%e':
    return fields.day.toString().padStart(2, ' ');
  case '%H':
    return pad2({ value: fields.hours });
  case '%I': {
    const hour = fields.hours % 12 || 12;
    return pad2({ value: hour });
  }
  case '%k':
    return fields.hours.toString().padStart(2, ' ');
  case '%l': {
    const hour = fields.hours % 12 || 12;
    return hour.toString().padStart(2, ' ');
  }
  case '%p':
    return fields.hours < 12 ? 'AM' : 'PM';
  case '%P':
    return fields.hours < 12 ? 'am' : 'pm';
  case '%M':
    return pad2({ value: fields.minutes });
  case '%S':
    return pad2({ value: fields.seconds });
  case '%F':
    return `${formatDateToken({ token: '%Y', date, fields })}-${formatDateToken({ token: '%m', date, fields })}-${formatDateToken({ token: '%d', date, fields })}`;
  case '%T':
    return `${formatDateToken({ token: '%H', date, fields })}:${formatDateToken({ token: '%M', date, fields })}:${formatDateToken({ token: '%S', date, fields })}`;
  case '%R':
    return `${formatDateToken({ token: '%H', date, fields })}:${formatDateToken({ token: '%M', date, fields })}`;
  case '%D':
    return `${formatDateToken({ token: '%m', date, fields })}/${formatDateToken({ token: '%d', date, fields })}/${formatDateToken({ token: '%y', date, fields })}`;
  case '%r':
    return `${formatDateToken({ token: '%I', date, fields })}:${formatDateToken({ token: '%M', date, fields })}:${formatDateToken({ token: '%S', date, fields })} ${formatDateToken({ token: '%p', date, fields })}`;
  case '%c':
    return `${formatDateToken({ token: '%a', date, fields })} ${formatDateToken({ token: '%b', date, fields })} ${formatDateToken({ token: '%e', date, fields })} ${formatDateToken({ token: '%T', date, fields })} ${formatDateToken({ token: '%Y', date, fields })}`;
  case '%x':
    return formatDateToken({ token: '%D', date, fields });
  case '%X':
    return formatDateToken({ token: '%T', date, fields });
  case '%j':
    return getCalendarMetrics({ fields }).dayOfYear.toString().padStart(3, '0');
  case '%u':
    return (fields.weekdayIndex === 0 ? 7 : fields.weekdayIndex).toString();
  case '%w':
    return fields.weekdayIndex.toString();
  case '%U':
    return getCalendarMetrics({ fields }).sundayWeek.toString().padStart(2, '0');
  case '%W':
    return getCalendarMetrics({ fields }).mondayWeek.toString().padStart(2, '0');
  case '%V':
    return getCalendarMetrics({ fields }).isoWeek.toString().padStart(2, '0');
  case '%G':
    return getCalendarMetrics({ fields }).isoYear.toString().padStart(4, '0');
  case '%g':
    return Math.abs(getCalendarMetrics({ fields }).isoYear % 100).toString().padStart(2, '0');
  case '%q':
    return (Math.floor((fields.month - 1) / 3) + 1).toString();
  case '%s':
    return Math.floor(date.getTime() / 1000).toString();
  case '%z':
    return fields.timezoneOffset;
  case '%:z':
    return formatTimezoneOffset({ offset: fields.timezoneOffset, colonCount: 1 });
  case '%::z':
    return formatTimezoneOffset({ offset: fields.timezoneOffset, colonCount: 2 });
  case '%:::z':
    return formatTimezoneOffset({ offset: fields.timezoneOffset, colonCount: 3 });
  case '%Z':
    return fields.timezoneName;
  case '%n':
    return '\n';
  case '%t':
    return '\t';
  case '%%':
    return '%';
  default:
    return token;
  }
}

function formatDate({
  format,
  date,
  nanosecondsWithinSecond,
  zone,
}: {
  format: string,
  date: Date,
  nanosecondsWithinSecond: number,
  zone: DateZone,
}): string {
  const fields = getDateFields({ date, zone });
  return format.replace(/%(?:[1-9]N|(?:::{0,2})?[%A-Za-z])/gu, (token) => formatDateToken({
    token,
    date,
    fields,
    nanosecondsWithinSecond,
  }));
}

function formatRfcEmailOutput({
  date,
  zone,
}: {
  date: Date,
  zone: DateZone,
}): string {
  const fields = getDateFields({ date, zone });
  return `${fields.weekday}, ${pad2({ value: fields.day })} ${MONTH_NAMES[fields.month - 1] ?? ''} ${fields.year.toString().padStart(4, '0')} ${pad2({ value: fields.hours })}:${pad2({ value: fields.minutes })}:${pad2({ value: fields.seconds })} ${fields.timezoneOffset}`;
}


function parseEpochDateOperand({ value }: { value: string }): DateInstant | undefined {
  const match = /^[ \t\n\v\f\r]*([+-]?)(\d+)(?:\.(\d+))?[ \t\n\v\f\r]*$/u.exec(value);
  if (match === null) return undefined;

  const negative = match[1] === '-';
  const wholeSeconds = BigInt(match[2]!);
  const fraction = match[3] ?? '';
  const retainedFraction = fraction.slice(0, 9).padEnd(9, '0');
  let magnitudeNanoseconds = wholeSeconds * NANOSECONDS_PER_SECOND + BigInt(retainedFraction);
  if (negative && fraction.length > 9 && /[1-9]/u.test(fraction.slice(9))) {
    magnitudeNanoseconds += 1n;
  }
  const totalNanoseconds = negative ? -magnitudeNanoseconds : magnitudeNanoseconds;

  let epochSeconds = totalNanoseconds / NANOSECONDS_PER_SECOND;
  let nanosecondsWithinSecond = totalNanoseconds % NANOSECONDS_PER_SECOND;
  if (nanosecondsWithinSecond < 0n) {
    epochSeconds -= 1n;
    nanosecondsWithinSecond += NANOSECONDS_PER_SECOND;
  }

  const epochMilliseconds = epochSeconds * MILLISECONDS_PER_SECOND
    + nanosecondsWithinSecond / 1_000_000n;
  if (epochMilliseconds < -MAXIMUM_DATE_MILLISECONDS || epochMilliseconds > MAXIMUM_DATE_MILLISECONDS) {
    return undefined;
  }

  const date = new Date(Number(epochMilliseconds));
  if (Number.isNaN(date.getTime())) return undefined;
  return {
    date,
    nanosecondsWithinSecond: Number(nanosecondsWithinSecond),
  };
}

function parseDateOperand({ value }: { value: string }): DateInstant | undefined {
  if (containsNonAsciiDateWhitespace({ value })) return undefined;
  if (value.startsWith('@')) {
    return parseEpochDateOperand({ value: value.slice(1) });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;

  // JavaScript Date accepts common ISO/RFC3339-shaped timestamps with more than
  // three fractional digits but stores only milliseconds. Preserve the source
  // fraction when it belongs to the terminal seconds field so `%N` and ns output
  // do not silently discard precision from an otherwise accepted date operand.
  const fractionalSecondMatch = /(?:T|[ \t])\d{2}:\d{2}:\d{2}\.(\d+)(?=(?:[zZ]|[+-]\d{2}:?\d{2}|[ \t]+(?:UTC|GMT))?[ \t]*$)/u.exec(value);
  const nanosecondsWithinSecond = fractionalSecondMatch === null
    ? date.getUTCMilliseconds() * 1_000_000
    : Number.parseInt(fractionalSecondMatch[1]!.slice(0, 9).padEnd(9, '0'), 10);
  return {
    date,
    nanosecondsWithinSecond,
  };
}

function offsetWithColon({ offset }: { offset: string }): string {
  return `${offset.slice(0, 3)}:${offset.slice(3)}`;
}

function formatIsoOutput({
  date,
  nanosecondsWithinSecond,
  zone,
  precision,
  separator,
}: {
  date: Date,
  nanosecondsWithinSecond: number,
  zone: DateZone,
  precision: IsoPrecision | Rfc3339Precision,
  separator: 'T' | ' ',
}): string {
  const fields = getDateFields({ date, zone });
  const datePart = `${fields.year.toString().padStart(4, '0')}-${pad2({ value: fields.month })}-${pad2({ value: fields.day })}`;
  const offset = offsetWithColon({ offset: fields.timezoneOffset });
  const hours = `${datePart}${separator}${pad2({ value: fields.hours })}`;
  const minutes = `${hours}:${pad2({ value: fields.minutes })}`;
  const seconds = `${minutes}:${pad2({ value: fields.seconds })}`;

  switch (precision) {
  case 'date':
    return datePart;
  case 'hours':
    return `${hours}${offset}`;
  case 'minutes':
    return `${minutes}${offset}`;
  case 'seconds':
    return `${seconds}${offset}`;
  case 'ns': {
    let fractionSeparator: ',' | '.';
    switch (separator) {
    case 'T':
      fractionSeparator = ',';
      break;
    case ' ':
      fractionSeparator = '.';
      break;
    default: {
      const _ex: never = separator;
      throw new Error(`Unhandled ISO separator: ${_ex}`);
    }
    }
    const nanoseconds = nanosecondsWithinSecond.toString().padStart(9, '0');
    return `${seconds}${fractionSeparator}${nanoseconds}${offset}`;
  }
  default: {
    const _ex: never = precision;
    throw new Error(`Unhandled ISO precision: ${_ex}`);
  }
  }
}

export const dateCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsedArgs = stopStandardArgvAtFirstEarlyExit({
      args: normalizeDateIsoShortBundles({ args: context.args }),
      spec: dateArgvSpec,
      earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS,
    });
    const parsed = parseStandardArgv({ args: parsedArgs, spec: dateArgvSpec });

    const diagnostic = parsed.diagnostics[0];
    const preHelpSemanticIssue = findDatePreHelpSemanticIssue({ parsed });
    const semanticIssuePrecedesDiagnostic = standardSemanticIssuePrecedesDiagnostic({
      args: parsedArgs,
      spec: dateArgvSpec,
      parsed,
      findSemanticIssue: findDatePreHelpSemanticIssue,
    });
    if (diagnostic !== undefined && !semanticIssuePrecedesDiagnostic) {
      await writeCommandUsageError({
        context,
        command: 'date',
        message: `date: ${diagnostic.message}`,
        argvSpec: dateArgvSpec,
      });
      return { exitCode: 1 };
    }

    const text = context.text();
    if (preHelpSemanticIssue !== undefined) {
      switch (preHelpSemanticIssue.kind) {
      case 'iso-precision':
        await text.error({ text: `date: invalid argument '${preHelpSemanticIssue.value}' for '--iso-8601'\n` });
        return { exitCode: 1 };
      case 'rfc3339-precision':
        await text.error({ text: `date: invalid argument '${preHelpSemanticIssue.value}' for '--rfc-3339'\n` });
        return { exitCode: 1 };
      case 'multiple-formats':
        await text.error({ text: 'date: multiple output formats specified\n' });
        return { exitCode: 1 };
      default: {
        const _ex: never = preHelpSemanticIssue;
        throw new Error(`Unhandled date pre-help semantic issue: ${JSON.stringify(_ex)}`);
      }
      }
    }

    const rawIsoPrecision = typeof parsed.optionValues.isoPrecision === 'string'
      ? parsed.optionValues.isoPrecision
      : undefined;
    const rawRfcPrecision = typeof parsed.optionValues.rfc3339Precision === 'string'
      ? parsed.optionValues.rfc3339Precision
      : undefined;
    const isoPrecision = rawIsoPrecision === undefined
      ? undefined
      : parseIsoPrecision({ value: rawIsoPrecision });
    const rfcPrecision = rawRfcPrecision === undefined
      ? undefined
      : parseRfc3339Precision({ value: rawRfcPrecision });

    if (rawIsoPrecision !== undefined && isoPrecision === undefined) {
      throw new Error(`date pre-help validation missed ISO precision: ${rawIsoPrecision}`);
    }
    if (rawRfcPrecision !== undefined && rfcPrecision === undefined) {
      throw new Error(`date pre-help validation missed RFC 3339 precision: ${rawRfcPrecision}`);
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'date',
        argvSpec: dateArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'date',
        message: `date: extra operand '${parsed.positionals[1] ?? ''}'`,
        argvSpec: dateArgvSpec,
      });
      return { exitCode: 1 };
    }

    const dateString = typeof parsed.optionValues.dateString === 'string'
      ? parsed.optionValues.dateString
      : undefined;
    const positional = parsed.positionals[0];
    if (positional !== undefined && !positional.startsWith('+')) {
      await text.error({ text: `date: invalid date '${positional}'\n` });
      return { exitCode: 1 };
    }

    const instant = dateString === undefined
      ? (() => {
        const date = new Date();
        return {
          date,
          nanosecondsWithinSecond: date.getUTCMilliseconds() * 1_000_000,
        } satisfies DateInstant;
      })()
      : parseDateOperand({ value: dateString });
    if (instant === undefined) {
      await text.error({ text: `date: invalid date '${dateString}'\n` });
      return { exitCode: 1 };
    }
    const { date, nanosecondsWithinSecond } = instant;

    const zone = resolveDateZone({
      utc: parsed.optionValues.utc === true,
      timezone: context.env.get('TZ'),
    });

    let output: string;
    if (isoPrecision !== undefined) {
      output = formatIsoOutput({ date, nanosecondsWithinSecond, zone, precision: isoPrecision, separator: 'T' });
    } else if (rfcPrecision !== undefined) {
      output = formatIsoOutput({ date, nanosecondsWithinSecond, zone, precision: rfcPrecision, separator: ' ' });
    } else if (parsed.optionValues.rfcEmail === true) {
      output = formatRfcEmailOutput({ date, zone });
    } else {
      const format = parsed.positionals[0]?.startsWith('+') === true
        ? parsed.positionals[0]!.slice(1)
        : '%a %b %e %T %Z %Y';
      output = formatDate({ format, date, nanosecondsWithinSecond, zone });
    }
    await text.print({ text: `${output}\n` });

    return { exitCode: 0 };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
