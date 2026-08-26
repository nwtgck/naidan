export interface ParsedShellShebang {
  interpreter: string,
  optionalArgument: string | undefined,
}

function isShebangSeparator({ value }: { value: string | undefined }): boolean {
  return value === ' ' || value === '\t';
}

export function parseShellShebangLine({ firstLine }: { firstLine: string }): ParsedShellShebang | undefined {
  if (!firstLine.startsWith('#!')) return undefined;

  let index = 2;
  while (isShebangSeparator({ value: firstLine[index] })) index += 1;

  const interpreterStart = index;
  while (index < firstLine.length && !isShebangSeparator({ value: firstLine[index] })) index += 1;
  if (index === interpreterStart) return undefined;

  const interpreter = firstLine.slice(interpreterStart, index);
  if (index >= firstLine.length) {
    return {
      interpreter,
      optionalArgument: undefined,
    };
  }

  while (isShebangSeparator({ value: firstLine[index] })) index += 1;
  return {
    interpreter,
    optionalArgument: firstLine.slice(index),
  };
}

export function splitEnvShebangArguments({ optionalArgument }: { optionalArgument: string }): string[] | undefined {
  if (
    !optionalArgument.startsWith('-S') ||
    !isShebangSeparator({ value: optionalArgument[2] })
  ) {
    return [optionalArgument];
  }

  const args: string[] = [];
  let current = '';
  let hasCurrent = false;
  let mode: 'unquoted' | 'single' | 'double' = 'unquoted';

  const flush = (): void => {
    if (!hasCurrent) {
      return;
    }
    args.push(current);
    current = '';
    hasCurrent = false;
  };

  for (let index = 3; index < optionalArgument.length; index += 1) {
    const character = optionalArgument[index];
    if (character === undefined) {
      continue;
    }

    switch (mode) {
    case 'single':
      if (character === "'") {
        mode = 'unquoted';
      } else {
        current += character;
      }
      hasCurrent = true;
      continue;
    case 'double':
      if (character === '"') {
        mode = 'unquoted';
      } else {
        current += character;
      }
      hasCurrent = true;
      continue;
    case 'unquoted':
      break;
    default: {
      const _ex: never = mode;
      throw new Error(`Unhandled env -S split mode: ${_ex}`);
    }
    }

    if (isShebangSeparator({ value: character })) {
      flush();
      continue;
    }
    if (character === '#') {
      if (!hasCurrent) break;
      current += character;
      hasCurrent = true;
      continue;
    }
    if (character === '\\') {
      const escaped = optionalArgument[index + 1];
      if (escaped === '_') {
        flush();
        index += 1;
        continue;
      }
      if (escaped === 'c') {
        flush();
        return args;
      }
    }
    if (character === "'") {
      mode = 'single';
      hasCurrent = true;
      continue;
    }
    if (character === '"') {
      mode = 'double';
      hasCurrent = true;
      continue;
    }

    current += character;
    hasCurrent = true;
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

  flush();
  return args;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
