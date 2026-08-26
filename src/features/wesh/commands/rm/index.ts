import { STANDARD_HELP_EARLY_EXIT_OPTIONS, stopStandardArgvAtFirstEarlyExit } from '@/features/wesh/commands/_shared/argv';
import type { WeshCommandDefinition, WeshCommandResult, WeshCommandContext, WeshEntryRef } from '@/features/wesh/types';
import { parseStandardArgv, type StandardArgvParserSpec } from '@/features/wesh/argv';
import { createAffirmativeResponseReader } from '@/features/wesh/commands/_shared/confirmation';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';

type RmInteractiveMode = 'never' | 'always' | 'once';

function parseInteractiveLongOption({
  token,
}: {
  token: string,
}) {
  const prefix = '--interactive=';
  if (!token.startsWith(prefix)) return undefined;

  const value = token.slice(prefix.length);
  switch (value) {
  case 'always':
  case 'once': {
    const effects = [
      { key: 'force', value: false },
      { key: 'interactiveMode', value },
    ];
    return {
      kind: 'matched' as const,
      consumeCount: 1,
      effects,
      occurrences: [{
        kind: 'special' as const,
        option: '--interactive',
        effects,
      }],
    };
  }
  case 'never': {
    const effects = [{ key: 'interactiveMode', value }];
    return {
      kind: 'matched' as const,
      consumeCount: 1,
      effects,
      occurrences: [{
        kind: 'special' as const,
        option: '--interactive',
        effects,
      }],
    };
  }
  default:
    return {
      kind: 'matched' as const,
      consumeCount: 1,
      effects: [{ key: 'interactiveParseError', value }],
      occurrences: [{
        kind: 'special' as const,
        option: '--interactive',
        effects: [{ key: 'interactiveParseError', value }],
      }],
    };
  }
}

function parsePreserveRootLongOption({
  token,
}: {
  token: string,
}) {
  const prefix = '--preserve-root=';
  if (!token.startsWith(prefix)) return undefined;

  const value = token.slice(prefix.length);
  if (value === 'all') {
    const effects = [
      { key: 'preserveRoot', value: true },
      { key: 'preserveRootAll', value: true },
    ];
    return {
      kind: 'matched' as const,
      consumeCount: 1,
      effects,
      occurrences: [{
        kind: 'special' as const,
        option: '--preserve-root',
        effects,
      }],
    };
  }

  const effects = [{ key: 'preserveRootParseError', value }];
  return {
    kind: 'matched' as const,
    consumeCount: 1,
    effects,
    occurrences: [{
      kind: 'special' as const,
      option: '--preserve-root',
      effects,
    }],
  };
}

function promptsBeforeEveryRemoval({
  interactiveMode,
}: {
  interactiveMode: RmInteractiveMode,
}): boolean {
  switch (interactiveMode) {
  case 'always':
    return true;
  case 'never':
  case 'once':
    return false;
  default: {
    const _ex: never = interactiveMode;
    return _ex;
  }
  }
}

function asDirectoryEntryRef({
  entry,
}: {
  entry: WeshEntryRef,
}): WeshEntryRef<'directory'> {
  switch (entry.type) {
  case 'directory':
    return entry;
  case 'file':
  case 'fifo':
  case 'chardev':
  case 'symlink':
    throw new Error(`Not a directory: ${entry.fullPath}`);
  default: {
    const _ex: never = entry;
    throw new Error(`Unhandled entry type: ${_ex}`);
  }
  }
}

function describePromptType({
  type,
}: {
  type: 'file' | 'directory' | 'fifo' | 'chardev' | 'symlink',
}): string {
  switch (type) {
  case 'file':
    return 'regular file';
  case 'directory':
    return 'directory';
  case 'fifo':
    return 'fifo';
  case 'chardev':
    return 'character special file';
  case 'symlink':
    return 'symbolic link';
  default: {
    const _ex: never = type;
    return _ex;
  }
  }
}

function appendDisplayPath({
  parent,
  child,
}: {
  parent: string,
  child: string,
}): string {
  if (parent === '/') return `/${child}`;
  return `${parent.replace(/\/+$/u, '')}/${child}`;
}

