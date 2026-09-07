export interface ParsedShellShebang {
  interpreter: string,
  optionalArgument: string | undefined,
}

function isShebangSeparator({ value }: { value: string | undefined }): boolean {
  return value === ' ' || value === '\t';
}

type EnvSplitEscape =
  | { kind: 'literal', value: string }
  | { kind: 'separator' }
  | { kind: 'terminate' }
  | { kind: 'invalid' };

function decodeEnvSplitEscape({
  escaped,
  mode,
}: {
  escaped: string | undefined,
  mode: 'unquoted' | 'double',
}): EnvSplitEscape {
  switch (escaped) {
  case 'f':
    return { kind: 'literal', value: '\f' };
  case 'n':
    return { kind: 'literal', value: '\n' };
  case 'r':
    return { kind: 'literal', value: '\r' };
  case 't':
    return { kind: 'literal', value: '\t' };
  case 'v':
    return { kind: 'literal', value: '\v' };
  case '#':
  case '$':
  case '"':
  case "'":
  case '\\':
    return { kind: 'literal', value: escaped };
  case '_':
    switch (mode) {
    case 'double':
      return { kind: 'literal', value: ' ' };
    case 'unquoted':
      return { kind: 'separator' };
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled env -S escape mode: ${_ex}`);
    }
    }
  case 'c':
    switch (mode) {
    case 'double':
      return { kind: 'invalid' };
    case 'unquoted':
      return { kind: 'terminate' };
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled env -S escape mode: ${_ex}`);
    }
    }
  case undefined:
    return { kind: 'invalid' };
  default:
    return { kind: 'invalid' };
  }
}

export function parseShellShebangLine({ firstLine }: { firstLine: string }): ParsedShellShebang | undefined {
  if (!firstLine.startsWith('#!')) return undefined;

  // Linux binfmt_script treats an existing NUL in its input buffer as the
  // terminator. Space/tab trimming is applied only when the parser supplies a
  // terminator at the newline/end boundary; whitespace immediately before an
  // existing NUL remains part of the optional argument. A CR from CRLF is
  // likewise part of that argument.
  const nulIndex = firstLine.indexOf('\0');
  let lineEnd = nulIndex < 0 ? firstLine.length : nulIndex;
  if (nulIndex < 0) {
    while (lineEnd > 2 && isShebangSeparator({ value: firstLine[lineEnd - 1] })) lineEnd -= 1;
  }

  let index = 2;
  while (index < lineEnd && isShebangSeparator({ value: firstLine[index] })) index += 1;

  const interpreterStart = index;
  while (index < lineEnd && !isShebangSeparator({ value: firstLine[index] })) index += 1;
  if (index === interpreterStart) return undefined;

  const interpreter = firstLine.slice(interpreterStart, index);
  if (index >= lineEnd) {
    return {
      interpreter,
      optionalArgument: undefined,
    };
  }

  while (index < lineEnd && isShebangSeparator({ value: firstLine[index] })) index += 1;
  return {
    interpreter,
    optionalArgument: firstLine.slice(index, lineEnd),
  };
}

export function splitEnvShebangArguments({ optionalArgument }: { optionalArgument: string }): string[] | undefined {
  const splitStringStart = (() => {
    if (optionalArgument.startsWith('-S')) {
      if (optionalArgument.length === 2) return undefined;
      return isShebangSeparator({ value: optionalArgument[2] }) ? 3 : 2;
    }
    const longOptionPrefix = '--split-string=';
    if (optionalArgument.startsWith(longOptionPrefix)) return longOptionPrefix.length;
    return undefined;
  })();
  if (splitStringStart === undefined) {
    return optionalArgument === '-S' ? undefined : [optionalArgument];
  }

  const args: string[] = [];
  const currentParts: string[] = [];
  let hasCurrent = false;
  let literalStart = splitStringStart;
  let mode: 'unquoted' | 'single' | 'double' = 'unquoted';

  const appendLiteral = ({ endIndex }: { endIndex: number }): void => {
    if (endIndex > literalStart) {
      currentParts.push(optionalArgument.slice(literalStart, endIndex));
      hasCurrent = true;
    }
    literalStart = endIndex;
  };

  const appendValue = ({ value }: { value: string }): void => {
    currentParts.push(value);
    hasCurrent = true;
  };

  const flush = (): void => {
    if (!hasCurrent) return;
    args.push(currentParts.length === 1 ? currentParts[0] ?? '' : currentParts.join(''));
    currentParts.length = 0;
    hasCurrent = false;
  };

  for (let index = splitStringStart; index < optionalArgument.length; index += 1) {
    const character = optionalArgument[index];
    if (character === undefined) continue;

    switch (mode) {
    case 'single':
      if (character === '\\') {
        const escaped = optionalArgument[index + 1];
        if (escaped === "'" || escaped === '\\') {
          appendLiteral({ endIndex: index });
          appendValue({ value: escaped });
          index += 1;
          literalStart = index + 1;
          continue;
        }
      }
      if (character === "'") {
        appendLiteral({ endIndex: index });
        mode = 'unquoted';
        hasCurrent = true;
        literalStart = index + 1;
      }
      continue;
    case 'double':
      if (character === '"') {
        appendLiteral({ endIndex: index });
        mode = 'unquoted';
        hasCurrent = true;
        literalStart = index + 1;
        continue;
      }
      if (character === '\\') {
        appendLiteral({ endIndex: index });
        const escape = decodeEnvSplitEscape({
          escaped: optionalArgument[index + 1],
          mode: 'double',
        });
        switch (escape.kind) {
        case 'literal':
          appendValue({ value: escape.value });
          index += 1;
          literalStart = index + 1;
          continue;
        case 'invalid':
        case 'separator':
        case 'terminate':
          return undefined;
        default: {
          const _ex: never = escape;
          return _ex;
        }
        }
      }
      continue;
    case 'unquoted':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled env -S split mode: ${_ex}`);
    }
    }

    if (isShebangSeparator({ value: character })) {
      appendLiteral({ endIndex: index });
      flush();
      literalStart = index + 1;
      continue;
    }
    if (character === '#') {
      if (!hasCurrent && currentParts.length === 0 && index === literalStart) {
        literalStart = optionalArgument.length;
        break;
      }
      continue;
    }
    if (character === '\\') {
      appendLiteral({ endIndex: index });
      const escape = decodeEnvSplitEscape({
        escaped: optionalArgument[index + 1],
        mode: 'unquoted',
      });
      switch (escape.kind) {
      case 'literal':
        appendValue({ value: escape.value });
        index += 1;
        literalStart = index + 1;
        continue;
      case 'separator':
        flush();
        index += 1;
        literalStart = index + 1;
        continue;
      case 'terminate':
        flush();
        return args;
      case 'invalid':
        return undefined;
      default: {
        const _ex: never = escape;
        return _ex;
      }
      }
    }
    if (character === "'") {
      appendLiteral({ endIndex: index });
      mode = 'single';
      hasCurrent = true;
      literalStart = index + 1;
      continue;
    }
    if (character === '"') {
      appendLiteral({ endIndex: index });
      mode = 'double';
      hasCurrent = true;
      literalStart = index + 1;
    }
  }

  switch (mode) {
  case 'unquoted':
    break;
  case 'single':
  case 'double':
    return undefined;
  default: {
    const _ex: never = mode;
    throw new Error(`Unhandled env -S split mode: ${_ex}`);
  }
  }

  appendLiteral({ endIndex: optionalArgument.length });
  flush();
  return args;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
