import {
  defineArgvCatalog,
  defineArgvHelpPresentation,
  formatArgvOptionHelp,
  formatArgvUsageSummary,
  HELP_EARLY_EXIT_OPTIONS,
  parseStandardArgv,
  stopArgvAtFirstEarlyExit,
  type StandardArgvAction,
  type StandardArgvPolicy,
} from '@/features/wesh/argv-v2';
import { getPathErrorReason, isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import {
  canonicalizeExistingPath,
  canonicalizePathAllowingMissingComponents,
  canonicalizePathAllowingMissingLeaf,
  normalizePath,
} from '@/features/wesh/path';

type CanonicalizationMode = 'default' | 'existing' | 'missing';
type SymlinkResolutionMode = 'logical' | 'physical' | 'strip';

function stripTrailingSlashes({ path }: { path: string }): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') {
    end -= 1;
  }
  return path.slice(0, end);
}

function relativePath({
  from,
  to,
}: {
  from: string;
  to: string;
}): string {
  const fromSegments = from.split('/').filter(segment => segment.length > 0);
  const toSegments = to.split('/').filter(segment => segment.length > 0);
  let commonLength = 0;
  while (
    commonLength < fromSegments.length
    && commonLength < toSegments.length
    && fromSegments[commonLength] === toSegments[commonLength]
  ) {
    commonLength += 1;
  }

  const segments = [
    ...Array.from({ length: fromSegments.length - commonLength }, () => '..'),
    ...toSegments.slice(commonLength),
  ];
  return segments.length === 0 ? '.' : segments.join('/');
}

function isWithinBase({
  base,
  path,
}: {
  base: string;
  path: string;
}): boolean {
  return base === '/' || path === base || path.startsWith(`${base}/`);
}

async function validateLogicalParentComponents({
  context,
  path,
}: {
  context: WeshCommandContext;
  path: string;
}): Promise<void> {
  const resolvedSegments = path.startsWith('/')
    ? []
    : context.cwd.split('/').filter(segment => segment.length > 0);

  for (const component of path.split('/')) {
    if (component.length === 0 || component === '.') {
      continue;
    }
    if (component !== '..') {
      resolvedSegments.push(component);
      continue;
    }
    if (resolvedSegments.length === 0) {
      continue;
    }

    const candidate = `/${resolvedSegments.join('/')}`;
    const stat = await context.files.stat({ path: candidate });
    switch (stat.type) {
    case 'directory':
      break;
    case 'file':
    case 'fifo':
    case 'chardev':
    case 'symlink':
      throw new Error(`Not a directory: ${candidate}`);
    default: {
      const _ex: never = stat.type;
      throw new Error(`Unhandled Wesh file type: ${_ex}`);
    }
    }
    resolvedSegments.pop();
  }
}

