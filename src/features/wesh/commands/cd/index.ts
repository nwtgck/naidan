import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { canonicalizeExistingPath, resolvePath } from '@/features/wesh/path';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext } from '@/features/wesh/types';
import { stopStandardOptionParsingAtFirstPositional } from '@/features/wesh/commands/_shared/argv';

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
  context,
  target,
  useCdPath,
}: {
  context: WeshCommandContext,
  target: string,
  useCdPath: boolean,
}): readonly CdCandidate[] {
  const candidates: CdCandidate[] = [];
  const seenPaths = new Set<string>();
  const appendCandidate = ({ path, printResolvedPath }: CdCandidate): void => {
    if (seenPaths.has(path)) {
      return;
    }
    seenPaths.add(path);
    candidates.push({ path, printResolvedPath });
  };

  if (useCdPath) {
    const cdPath = context.env.get('CDPATH');
    if (cdPath !== undefined) {
      for (const entry of cdPath.split(':')) {
        const baseDirectory = entry.length === 0 ? '.' : entry;
        appendCandidate({
          path: `${baseDirectory}/${target}`,
          printResolvedPath: entry.length > 0,
        });
      }
    }
  }

  appendCandidate({
    path: target,
    printResolvedPath: false,
  });
  return candidates;
}

const cdArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'L', long: 'logical', effects: [{ key: 'mode', value: 'logical' }], help: { summary: 'follow symbolic links logically' } },
    { kind: 'flag', short: 'P', long: 'physical', effects: [{ key: 'mode', value: 'physical' }], help: { summary: 'resolve symbolic links before processing parent components' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [],
};

export const cdCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'cd',
    description: 'Change current directory',
    usage: 'cd [-LP] [path]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardOptionParsingAtFirstPositional({ args: context.args, spec: cdArgvSpec }),
      spec: cdArgvSpec,
    });

    const text = context.text();

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'cd',
        message: `cd: ${diagnostic.message}`,
        argvSpec: cdArgvSpec,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'cd',
        argvSpec: cdArgvSpec,
      });
      return { exitCode: 0 };
    }

    if (parsed.positionals.length > 1) {
      await writeCommandUsageError({
        context,
        command: 'cd',
        message: 'cd: too many arguments',
        argvSpec: cdArgvSpec,
      });
      return { exitCode: 1 };
    }

    const positionalTarget = parsed.positionals[0];
    if (positionalTarget === undefined && !context.env.has('HOME')) {
      await text.error({ text: 'cd: HOME not set\n' });
      return { exitCode: 1 };
    }
    const target = positionalTarget ?? context.env.get('HOME')!;
    const pathMode = (parsed.optionValues.mode ?? 'logical') as CdPathMode;

    try {
      let candidates: readonly CdCandidate[];
      if (target === '-') {
        const oldPwd = context.env.get('OLDPWD');
        if (oldPwd === undefined) {
          await text.error({ text: 'cd: OLDPWD not set\n' });
          return { exitCode: 1 };
        }
        if (oldPwd.length === 0) {
          context.setCwd({ path: context.cwd });
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
          context,
          target,
          useCdPath: positionalTarget !== undefined && shouldSearchCdPath({ target }),
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

          context.setCwd({ path: selectedPath });
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
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
