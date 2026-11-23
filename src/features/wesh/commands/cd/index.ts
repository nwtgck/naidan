import { defineArgvCatalog, defineArgvHelpPresentation, formatArgvOptionHelp, formatArgvUsageSummary, parseStandardArgv, type StandardArgvAction, type StandardArgvPolicy } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { canonicalizeExistingPath, resolvePath } from '@/features/wesh/path';
import type { WeshShellBuiltinFunction, WeshCommandResult } from '@/features/wesh/types';

interface CdCandidate {
  readonly path: string,
  readonly printResolvedPath: boolean,
  readonly printedPathOverride?: string,
}

type CdPathMode = 'logical' | 'physical';

function shouldSearchCdPath({ target }: { target: string }): boolean {
  return !target.startsWith('/')
    && target !== '.'
    && target !== '..'
    && !target.startsWith('./')
    && !target.startsWith('../');
}

function buildCdCandidates({
  cdPath,
  target,
}: {
  cdPath: string | undefined,
  target: string,
}): readonly CdCandidate[] {
  const candidates: CdCandidate[] = [];
  const seenPaths = new Set<string>();
  const appendCandidate = ({ path, printResolvedPath }: { readonly path: CdCandidate['path'], readonly printResolvedPath: CdCandidate['printResolvedPath'] }): void => {
    if (seenPaths.has(path)) {
      return;
    }
    seenPaths.add(path);
    candidates.push({ path, printResolvedPath });
  };

  if (cdPath !== undefined) {
    for (const entry of cdPath.split(':')) {
      const baseDirectory = entry.length === 0 ? '.' : entry;
      appendCandidate({
        path: `${baseDirectory}/${target}`,
        printResolvedPath: entry.length > 0,
      });
    }
  }

  appendCandidate({
    path: target,
    printResolvedPath: false,
  });
  return candidates;
}

const cdOptions = [
  {
    semantic: { kind: 'effects', effects: [{ key: 'mode', value: 'logical' }] },
    forms: [
      { kind: 'short', name: 'L', value: { kind: 'none' } },
      { kind: 'long', name: 'logical', value: { kind: 'none' } },
    ],
    summary: 'follow symbolic links logically',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'mode', value: 'physical' }] },
    forms: [
      { kind: 'short', name: 'P', value: { kind: 'none' } },
      { kind: 'long', name: 'physical', value: { kind: 'none' } },
    ],
    summary: 'resolve symbolic links before processing parent components',
  },
  {
    semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
    forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
    summary: 'display this help and exit',
  },
] as const;

const cdArgvCatalog = defineArgvCatalog<StandardArgvAction<never>>({
  definitions: cdOptions,
  nonExecutableLongOptions: [],
});
const cdArgvHelp = defineArgvHelpPresentation({ catalog: cdArgvCatalog, rows: cdOptions });
const cdArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'exact',
  optionBoundary: 'first-positional',
  occurrenceRetention: 'none',
};

export const cdCommandImplementation = {
  fn: async ({ context, shell }): Promise<WeshCommandResult> => {
    const { variables } = shell;
    const parsed = parseStandardArgv({
      args: context.args,
      catalog: cdArgvCatalog,
      policy: cdArgvPolicy,
    });

    const text = context.text();

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'cd',
        message: `cd: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: cdArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'cd',
        optionLines: formatArgvOptionHelp({ presentation: cdArgvHelp }),
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'cd',
        message: 'cd: too many arguments',
        usageSummary: formatArgvUsageSummary({ presentation: cdArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const positionalTarget = parsed.positionals[0];
    const target = positionalTarget ?? variables.get({ name: 'HOME' });
    if (target === undefined) {
      await text.error({ text: 'cd: HOME not set\n' });
      return { exitCode: 1 };
    }
    const pathMode = (parsed.optionValues.mode ?? 'logical') as CdPathMode;

    try {
      let candidates: readonly CdCandidate[];
      if (target === '-') {
        const oldPwd = variables.get({ name: 'OLDPWD' });
        if (oldPwd === undefined) {
          await text.error({ text: 'cd: OLDPWD not set\n' });
          return { exitCode: 1 };
        }
        if (oldPwd.length === 0) {
          shell.setCwd({ path: context.cwd });
          await text.print({ text: '\n' });
          return { exitCode: 0 };
        }
        candidates = [{
          path: oldPwd,
          printResolvedPath: true,
          printedPathOverride: oldPwd,
        }];
      } else {
        candidates = buildCdCandidates({
          cdPath: positionalTarget !== undefined && shouldSearchCdPath({ target })
            ? variables.get({ name: 'CDPATH' })
            : undefined,
          target,
        });
      }

      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          const selectedPath = await (async (): Promise<string> => {
            switch (pathMode) {
            case 'logical':
              return resolvePath({ cwd: context.cwd, path: candidate.path });
            case 'physical':
              return canonicalizeExistingPath({ context, path: candidate.path });
            default: {
              const _ex: never = pathMode;
              throw new Error(`Unhandled cd path mode: ${_ex}`);
            }
            }
          })();
          const res = await context.files.resolve({ path: selectedPath });
          (() => {
            switch (res.stat.type) {
            case 'directory':
              return;
            case 'file':
              throw new Error(`Not a directory: ${target}`);
            case 'fifo':
            case 'chardev':
            case 'symlink':
              throw new Error(`Not a directory: ${target}`);
            default: {
              const _ex: never = res.stat.type;
              throw new Error(`Unhandled type: ${_ex}`);
            }
            }
          })();

          shell.setCwd({ path: selectedPath });
          if (candidate.printResolvedPath) {
            await text.print({ text: `${candidate.printedPathOverride ?? selectedPath}\n` });
          }
          return { exitCode: 0 };
        } catch (error: unknown) {
          lastError = error;
        }
      }

      throw lastError ?? new Error(`Directory not found: ${target}`);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      await text.error({ text: `cd: ${target}: ${message}\n` });
      return { exitCode: 1 };
    }
  },
} satisfies { readonly fn: WeshShellBuiltinFunction<'setCwd' | 'variables'> };

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
