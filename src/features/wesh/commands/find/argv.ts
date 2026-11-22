import {
  analyzeArgvLongForm,
  analyzeArgvShortForm,
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
} from '@/features/wesh/argv';

export type FindSymlinkMode = 'physical' | 'command-line' | 'logical';
type FindEarlyExitOption = 'help' | 'version';

const findOptions = [
  {
    semantic: 'command-line',
    forms: [{ kind: 'short', name: 'H', value: { kind: 'none' } }],
    summary: 'follow command-line symbolic links',
    category: 'advanced',
  },
  {
    semantic: 'logical',
    forms: [{ kind: 'short', name: 'L', value: { kind: 'none' } }],
    summary: 'follow symbolic links',
    category: 'advanced',
  },
  {
    semantic: 'physical',
    forms: [{ kind: 'short', name: 'P', value: { kind: 'none' } }],
    summary: 'never follow symbolic links',
    category: 'advanced',
  },
  {
    semantic: 'help',
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
  {
    semantic: 'version',
    forms: [{ kind: 'long', name: 'version', value: { kind: 'none' } }],
    summary: 'output version information and exit',
    category: 'advanced',
  },
] as const;

const findArgvCatalog = defineArgvCatalog<FindSymlinkMode | FindEarlyExitOption>({
  definitions: findOptions,
  nonExecutableLongOptions: [],
});

const findArgvHelp = defineArgvHelpPresentation({ catalog: findArgvCatalog, rows: findOptions });

export function getFindOptionHelp(): string[] {
  return formatArgvOptionHelp({ presentation: findArgvHelp });
}

export function getFindEarlyExitOption({ token }: { token: string }): FindEarlyExitOption | undefined {
  if (!token.startsWith('--') || token === '--') {
    return undefined;
  }
  const option = analyzeArgvLongForm({ token, catalog: findArgvCatalog, longNameMatch: 'exact' });
  if (option.kind !== 'matched' || option.value.kind !== 'none') {
    return undefined;
  }
  return option.semantic === 'help' || option.semantic === 'version' ? option.semantic : undefined;
}

function startsFindExpression({ token }: { token: string }): boolean {
  return token === '!' || token === '(' || token === ')' || token === ','
    || (token !== '-' && token.startsWith('-'));
}

// Traversal flags must be separate tokens before the first path or expression.
// A standalone "--" only terminates that leading phase.
export function parseFindArgv({ args, endIndex }: {
  args: readonly string[],
  endIndex: number,
}): {
  symlinkMode: FindSymlinkMode,
  paths: string[],
  expressionTokens: string[],
} {
  let index = 0;
  let symlinkMode: FindSymlinkMode = 'physical';
  while (index < endIndex) {
    const token = args[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token === undefined || token.length !== 2 || token[0] !== '-') {
      break;
    }
    const option = analyzeArgvShortForm({ token, bodyOffset: 1, prefix: '-', catalog: findArgvCatalog });
    if (option.kind !== 'matched' || option.value.kind !== 'none'
      || option.semantic === 'help' || option.semantic === 'version') {
      break;
    }
    symlinkMode = option.semantic;
    index += 1;
  }

  const pathStart = index;
  while (index < endIndex) {
    const token = args[index];
    if (token === undefined || startsFindExpression({ token })) {
      break;
    }
    index += 1;
  }
  return {
    symlinkMode,
    paths: pathStart === index ? ['.'] : args.slice(pathStart, index),
    expressionTokens: args.slice(index, endIndex),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