const rmArgvSpec: StandardArgvParserSpec = {
  options: [
    { kind: 'flag', short: 'r', long: 'recursive', effects: [{ key: 'recursive', value: true }], help: { summary: 'remove directories and their contents recursively' } },
    { kind: 'flag', short: 'R', long: undefined, effects: [{ key: 'recursive', value: true }], help: { summary: 'remove directories and their contents recursively' } },
    { kind: 'flag', short: 'd', long: 'dir', effects: [{ key: 'removeEmptyDirectories', value: true }], help: { summary: 'remove empty directories' } },
    { kind: 'flag', short: 'f', long: 'force', effects: [{ key: 'force', value: true }, { key: 'interactiveMode', value: 'never' }], help: { summary: 'ignore nonexistent files and arguments, never prompt' } },
    { kind: 'flag', short: 'i', long: undefined, effects: [{ key: 'force', value: false }, { key: 'interactiveMode', value: 'always' }], help: { summary: 'prompt before every removal' } },
    { kind: 'flag', short: 'I', long: undefined, effects: [{ key: 'force', value: false }, { key: 'interactiveMode', value: 'once' }], help: { summary: 'prompt once before removing more than three files, or recursively' } },
    { kind: 'flag', short: undefined, long: 'interactive', effects: [{ key: 'force', value: false }, { key: 'interactiveMode', value: 'always' }], help: { summary: 'prompt according to WHEN: never, once, or always' } },
    { kind: 'flag', short: 'v', long: 'verbose', effects: [{ key: 'verbose', value: true }], help: { summary: 'explain what is being done' } },
    { kind: 'flag', short: undefined, long: 'one-file-system', effects: [{ key: 'oneFileSystem', value: true }], help: { summary: 'stay on this file system when removing recursively', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'preserve-root', effects: [{ key: 'preserveRoot', value: true }], help: { summary: "do not remove '/'", category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'no-preserve-root', effects: [{ key: 'preserveRoot', value: false }], help: { summary: 'do not treat root specially', category: 'advanced' } },
    { kind: 'flag', short: undefined, long: 'help', effects: [{ key: 'help', value: true }], help: { summary: 'display this help and exit', category: 'common' } },
  ],
  allowShortFlagBundles: true,
  stopAtDoubleDash: true,
  treatSingleDashAsPositional: true,
  specialTokenParsers: [
    ({ token }) => parseInteractiveLongOption({ token }),
    ({ token }) => parsePreserveRootLongOption({ token }),
  ],
};

export const rmCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'rm',
    description: 'Remove files or directories',
    usage: 'rm [OPTION]... FILE...',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopStandardArgvAtFirstEarlyExit({ args: context.args, spec: rmArgvSpec, earlyExitOptions: STANDARD_HELP_EARLY_EXIT_OPTIONS }),
      spec: rmArgvSpec,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'rm',
        message: `rm: ${diagnostic.message}`,
        argvSpec: rmArgvSpec,
      });
      return { exitCode: 1 };
    }

    const interactiveParseError = parsed.optionValues.interactiveParseError;
    if (typeof interactiveParseError === 'string') {
      await writeCommandUsageError({
        context,
        command: 'rm',
        message: `rm: invalid argument '${interactiveParseError}' for '--interactive'`,
        argvSpec: rmArgvSpec,
      });
      return { exitCode: 1 };
    }

    const preserveRootParseError = parsed.optionValues.preserveRootParseError;
    if (typeof preserveRootParseError === 'string') {
      await context.text().error({
        text: `rm: unrecognized --preserve-root argument: '${preserveRootParseError}'\n`,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'rm',
        argvSpec: rmArgvSpec,
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const recursive = parsed.optionValues.recursive === true;
    const removeEmptyDirectories = parsed.optionValues.removeEmptyDirectories === true;
    const force = parsed.optionValues.force === true;
    const verbose = parsed.optionValues.verbose === true;
    const interactiveMode = typeof parsed.optionValues.interactiveMode === 'string'
      ? parsed.optionValues.interactiveMode as RmInteractiveMode
      : 'never';

    if (parsed.positionals.length === 0) {
      if (force) return { exitCode: 0 };
      await writeCommandUsageError({
        context,
        command: 'rm',
        message: 'rm: missing operand',
        argvSpec: rmArgvSpec,
      });
      return { exitCode: 1 };
    }

    const readAffirmativeResponse = createAffirmativeResponseReader({ input: text.input });
    const confirm = async ({ prompt }: { prompt: string }): Promise<boolean> => {
      await text.error({ text: prompt });
      return readAffirmativeResponse();
    };

    if (interactiveMode === 'once' && (recursive || parsed.positionals.length > 3)) {
      const count = parsed.positionals.length;
      const recursiveText = recursive ? ' recursively' : '';
      if (!await confirm({ prompt: `rm: remove ${count} argument${count === 1 ? '' : 's'}${recursiveText}? ` })) {
        return { exitCode: 0 };
      }
    }

    let exitCode = 0;

    const removeRecursive = async ({
      entry,
      displayPath,
    }: {
      entry: WeshEntryRef,
      displayPath: string,
    }): Promise<boolean> => {
      type RemovalFrame =
        | {
            kind: 'visit';
            entry: WeshEntryRef;
            displayPath: string;
            isRoot: boolean;
          }
        | {
            kind: 'iterate-directory';
            iterator: AsyncIterator<WeshEntryRef>;
            displayPath: string;
          }
        | {
            kind: 'remove-directory';
            entry: WeshEntryRef<'directory'>;
            displayPath: string;
            isRoot: boolean;
          };

      const frames: RemovalFrame[] = [{
        kind: 'visit',
        entry,
        displayPath,
        isRoot: true,
      }];
      const activeIterators = new Set<AsyncIterator<WeshEntryRef>>();
      let rootRemoved = true;

      try {
        while (frames.length > 0) {
          const frame = frames.pop()!;
          switch (frame.kind) {
          case 'visit': {
            const stat = await context.files.statEntry({ entry: frame.entry });
            switch (stat.type) {
            case 'directory': {
              if (!recursive && !removeEmptyDirectories) {
                throw new Error('is a directory');
              }

              if (recursive && interactiveMode === 'always') {
                const descend = await confirm({
                  prompt: `rm: descend into directory '${frame.displayPath}'? `,
                });
                if (!descend) {
                  if (frame.isRoot) rootRemoved = false;
                  break;
                }
              }

              const directoryEntry = asDirectoryEntryRef({ entry: frame.entry });
              if (recursive) {
                const iterator = context.files.readDirEntry({
                  entry: directoryEntry,
                })[Symbol.asyncIterator]();
                activeIterators.add(iterator);
                frames.push({
                  kind: 'remove-directory',
                  entry: directoryEntry,
                  displayPath: frame.displayPath,
                  isRoot: frame.isRoot,
                });
                frames.push({
                  kind: 'iterate-directory',
                  iterator,
                  displayPath: frame.displayPath,
                });
                break;
              }

              if (promptsBeforeEveryRemoval({ interactiveMode })) {
                const removeDirectory = await confirm({
                  prompt: `rm: remove directory '${frame.displayPath}'? `,
                });
                if (!removeDirectory) {
                  if (frame.isRoot) rootRemoved = false;
                  break;
                }
              }

              await context.files.rmdir({ path: directoryEntry.fullPath });
              if (verbose) {
                await text.print({ text: `removed directory '${frame.displayPath}'\n` });
              }
              break;
            }
            case 'file':
            case 'fifo':
            case 'chardev':
            case 'symlink': {
              if (promptsBeforeEveryRemoval({ interactiveMode })) {
                const shouldRemove = await confirm({
                  prompt: `rm: remove ${describePromptType({ type: stat.type })} '${frame.displayPath}'? `,
                });
                if (!shouldRemove) {
                  if (frame.isRoot) rootRemoved = false;
                  break;
                }
              }
              await context.files.unlink({ path: frame.entry.fullPath });
              if (verbose) {
                await text.print({ text: `removed '${frame.displayPath}'\n` });
              }
              break;
            }
            default: {
              const _ex: never = stat.type;
              throw new Error(`Unhandled type: ${_ex}`);
            }
            }
            break;
          }
          case 'iterate-directory': {
            const next = await frame.iterator.next();
            if (next.done === true) {
              activeIterators.delete(frame.iterator);
              break;
            }
            frames.push(frame);
            frames.push({
              kind: 'visit',
              entry: next.value,
              displayPath: appendDisplayPath({
                parent: frame.displayPath,
                child: next.value.name,
              }),
              isRoot: false,
            });
            break;
          }
          case 'remove-directory': {
            if (promptsBeforeEveryRemoval({ interactiveMode })) {
              const removeDirectory = await confirm({
                prompt: `rm: remove directory '${frame.displayPath}'? `,
              });
              if (!removeDirectory) {
                if (frame.isRoot) rootRemoved = false;
                break;
              }
            }
            await context.files.rmdir({ path: frame.entry.fullPath });
            if (verbose) {
              await text.print({ text: `removed directory '${frame.displayPath}'\n` });
            }
            break;
          }
          default: {
            const _ex: never = frame;
            throw new Error(`Unhandled rm removal frame: ${JSON.stringify(_ex)}`);
          }
          }
        }
      } catch (error: unknown) {
        await Promise.allSettled(Array.from(activeIterators, async (iterator) => {
          await iterator.return?.();
        }));
        throw error;
      }

      return rootRemoved;
    };

    for (const operand of parsed.positionals) {
      try {
        const trimmedOperand = operand.replace(/\/+$/u, '') || '/';
        const finalComponent = trimmedOperand.slice(trimmedOperand.lastIndexOf('/') + 1);
        if (recursive && (finalComponent === '.' || finalComponent === '..')) {
          throw new Error(`refusing to remove '.' or '..' directory: skipping '${operand}'`);
        }

        const fullPath = resolvePath({ cwd: context.cwd, path: operand });
        if (recursive && fullPath === '/') {
          throw new Error("it is dangerous to operate recursively on '/'");
        }

        const entry = await context.files.resolveEntry({
          path: fullPath,
          finalSymlinkTreatment: 'no-follow',
        });
        if (operand.length > 1 && operand.endsWith('/')) {
          const stat = await context.files.statEntry({ entry });
          if (stat.type === 'symlink' && recursive) {
            const followed = await context.files.resolveEntry({
              path: fullPath,
              finalSymlinkTreatment: 'follow',
            });
            const followedStat = await context.files.statEntry({ entry: followed });
            switch (followedStat.type) {
            case 'directory':
              if (followed.fullPath === '/') {
                throw new Error("it is dangerous to operate recursively on '/'");
              }
              for await (const child of context.files.readDirEntry({
                entry: asDirectoryEntryRef({ entry: followed }),
              })) {
                await removeRecursive({
                  entry: child,
                  displayPath: appendDisplayPath({ parent: trimmedOperand, child: child.name }),
                });
              }
              if (force) continue;
              break;
            case 'file':
            case 'fifo':
            case 'chardev':
            case 'symlink':
              break;
            default: {
              const _ex: never = followedStat.type;
              throw new Error(`Unhandled file type: ${_ex}`);
            }
            }
            throw new Error('Not a directory');
          }
          if (!recursive && force && stat.type === 'symlink') {
            try {
              const followed = await context.files.resolveEntry({
                path: fullPath,
                finalSymlinkTreatment: 'follow',
              });
              switch (followed.type) {
              case 'directory':
                throw new Error('is a directory');
              case 'file':
              case 'fifo':
              case 'chardev':
              case 'symlink':
                break;
              default: {
                const _ex: never = followed;
                throw new Error(
                  `Unhandled file type: ${((_ex satisfies never) as { readonly type: string }).type}`,
                );
              }
              }
            } catch (error: unknown) {
              if (!isPathNotFoundError({ error })) throw error;
            }
            continue;
          }
          switch (stat.type) {
          case 'directory':
            break;
          case 'file':
          case 'fifo':
          case 'chardev':
          case 'symlink':
            if (force) continue;
            throw new Error('Not a directory');
          default: {
            const _ex: never = stat.type;
            throw new Error(`Unhandled file type: ${_ex}`);
          }
          }
        }
        await removeRecursive({ entry, displayPath: trimmedOperand });
      } catch (error: unknown) {
        if (force && isPathNotFoundError({ error })) continue;
        const message = error instanceof Error ? error.message : String(error);
        await text.error({ text: `rm: cannot remove '${operand}': ${message}\n` });
        exitCode = 1;
      }
    }

    return { exitCode };
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