async function canonicalize({
  context,
  path,
  mode,
  symlinkResolutionMode,
}: {
  context: WeshCommandContext;
  path: string;
  mode: CanonicalizationMode;
  symlinkResolutionMode: SymlinkResolutionMode;
}): Promise<string> {
  if (path.length === 0) {
    throw new Error('No such file or directory');
  }

  switch (symlinkResolutionMode) {
  case 'strip': {
    const normalized = normalizePath({ cwd: context.cwd, path });
    switch (mode) {
    case 'existing': {
      const stat = await context.files.stat({ path: normalized });
      if (path.length > 1 && path.endsWith('/') && stat.type !== 'directory') {
        throw new Error(`Not a directory: ${normalized}`);
      }
      return normalized;
    }
    case 'missing':
      return normalized;
    case 'default':
      try {
        const stat = await context.files.stat({ path: normalized });
        if (path.length > 1 && path.endsWith('/') && stat.type !== 'directory') {
          throw new Error(`Not a directory: ${normalized}`);
        }
      } catch (error: unknown) {
        if (!isPathNotFoundError({ error })) {
          throw error;
        }
      }
      return normalized;
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unsupported realpath canonicalization mode: ${_exhaustive}`);
    }
    }
  }
  case 'logical':
  case 'physical':
    break;
  default: {
    const _exhaustive: never = symlinkResolutionMode;
    throw new Error(`Unsupported realpath symlink resolution mode: ${_exhaustive}`);
  }
  }

  let canonicalizationInput: string;
  switch (symlinkResolutionMode) {
  case 'logical':
    switch (mode) {
    case 'default':
    case 'existing':
      await validateLogicalParentComponents({ context, path });
      break;
    case 'missing':
      break;
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unsupported realpath canonicalization mode: ${_exhaustive}`);
    }
    }
    canonicalizationInput = normalizePath({ cwd: context.cwd, path });
    if (mode !== 'missing' && path.length > 1 && path.endsWith('/') && canonicalizationInput !== '/') {
      canonicalizationInput += '/';
    }
    break;
  case 'physical':
    switch (mode) {
    case 'missing':
      canonicalizationInput = stripTrailingSlashes({ path });
      break;
    case 'default':
    case 'existing':
      canonicalizationInput = path;
      break;
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unsupported realpath canonicalization mode: ${_exhaustive}`);
    }
    }
    break;
  default: {
    const _exhaustive: never = symlinkResolutionMode;
    throw new Error(`Unsupported realpath symlink resolution mode: ${_exhaustive}`);
  }
  }

  switch (mode) {
  case 'existing':
    switch (symlinkResolutionMode) {
    case 'logical':
      return canonicalizeExistingPath({
        context,
        path: canonicalizationInput,
        symlinkPolicy: 'limit_40',
      });
    case 'physical':
      return canonicalizeExistingPath({
        context,
        path: canonicalizationInput,
        symlinkPolicy: 'detect_cycles',
      });
    default: {
      const _exhaustive: never = symlinkResolutionMode;
      throw new Error(`Unsupported realpath symlink resolution mode: ${_exhaustive}`);
    }
    }
  case 'missing':
    return canonicalizePathAllowingMissingComponents({ context, path: canonicalizationInput });
  case 'default':
    switch (symlinkResolutionMode) {
    case 'logical':
      return canonicalizePathAllowingMissingLeaf({
        context,
        path: canonicalizationInput,
        symlinkPolicy: 'limit_40',
      });
    case 'physical':
      return canonicalizePathAllowingMissingLeaf({
        context,
        path: canonicalizationInput,
        symlinkPolicy: 'detect_cycles',
      });
    default: {
      const _exhaustive: never = symlinkResolutionMode;
      throw new Error(`Unsupported realpath symlink resolution mode: ${_exhaustive}`);
    }
    }
  default: {
    const _exhaustive: never = mode;
    throw new Error(`Unsupported realpath canonicalization mode: ${_exhaustive}`);
  }
  }
}

const realpathOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'mode', value: 'existing' }] },
    forms: [
      { kind: 'short', name: 'e', value: { kind: 'none' } },
      { kind: 'long', name: 'canonicalize-existing', value: { kind: 'none' } },
    ],
    summary: 'require that all path components exist',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'mode', value: 'missing' }] },
    forms: [
      { kind: 'short', name: 'm', value: { kind: 'none' } },
      { kind: 'long', name: 'canonicalize-missing', value: { kind: 'none' } },
    ],
    summary: 'allow missing path components',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'symlinkResolutionMode', value: 'logical' }] },
    forms: [
      { kind: 'short', name: 'L', value: { kind: 'none' } },
      { kind: 'long', name: 'logical', value: { kind: 'none' } },
    ],
    summary: "resolve '..' components before symlinks",
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'symlinkResolutionMode', value: 'physical' }] },
    forms: [
      { kind: 'short', name: 'P', value: { kind: 'none' } },
      { kind: 'long', name: 'physical', value: { kind: 'none' } },
    ],
    summary: 'resolve symlinks as encountered',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'symlinkResolutionMode', value: 'strip' }] },
    forms: [
      { kind: 'short', name: 's', value: { kind: 'none' } },
      { kind: 'long', name: 'strip', value: { kind: 'none' } },
    ],
    summary: "don't expand symlinks",
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'symlinkResolutionMode', value: 'strip' }] },
    forms: [{ kind: 'long', name: 'no-symlinks', value: { kind: 'none' } }],
    summary: "don't expand symlinks",
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'quiet', value: true }] },
    forms: [
      { kind: 'short', name: 'q', value: { kind: 'none' } },
      { kind: 'long', name: 'quiet', value: { kind: 'none' } },
    ],
    summary: 'suppress most error messages',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'relativeTo', parse: undefined },
    forms: [{ kind: 'long', name: 'relative-to', value: { kind: 'required', missingValueName: 'DIR' } }],
    summary: 'print paths relative to DIR',
    category: 'common',
  },
  {
    semantic: { kind: 'required-value', key: 'relativeBase', parse: undefined },
    forms: [{ kind: 'long', name: 'relative-base', value: { kind: 'required', missingValueName: 'DIR' } }],
    summary: 'print absolute paths unless below DIR',
    category: 'advanced',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'zero', value: true }] },
    forms: [
      { kind: 'short', name: 'z', value: { kind: 'none' } },
      { kind: 'long', name: 'zero', value: { kind: 'none' } },
    ],
    summary: 'end each output line with NUL, not newline',
    category: 'common',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
    category: 'common',
  },
] as const;

const realpathArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: realpathOptions,
  nonExecutableLongOptions: [],
});
const realpathArgvHelp = defineArgvHelpPresentation({ catalog: realpathArgvCatalog, rows: realpathOptions });
const realpathArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

export const realpathCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: realpathArgvCatalog,
        policy: realpathArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: realpathArgvCatalog,
      policy: realpathArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'realpath',
        message: `realpath: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: realpathArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'realpath',
        optionLines: formatArgvOptionHelp({ presentation: realpathArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length === 0) {
      await writeCommandUsageError({
        context,
        command: 'realpath',
        message: 'realpath: missing operand',
        usageSummary: formatArgvUsageSummary({ presentation: realpathArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const mode = (parsed.optionValues.mode as CanonicalizationMode | undefined) ?? 'default';
    const symlinkResolutionMode = (
      parsed.optionValues.symlinkResolutionMode as SymlinkResolutionMode | undefined
    ) ?? 'physical';
    const relativeToInput = parsed.optionValues.relativeTo as string | undefined;
    const relativeBaseInput = parsed.optionValues.relativeBase as string | undefined;
    const text = context.text();
    const quiet = parsed.optionValues.quiet === true;
    const terminator = parsed.optionValues.zero === true ? '\0' : '\n';
    let relativeTo: string | undefined;
    let relativeBase: string | undefined;

    try {
      if (relativeToInput !== undefined) {
        relativeTo = await canonicalize({
          context,
          path: relativeToInput,
          mode,
          symlinkResolutionMode,
        });
      }
      if (relativeBaseInput !== undefined) {
        relativeBase = await canonicalize({
          context,
          path: relativeBaseInput,
          mode,
          symlinkResolutionMode,
        });
      }
    } catch (error: unknown) {
      if (!quiet) {
        const message = getPathErrorReason({ error })
          ?? (error instanceof Error ? error.message : String(error));
        await text.error({ text: `realpath: ${relativeToInput ?? relativeBaseInput ?? ''}: ${message}\n` });
      }
      return { exitCode: 1 };
    }

    let exitCode = 0;
    for (const operand of parsed.positionals) {
      try {
        const resolved = await canonicalize({
          context,
          path: operand,
          mode,
          symlinkResolutionMode,
        });
        const shouldRelativize = relativeBase === undefined || isWithinBase({ base: relativeBase, path: resolved });
        const output = shouldRelativize && (relativeTo ?? relativeBase) !== undefined
          ? relativePath({ from: (relativeTo ?? relativeBase)!, to: resolved })
          : resolved;
        await text.print({ text: `${output}${terminator}` });
      } catch (error: unknown) {
        if (!quiet) {
          const message = getPathErrorReason({ error })
            ?? (error instanceof Error ? error.message : String(error));
          await text.error({ text: `realpath: ${operand}: ${message}\n` });
        }
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  isWithinBase,
  relativePath,
};
