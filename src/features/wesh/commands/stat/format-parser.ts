export type StatFormatDirective =
  | 'permissions-octal'
  | 'permissions-symbolic'
  | 'raw-mode'
  | 'file-type'
  | 'group-id'
  | 'inode'
  | 'name'
  | 'quoted-name'
  | 'size'
  | 'user-id'
  | 'birth-time'
  | 'birth-time-seconds'
  | 'modify-time'
  | 'modify-time-seconds'
  | 'unknown';

export interface StatFormatDirectiveToken {
  kind: 'directive',
  directive: StatFormatDirective,
  alignment: 'left' | 'right',
  padding: 'space' | 'zero',
  alternateForm: 'enabled' | 'disabled',
  width: number | undefined,
  precision: number | undefined,
}

export type StatFormatToken =
  | {
      kind: 'literal-text',
      value: string,
    }
  | {
      kind: 'literal-bytes',
      value: Uint8Array,
    }
  | StatFormatDirectiveToken;

export interface CompiledStatFormat {
  tokens: StatFormatToken[],
  warnings: string[],
  needsSymlinkTarget: boolean,
}

const MAX_FORMAT_LENGTH = 1_000_000;
const MAX_FORMAT_FIELD_SIZE = 1_000_000;
const printfByteEscapes: Readonly<Record<string, number>> = {
  '\\': 0x5c,
  a: 0x07,
  b: 0x08,
  e: 0x1b,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

const unavailableSingleDirectives = new Set([
  'b', 'B', 'C', 'd', 'D', 'G', 'h', 'm', 'o', 'r', 'R', 't', 'T', 'U', 'x', 'X', 'z', 'Z',
]);

interface ParsedPrintfEscape {
  nextIndex: number,
  literal: { kind: 'text', value: string } | { kind: 'byte', value: number },
  warning: string | undefined,
}

function parseBoundedInteger({
  value,
  description,
}: {
  value: string,
  description: string,
}): { ok: true, value: number } | { ok: false, message: string } {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_FORMAT_FIELD_SIZE) {
    return {
      ok: false,
      message: `stat: ${description} must be between 0 and ${MAX_FORMAT_FIELD_SIZE}`,
    };
  }
  return { ok: true, value: parsed };
}

function parsePrintfEscape({
  format,
  index,
}: {
  format: string,
  index: number,
}): ParsedPrintfEscape {
  const next = format[index + 1];
  if (next === undefined) {
    return {
      nextIndex: index + 1,
      literal: { kind: 'text', value: '\\' },
      warning: 'stat: warning: backslash at end of format',
    };
  }

  const escapedByte = printfByteEscapes[next];
  if (escapedByte !== undefined) {
    return {
      nextIndex: index + 2,
      literal: { kind: 'byte', value: escapedByte },
      warning: undefined,
    };
  }

  if (next === 'x') {
    let cursor = index + 2;
    let digits = '';
    while (digits.length < 2) {
      const candidate = format[cursor];
      if (candidate === undefined || !/[0-9a-fA-F]/u.test(candidate)) break;
      digits += candidate;
      cursor += 1;
    }
    if (digits.length === 0) {
      return {
        nextIndex: cursor,
        literal: { kind: 'text', value: 'x' },
        warning: "stat: warning: unrecognized escape '\\x'",
      };
    }
    return {
      nextIndex: cursor,
      literal: { kind: 'byte', value: Number.parseInt(digits, 16) },
      warning: undefined,
    };
  }

  if (/[0-7]/u.test(next)) {
    let cursor = index + 1;
    let digits = '';
    while (digits.length < 3) {
      const candidate = format[cursor];
      if (candidate === undefined || !/[0-7]/u.test(candidate)) break;
      digits += candidate;
      cursor += 1;
    }
    return {
      nextIndex: cursor,
      literal: { kind: 'byte', value: Number.parseInt(digits, 8) & 0xff },
      warning: undefined,
    };
  }

  return {
    nextIndex: index + 2,
    literal: { kind: 'text', value: next },
    warning: `stat: warning: unrecognized escape '\\${next}'`,
  };
}

