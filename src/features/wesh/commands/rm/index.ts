import { defineArgvCatalog, defineArgvHelpPresentation, parseStandardArgv, type ArgvOptionDefinition, type ParsedStandardArgv, type StandardArgvAction, type StandardArgvPolicy, type StandardArgvRawValue, HELP_EARLY_EXIT_OPTIONS, stopArgvAtFirstEarlyExit, formatArgvOptionHelp, formatArgvUsageSummary } from '@/features/wesh/argv-v2';
import type { WeshCommandImplementation, WeshCommandResult, WeshCommandContext, WeshEntryRef } from '@/features/wesh/types';
import { createAffirmativeResponseReader } from '@/features/wesh/commands/_shared/confirmation';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage-output';
import { resolvePath } from '@/features/wesh/path';

type RmInteractiveMode = 'never' | 'always' | 'once';

type RmDeferredOption =
  | 'force'
  | 'interactive-always'
  | 'interactive-once'
  | 'interactive-long'
  | 'preserve-root'
  | 'no-preserve-root';

const rmRecursiveOption = {
  semantic: { kind: 'effects', effects: [{ key: 'recursive', value: true }] },
  forms: [
    { kind: 'short', name: 'r', value: { kind: 'none' } },
    { kind: 'long', name: 'recursive', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RmDeferredOption>>;
const rmRecursiveUpperOption = {
  semantic: { kind: 'effects', effects: [{ key: 'recursive', value: true }] },
  forms: [{ kind: 'short', name: 'R', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RmDeferredOption>>;
const rmDirOption = {
  semantic: { kind: 'effects', effects: [{ key: 'removeEmptyDirectories', value: true }] },
  forms: [
    { kind: 'short', name: 'd', value: { kind: 'none' } },
    { kind: 'long', name: 'dir', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RmDeferredOption>>;
const rmForceOption = {
  semantic: { kind: 'deferred', tag: 'force' },
  forms: [
    { kind: 'short', name: 'f', value: { kind: 'none' } },
    { kind: 'long', name: 'force', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RmDeferredOption>>;
const rmInteractiveAlwaysOption = {
  semantic: { kind: 'deferred', tag: 'interactive-always' },
  forms: [{ kind: 'short', name: 'i', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RmDeferredOption>>;
const rmInteractiveOnceOption = {
  semantic: { kind: 'deferred', tag: 'interactive-once' },
  forms: [{ kind: 'short', name: 'I', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RmDeferredOption>>;
const rmInteractiveLongOption = {
  semantic: { kind: 'deferred', tag: 'interactive-long' },
  forms: [{ kind: 'long', name: 'interactive', value: { kind: 'optional-inline' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RmDeferredOption>>;
const rmVerboseOption = {
  semantic: { kind: 'effects', effects: [{ key: 'verbose', value: true }] },
  forms: [
    { kind: 'short', name: 'v', value: { kind: 'none' } },
    { kind: 'long', name: 'verbose', value: { kind: 'none' } },
  ],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RmDeferredOption>>;
const rmOneFileSystemOption = {
  semantic: { kind: 'effects', effects: [{ key: 'oneFileSystem', value: true }] },
  forms: [{ kind: 'long', name: 'one-file-system', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RmDeferredOption>>;
const rmPreserveRootOption = {
  semantic: { kind: 'deferred', tag: 'preserve-root' },
  forms: [{ kind: 'long', name: 'preserve-root', value: { kind: 'optional-inline' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RmDeferredOption>>;
const rmNoPreserveRootOption = {
  semantic: { kind: 'deferred', tag: 'no-preserve-root' },
  forms: [{ kind: 'long', name: 'no-preserve-root', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RmDeferredOption>>;
const rmHelpOption = {
  semantic: { kind: 'effects', effects: [{ key: 'help', value: true }] },
  forms: [{ kind: 'long', name: 'help', value: { kind: 'none' } }],
} as const satisfies ArgvOptionDefinition<StandardArgvAction<RmDeferredOption>>;

const rmArgvCatalog = defineArgvCatalog<StandardArgvAction<RmDeferredOption>>({
  nonExecutableLongOptions: ['-presume-input-tty', 'version'],
  definitions: [
    rmRecursiveOption, rmRecursiveUpperOption, rmDirOption, rmForceOption,
    rmInteractiveAlwaysOption, rmInteractiveOnceOption, rmInteractiveLongOption,
    rmVerboseOption, rmOneFileSystemOption, rmPreserveRootOption,
    rmNoPreserveRootOption, rmHelpOption,
  ],
});

const rmArgvHelp = defineArgvHelpPresentation({
  catalog: rmArgvCatalog,
  rows: [
    { forms: rmRecursiveOption.forms, summary: 'remove directories and their contents recursively' },
    { forms: rmRecursiveUpperOption.forms, summary: 'remove directories and their contents recursively' },
    { forms: rmDirOption.forms, summary: 'remove empty directories' },
    { forms: rmForceOption.forms, summary: 'ignore nonexistent files and arguments, never prompt' },
    { forms: rmInteractiveAlwaysOption.forms, summary: 'prompt before every removal' },
    { forms: rmInteractiveOnceOption.forms, summary: 'prompt once before removing more than three files, or recursively' },
    { forms: rmInteractiveLongOption.forms, summary: 'prompt according to WHEN: never, once, or always', valueName: 'WHEN' },
    { forms: rmVerboseOption.forms, summary: 'explain what is being done' },
    { forms: rmOneFileSystemOption.forms, summary: 'stay on this file system when removing recursively', category: 'advanced' },
    { forms: rmPreserveRootOption.forms, summary: "do not remove '/'", valueName: 'all', category: 'advanced' },
    { forms: rmNoPreserveRootOption.forms, summary: 'do not treat root specially', category: 'advanced' },
    { forms: rmHelpOption.forms, summary: 'display this help and exit', category: 'common' },
  ],
});

const rmArgvPolicy: StandardArgvPolicy = {
  longNameMatch: 'unique-prefix',
  optionBoundary: 'continue',
  occurrenceRetention: 'none',
};

function getOptionalInlineValue({
  value,
  option,
}: {
  value: StandardArgvRawValue,
  option: string,
}): string | undefined {
  switch (value.kind) {
  case 'none':
    return undefined;
  case 'inline':
    return value.rawValue;
  case 'next-argv':
    throw new Error(`${option} must not claim a following argv value`);
  default: {
    const _ex: never = value;
    throw new Error(`Unhandled ${option} raw value: ${JSON.stringify(_ex)}`);
  }
  }
}

function applyRmDeferredOptions({
  parsed,
}: {
  parsed: ParsedStandardArgv<RmDeferredOption>,
}): {
  force: boolean,
  interactiveMode: RmInteractiveMode,
  interactiveParseError: string | undefined,
  preserveRoot: boolean,
  preserveRootAll: boolean,
  preserveRootParseError: string | undefined,
} {
  let force = false;
  let interactiveMode: RmInteractiveMode = 'never';
  let interactiveParseError: string | undefined;
  let preserveRoot = true;
  let preserveRootAll = false;
  let preserveRootParseError: string | undefined;

  for (const occurrence of parsed.deferred) {
    switch (occurrence.semantic.tag) {
    case 'force':
      force = true;
      interactiveMode = 'never';
      break;
    case 'interactive-always':
      force = false;
      interactiveMode = 'always';
      break;
    case 'interactive-once':
      force = false;
      interactiveMode = 'once';
      break;
    case 'interactive-long': {
      const rawValue = getOptionalInlineValue({ value: occurrence.value, option: '--interactive' });
      if (rawValue === undefined || rawValue === 'always') {
        force = false;
        interactiveMode = 'always';
      } else if (rawValue === 'once') {
        force = false;
        interactiveMode = 'once';
      } else if (rawValue === 'never') {
        interactiveMode = 'never';
      } else if (interactiveParseError === undefined) {
        interactiveParseError = rawValue;
      }
      break;
    }
    case 'preserve-root': {
      const rawValue = getOptionalInlineValue({ value: occurrence.value, option: '--preserve-root' });
      if (rawValue === undefined) {
        preserveRoot = true;
      } else if (rawValue === 'all') {
        preserveRoot = true;
        preserveRootAll = true;
      } else if (preserveRootParseError === undefined) {
        preserveRootParseError = rawValue;
      }
      break;
    }
    case 'no-preserve-root':
      preserveRoot = false;
      break;
    default: {
      const _ex: never = occurrence.semantic.tag;
      throw new Error(`Unhandled rm deferred option: ${_ex}`);
    }
    }
  }

  return { force, interactiveMode, interactiveParseError, preserveRoot, preserveRootAll, preserveRootParseError };
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

export const rmCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    const parsed = parseStandardArgv({
      args: stopArgvAtFirstEarlyExit({
        args: context.args,
        catalog: rmArgvCatalog,
        policy: rmArgvPolicy,
        earlyExitOptions: HELP_EARLY_EXIT_OPTIONS,
      }),
      catalog: rmArgvCatalog,
      policy: rmArgvPolicy,
    });

    const diagnostic = parsed.diagnostics[0];
    if (diagnostic !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'rm',
        message: `rm: ${diagnostic.message}`,
        usageSummary: formatArgvUsageSummary({ presentation: rmArgvHelp }),
      });
      return { exitCode: 1 };
    }

    const deferredState = applyRmDeferredOptions({ parsed });

    if (deferredState.interactiveParseError !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'rm',
        message: `rm: invalid argument '${deferredState.interactiveParseError}' for '--interactive'`,
        usageSummary: formatArgvUsageSummary({ presentation: rmArgvHelp }),
      });
      return { exitCode: 1 };
    }

    if (deferredState.preserveRootParseError !== undefined) {
      await context.text().error({
        text: `rm: unrecognized --preserve-root argument: '${deferredState.preserveRootParseError}'\n`,
      });
      return { exitCode: 1 };
    }

    if (parsed.optionValues.help === true) {
      await writeCommandHelp({
        context,
        command: 'rm',
        optionLines: formatArgvOptionHelp({ presentation: rmArgvHelp }),
      });
      return { exitCode: 0 };
    }

    const text = context.text();
    const recursive = parsed.optionValues.recursive === true;
    const removeEmptyDirectories = parsed.optionValues.removeEmptyDirectories === true;
    const force = deferredState.force;
    const verbose = parsed.optionValues.verbose === true;
    const interactiveMode = deferredState.interactiveMode;

    if (parsed.positionals.length === 0) {
      if (force) return { exitCode: 0 };
      await writeCommandUsageError({
        context,
        command: 'rm',
        message: 'rm: missing operand',
        usageSummary: formatArgvUsageSummary({ presentation: rmArgvHelp }),
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