function resolveDirective({
  code,
}: {
  code: string,
}): StatFormatDirective {
  switch (code) {
  case 'a':
    return 'permissions-octal';
  case 'A':
    return 'permissions-symbolic';
  case 'f':
    return 'raw-mode';
  case 'F':
    return 'file-type';
  case 'g':
    return 'group-id';
  case 'i':
    return 'inode';
  case 'n':
    return 'name';
  case 'N':
    return 'quoted-name';
  case 's':
    return 'size';
  case 'u':
    return 'user-id';
  case 'w':
    return 'birth-time';
  case 'W':
    return 'birth-time-seconds';
  case 'y':
    return 'modify-time';
  case 'Y':
    return 'modify-time-seconds';
  default:
    return 'unknown';
  }
}

export function compileStatFormat({
  format,
  escapeMode,
}: {
  format: string,
  escapeMode: 'literal' | 'printf',
}): { ok: true, value: CompiledStatFormat } | { ok: false, message: string } {
  if (format.length > MAX_FORMAT_LENGTH) {
    return {
      ok: false,
      message: `stat: format is too long (maximum ${MAX_FORMAT_LENGTH} characters)`,
    };
  }

  const tokens: StatFormatToken[] = [];
  const warnings: string[] = [];
  let literalTextParts: string[] = [];
  let literalBytes: number[] = [];
  let literalMode: 'text' | 'bytes' | undefined;
  let needsSymlinkTarget = false;

  const flushText = () => {
    if (literalTextParts.length === 0) return;
    tokens.push({ kind: 'literal-text', value: literalTextParts.join('') });
    literalTextParts = [];
  };
  const flushBytes = () => {
    if (literalBytes.length === 0) return;
    tokens.push({ kind: 'literal-bytes', value: Uint8Array.from(literalBytes) });
    literalBytes = [];
  };
  const flushLiteral = () => {
    flushText();
    flushBytes();
    literalMode = undefined;
  };
  const appendText = ({ value }: { value: string }) => {
    if (value.length === 0) return;
    switch (literalMode) {
    case 'bytes':
      flushBytes();
      break;
    case 'text':
    case undefined:
      break;
    default: {
      const _ex: never = literalMode;
      throw new Error(`Unhandled stat literal mode: ${String(_ex)}`);
    }
    }
    literalMode = 'text';
    literalTextParts.push(value);
  };
  const appendByte = ({ value }: { value: number }) => {
    switch (literalMode) {
    case 'text':
      flushText();
      break;
    case 'bytes':
    case undefined:
      break;
    default: {
      const _ex: never = literalMode;
      throw new Error(`Unhandled stat literal mode: ${String(_ex)}`);
    }
    }
    literalMode = 'bytes';
    literalBytes.push(value);
  };

  let index = 0;
  while (index < format.length) {
    const char = format[index]!;

    if (escapeMode === 'printf' && char === '\\') {
      const parsedEscape = parsePrintfEscape({ format, index });
      switch (parsedEscape.literal.kind) {
      case 'text':
        appendText({ value: parsedEscape.literal.value });
        break;
      case 'byte':
        appendByte({ value: parsedEscape.literal.value });
        break;
      default: {
        const _ex: never = parsedEscape.literal;
        throw new Error(`Unhandled stat printf escape: ${String(_ex)}`);
      }
      }
      if (parsedEscape.warning !== undefined) warnings.push(parsedEscape.warning);
      index = parsedEscape.nextIndex;
      continue;
    }

    if (char !== '%') {
      let runEnd = index + 1;
      while (runEnd < format.length) {
        const candidate = format[runEnd]!;
        if (candidate === '%' || (escapeMode === 'printf' && candidate === '\\')) break;
        runEnd += 1;
      }
      appendText({ value: format.slice(index, runEnd) });
      index = runEnd;
      continue;
    }

    const firstAfterPercent = format[index + 1];
    if (firstAfterPercent === undefined) {
      appendText({ value: '%' });
      index += 1;
      continue;
    }
    if (firstAfterPercent === '%') {
      appendText({ value: '%' });
      index += 2;
      continue;
    }

    flushLiteral();
    const directiveStart = index;
    let alignment: StatFormatDirectiveToken['alignment'] = 'right';
    let padding: StatFormatDirectiveToken['padding'] = 'space';
    let alternateForm: StatFormatDirectiveToken['alternateForm'] = 'disabled';
    let cursor = index + 1;

    while (cursor < format.length) {
      const flag = format[cursor]!;
      if (flag === '-') {
        alignment = 'left';
        cursor += 1;
        continue;
      }
      if (flag === '0') {
        padding = 'zero';
        cursor += 1;
        continue;
      }
      if (flag === '#') {
        alternateForm = 'enabled';
        cursor += 1;
        continue;
      }
      if (flag === '+' || flag === ' ' || flag === "'") {
        return {
          ok: false,
          message: `stat: unsupported format flag '${flag}'`,
        };
      }
      break;
    }

    let widthText = '';
    while (cursor < format.length && /[0-9]/u.test(format[cursor]!)) {
      widthText += format[cursor]!;
      cursor += 1;
    }

    let precision: number | undefined;
    if (format[cursor] === '.') {
      cursor += 1;
      let precisionText = '';
      while (cursor < format.length && /[0-9]/u.test(format[cursor]!)) {
        precisionText += format[cursor]!;
        cursor += 1;
      }
      if (precisionText.length === 0) {
        return { ok: false, message: 'stat: format precision requires decimal digits' };
      }
      const parsedPrecision = parseBoundedInteger({
        value: precisionText,
        description: 'format precision',
      });
      if (!parsedPrecision.ok) return parsedPrecision;
      precision = parsedPrecision.value;
    }

    const code = format[cursor];
    if (code === undefined) {
      return {
        ok: false,
        message: `stat: invalid format directive '${format.slice(directiveStart)}'`,
      };
    }

    const nextCode = format[cursor + 1];
    if ((code === 'H' || code === 'L') && (nextCode === 'd' || nextCode === 'r')) {
      return {
        ok: false,
        message: `stat: format directive '%${code}${nextCode}' is unavailable in Wesh`,
      };
    }
    if (unavailableSingleDirectives.has(code)) {
      return {
        ok: false,
        message: `stat: format directive '%${code}' is unavailable in Wesh`,
      };
    }

    const directive = resolveDirective({ code });
    if (precision !== undefined && directive !== 'modify-time-seconds') {
      return {
        ok: false,
        message: "stat: precision is only supported for '%Y' in Wesh",
      };
    }
    if (
      alternateForm === 'enabled'
      && directive !== 'permissions-octal'
      && directive !== 'raw-mode'
    ) {
      return {
        ok: false,
        message: "stat: alternate form is only supported for '%a' and '%f' in Wesh",
      };
    }

    let width: number | undefined;
    if (widthText.length > 0) {
      const parsedWidth = parseBoundedInteger({
        value: widthText,
        description: 'format width',
      });
      if (!parsedWidth.ok) return parsedWidth;
      width = parsedWidth.value;
    }

    switch (directive) {
    case 'quoted-name':
      needsSymlinkTarget = true;
      break;
    case 'permissions-octal':
    case 'permissions-symbolic':
    case 'raw-mode':
    case 'file-type':
    case 'group-id':
    case 'inode':
    case 'name':
    case 'size':
    case 'user-id':
    case 'birth-time':
    case 'birth-time-seconds':
    case 'modify-time':
    case 'modify-time-seconds':
    case 'unknown':
      break;
    default: {
      const _ex: never = directive;
      throw new Error(`Unhandled stat format directive: ${_ex}`);
    }
    }

    tokens.push({
      kind: 'directive',
      directive,
      alignment,
      padding,
      alternateForm,
      width,
      precision,
    });
    index = cursor + 1;
  }

  flushLiteral();
  return {
    ok: true,
    value: {
      tokens,
      warnings,
      needsSymlinkTarget,
    },
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
