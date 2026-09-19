import type { WeshCommandContext, WeshCommandImplementation, WeshCommandResult } from '@/features/wesh/types';
import { isPathNotFoundError } from '@/features/wesh/commands/_shared/path-errors';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';
import { parsePatchArgv, parsePatchBackupStyle, patchArgvSpec, patchDirectoryOperandsBeforeTerminal } from './argv';
import {
  applyEdSection,
  applyTextSection,
  reverseSection,
  serializeContextRejects,
  serializeUnifiedRejects,
} from './engine';
import {
  appendFileBytes,
  createBackup,
  getPatchContentByteLength,
  installPatchedEntry,
  pathExists,
  PatchTargetResolutionError,
  readPatchInput,
  readPatchSource,
  installRenamedEntry,
  resolveEffectiveDirectory,
  resolvePatchTarget,
  writeOutputContent,
} from './filesystem';
import { parsePatchDocument } from './parser';
import type {
  PatchContent,
  PatchDirection,
  PatchFileKind,
  PatchOptions,
  ResolvedPatchOperands,
  PatchSection,
  PatchTarget,
  TextHunk,
  TextPatchSection,
} from './types';


function getDirectionAdjustedSection({
  section,
  direction,
}: {
  section: PatchSection,
  direction: PatchDirection,
}): PatchSection {
  switch (direction) {
  case 'forward':
    return section;
  case 'reverse':
    return reverseSection({ section });
  default: {
    const _ex: never = direction;
    throw new Error(`Unhandled patch direction: ${_ex}`);
  }
  }
}

function getSourceKind({ section }: { section: PatchSection }): PatchFileKind {
  return section.header.oldKind;
}

function getDestinationKind({ section }: { section: PatchSection }): PatchFileKind {
  return section.header.newKind;
}

function getDestinationMode({
  section,
  sourceMode,
}: {
  section: PatchSection,
  sourceMode: number,
}): number {
  return (section.header.newMode ?? sourceMode) & 0o7777;
}

function assertSupportedModeChange({ section }: { section: PatchSection }): void {
  switch (section.header.newKind) {
  case 'symlink':
    return;
  case 'regular':
    break;
  default: {
    const _ex: never = section.header.newKind;
    throw new Error(`Unhandled patch file kind: ${_ex}`);
  }
  }

  const oldMode = section.header.oldMode;
  const newMode = section.header.newMode;
  switch (section.header.operation) {
  case 'delete':
    return;
  case 'create':
    if (newMode !== undefined && newMode !== 0o644) {
      throw new Error(`regular file mode ${newMode.toString(8)} is not supported by Wesh`);
    }
    return;
  case 'modify':
  case 'copy':
  case 'rename':
    if (newMode !== undefined && (oldMode === undefined || oldMode !== newMode)) {
      throw new Error('regular file mode changes are not supported by Wesh');
    }
    return;
  default: {
    const _ex: never = section.header.operation;
    throw new Error(`Unhandled patch operation: ${_ex}`);
  }
  }
}

function normalizeRemoveEmptyDeletionSection({
  section,
  options,
}: {
  section: PatchSection,
  options: PatchOptions,
}): PatchSection {
  if (!options.removeEmptyFiles || section.header.operation !== 'modify') return section;

  switch (section.kind) {
  case 'ed':
    return section;
  case 'text': {
    if (section.hunks.length !== 1) return section;
    const hunk = section.hunks[0]!;
    if (
      hunk.oldRange.start !== 1
      || hunk.oldRange.count === 0
      || hunk.newRange.start !== 0
      || hunk.newRange.count !== 0
      || hunk.lines.some((line) => line.kind !== 'remove')
    ) {
      return section;
    }
    return {
      ...section,
      header: {
        ...section.header,
        operation: 'delete',
      },
    };
  }
  default: {
    const _ex: never = section;
    throw new Error(`Unhandled patch section: ${JSON.stringify(_ex)}`);
  }
  }
}

function shouldDeleteTarget({
  section,
  resultByteLength,
  options,
}: {
  section: PatchSection,
  resultByteLength: number,
  options: PatchOptions,
}): boolean {
  if (resultByteLength !== 0) return false;
  switch (section.header.operation) {
  case 'delete':
    return !options.posix || options.removeEmptyFiles;
  case 'modify':
  case 'create':
  case 'copy':
  case 'rename':
    return options.removeEmptyFiles;
  default: {
    const _ex: never = section.header.operation;
    throw new Error(`Unhandled patch operation: ${_ex}`);
  }
  }
}

function shouldCreateBackup({
  options,
  usedOffset,
  usedFuzz,
  rejectedCount,
  usedReverse,
}: {
  options: PatchOptions,
  usedOffset: boolean,
  usedFuzz: boolean,
  rejectedCount: number,
  usedReverse: boolean,
}): boolean {
  if (options.backupAlways) return true;

  const mismatchRequiresBackup = usedOffset || usedFuzz || rejectedCount > 0 || usedReverse;
  switch (options.backupMismatchMode) {
  case 'enabled':
    return mismatchRequiresBackup;
  case 'disabled':
    return false;
  case 'default':
    return !options.posix && mismatchRequiresBackup;
  default: {
    const _ex: never = options.backupMismatchMode;
    throw new Error(`Unhandled backup mismatch mode: ${_ex}`);
  }
  }
}

async function writeStatus({
  context,
  options,
  text,
  always,
}: {
  context: WeshCommandContext,
  options: PatchOptions,
  text: string,
  always: boolean,
}): Promise<void> {
  if (!always && options.quietMode === 'quiet') return;
  if (options.outputPath === '-') {
    await context.text().error({ text });
  } else {
    await context.text().print({ text });
  }
}

function quoteDiagnosticPath({ path }: { path: string }): string {
  if (!/[\s']/u.test(path)) return path;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function rejectDisplayPath({ target, options }: { target: PatchTarget, options: PatchOptions }): string {
  return options.rejectPath ?? `${options.outputPath ?? target.displayPath}.rej`;
}

function rejectStoragePath({ target, options }: { target: PatchTarget, options: PatchOptions }): string {
  return options.rejectPath ?? `${options.outputPath ?? target.destinationPath}.rej`;
}

function formatPatchStatusTarget({
  target,
  options,
}: {
  target: PatchTarget,
  options: PatchOptions,
}): string {
  const displayPath = quoteDiagnosticPath({ path: target.displayPath });
  if (options.outputPath === undefined) return displayPath;
  return `${quoteDiagnosticPath({ path: options.outputPath })} (read from ${displayPath})`;
}

async function writeRejectSummary({
  context,
  options,
  target,
  rejectedCount,
  totalCount,
  rejectionKind,
}: {
  context: WeshCommandContext,
  options: PatchOptions,
  target: PatchTarget,
  rejectedCount: number,
  totalCount: number,
  rejectionKind: 'failed' | 'ignored',
}): Promise<void> {
  const hunkWord = totalCount === 1 ? 'hunk' : 'hunks';
  const disposition = (() => {
    switch (rejectionKind) {
    case 'failed':
      return 'FAILED';
    case 'ignored':
      return 'ignored';
    default: {
      const _ex: never = rejectionKind;
      throw new Error(`Unhandled patch rejection kind: ${_ex}`);
    }
    }
  })();
  const destination = rejectDisplayPath({ target, options });
  const suffix = options.dryRun || destination === '-'
    ? ''
    : ` -- saving rejects to file ${destination}`;
  await writeStatus({
    context,
    options,
    text: `${rejectedCount} out of ${totalCount} ${hunkWord} ${disposition}${suffix}\n`,
    always: true,
  });
}

function rejectBytesForHunks({
  section,
  hunks,
  target,
  options,
}: {
  section: TextPatchSection,
  hunks: readonly TextHunk[],
  target: PatchTarget,
  options: PatchOptions,
}): Uint8Array {
  const oldPath = section.header.oldPath ?? target.displayPath;
  const newPath = section.header.newPath ?? target.displayPath;
  const defaultFormat = (() => {
    switch (section.format) {
    case 'unified':
      return 'unified' as const;
    case 'context':
    case 'normal':
      return 'context' as const;
    default: {
      const _ex: never = section.format;
      throw new Error(`Unhandled patch format: ${_ex}`);
    }
    }
  })();
  const format = options.rejectFormat ?? defaultFormat;
  switch (format) {
  case 'unified':
    return serializeUnifiedRejects({ hunks, oldPath, newPath });
  case 'context':
    return serializeContextRejects({ hunks, oldPath, newPath });
  default: {
    const _ex: never = format;
    throw new Error(`Unhandled reject format: ${_ex}`);
  }
  }
}

async function writeRejects({
  context,
  section,
  target,
  rejectedHunks,
  options,
  initializedRejectPaths,
  effectiveDirectory,
}: {
  context: WeshCommandContext,
  section: TextPatchSection,
  target: PatchTarget,
  rejectedHunks: TextHunk[],
  options: PatchOptions,
  initializedRejectPaths: Set<string>,
  effectiveDirectory: string,
}): Promise<void> {
  if (rejectedHunks.length === 0 || options.dryRun) return;

  const bytes = rejectBytesForHunks({ section, hunks: rejectedHunks, target, options });
  const rawPath = rejectStoragePath({ target, options });
  if (rawPath === '-') return;

  const fullPath = rawPath.startsWith('/')
    ? rawPath
    : resolvePath({ cwd: effectiveDirectory, path: rawPath });
  if (fullPath === target.destinationPath || fullPath === target.sourcePath) {
    throw new Error(`reject path would overwrite patched file '${fullPath}'`);
  }
  if (!initializedRejectPaths.has(fullPath)) {
    await installPatchedEntry({
      context,
      targetPath: fullPath,
      kind: 'regular',
      content: { kind: 'bytes', bytes },
      mode: 0o644,
      deleteTarget: false,
    });
    initializedRejectPaths.add(fullPath);
    return;
  }

  await appendFileBytes({ context, path: fullPath, bytes });
}

async function assertDestinationAvailable({
  context,
  target,
  allowExistingEmptyCreateDestination,
}: {
  context: WeshCommandContext,
  target: PatchTarget,
  allowExistingEmptyCreateDestination: boolean,
}): Promise<void> {
  if (target.sourcePath === target.destinationPath) return;
  switch (target.operation) {
  case 'create':
    if (allowExistingEmptyCreateDestination) return;
    if (await pathExists({ context, path: target.destinationPath })) {
      throw new Error(`create destination already exists: '${target.destinationPath}'`);
    }
    return;
  case 'copy':
  case 'rename':
    if (await pathExists({ context, path: target.destinationPath })) {
      throw new Error(`${target.operation} destination already exists: '${target.destinationPath}'`);
    }
    return;
  case 'modify':
  case 'delete':
    return;
  default: {
    const _ex: never = target.operation;
    throw new Error(`Unhandled patch operation: ${_ex}`);
  }
  }
}

type PatchStructuralConflict =
  | 'create-destination-exists'
  | 'delete-source-missing'
  | 'rename-source-missing-destination-exists';

async function isExistingEmptyRegularFile({
  context,
  path,
}: {
  context: WeshCommandContext,
  path: string,
}): Promise<boolean> {
  if (!await pathExists({ context, path })) return false;
  const stat = await context.files.lstat({ path });
  return stat.type === 'file' && stat.size === 0;
}

async function getPatchStructuralConflict({
  context,
  section,
  target,
}: {
  context: WeshCommandContext,
  section: PatchSection,
  target: PatchTarget,
}): Promise<PatchStructuralConflict | undefined> {
  switch (section.header.operation) {
  case 'create':
    if (!await pathExists({ context, path: target.destinationPath })) return undefined;
    return await isExistingEmptyRegularFile({ context, path: target.destinationPath })
      ? undefined
      : 'create-destination-exists';
  case 'delete':
    return target.sourcePath !== undefined
      && !await pathExists({ context, path: target.sourcePath })
      ? 'delete-source-missing'
      : undefined;
  case 'rename': {
    if (target.sourcePath === undefined) return undefined;
    const sourceExists = await pathExists({ context, path: target.sourcePath });
    const destinationExists = await pathExists({ context, path: target.destinationPath });
    return !sourceExists && destinationExists
      ? 'rename-source-missing-destination-exists'
      : undefined;
  }
  case 'modify':
  case 'copy':
    return undefined;
  default: {
    const _ex: never = section.header.operation;
    throw new Error(`Unhandled patch operation: ${_ex}`);
  }
  }
}

function structuralDirectionFallbackAction({
  options,
}: {
  options: PatchOptions,
}): 'apply-opposite' | 'skip-opposite' | 'apply-initial' {
  if (options.force) return 'apply-initial';
  if (options.forwardOnly) return 'skip-opposite';
  if (options.batch) return 'apply-opposite';
  return 'skip-opposite';
}

async function writeVerboseRecognition({
  context,
  section,
  options,
}: {
  context: WeshCommandContext,
  section: PatchSection,
  options: PatchOptions,
}): Promise<void> {
  switch (options.quietMode) {
  case 'normal':
  case 'quiet':
    return;
  case 'verbose':
    break;
  default: {
    const _ex: never = options.quietMode;
    throw new Error(`Unhandled quiet mode: ${_ex}`);
  }
  }
  const sectionFormat = section.format;
  const description = (() => {
    switch (sectionFormat) {
    case 'unified': return 'a unified diff';
    case 'context': return 'a context diff';
    case 'normal': return 'a normal diff';
    case 'ed': return 'an ed script';
    default: {
      const _ex: never = sectionFormat;
      throw new Error(`Unhandled patch format: ${_ex}`);
    }
    }
  })();
  const leading = section.header.oldPath !== undefined || section.header.newPath !== undefined
    ? `The text leading up to this was:
--------------------------
|--- ${section.header.oldPath ?? 'unknown'}
|+++ ${section.header.newPath ?? section.header.oldPath ?? 'unknown'}
--------------------------
`
    : '';
  await context.text().print({
    text: `Hmm...  Looks like ${description} to me...
${leading}`,
  });
}

async function applySection({
  context,
  section,
  explicitOriginalPath,
  effectiveDirectory,
  options,
  initializedRejectPaths,
  backedUpPaths,
}: {
  context: WeshCommandContext,
  section: PatchSection,
  explicitOriginalPath: string | undefined,
  effectiveDirectory: string,
  options: PatchOptions,
  initializedRejectPaths: Set<string>,
  backedUpPaths: Set<string>,
}): Promise<{ exitCode: 0 | 1, output: PatchContent }> {
  if (section.header.gitBinary) {
    await writeStatus({
      context,
      options,
      text: `File at patch line ${section.sourceLineNumber}: git binary diffs are not supported.\n`,
      always: true,
    });
    return { exitCode: 1, output: { kind: 'bytes', bytes: new Uint8Array(0) } };
  }

  let effectiveOptions = options;
  let assumedReverse = false;
  let ignoredExplicitReverse = false;
  let assumedMissingDeletionReverse = false;
  let forcedStructuralConflict: PatchStructuralConflict | undefined;
  const operationAdjustedSection = normalizeRemoveEmptyDeletionSection({ section, options });
  let targetSection = options.explicitReverse
    ? reverseSection({ section: operationAdjustedSection })
    : operationAdjustedSection;

  let target = await resolvePatchTarget({
    context,
    section: targetSection,
    explicitOriginalPath,
    effectiveDirectory,
    stripCount: options.stripCount,
  });

  if (targetSection.kind === 'text' && getSourceKind({ section: targetSection }) === 'regular') {
    const inspectedPath = (() => {
      switch (targetSection.header.operation) {
      case 'create':
        return target.destinationPath;
      case 'modify':
      case 'delete':
      case 'copy':
      case 'rename':
        return target.sourcePath;
      default: {
        const _ex: never = targetSection.header.operation;
        throw new Error(`Unhandled patch operation: ${_ex}`);
      }
      }
    })();
    if (inspectedPath !== undefined && await pathExists({ context, path: inspectedPath })) {
      const stat = await context.files.lstat({ path: inspectedPath });
      const isRegularFile = (() => {
        switch (stat.type) {
        case 'file':
          return true;
        case 'directory':
        case 'symlink':
        case 'fifo':
        case 'chardev':
          return false;
        default: {
          const _ex: never = stat.type;
          throw new Error(`Unhandled patch target type: ${_ex}`);
        }
        }
      })();
      if (!isRegularFile) {
        await writeStatus({
          context,
          options,
          text: `File ${quoteDiagnosticPath({ path: target.displayPath })} is not a regular file -- refusing to patch\n`,
          always: true,
        });
        await writeRejects({
          context,
          section: targetSection,
          target,
          rejectedHunks: [...targetSection.hunks],
          options,
          initializedRejectPaths,
          effectiveDirectory,
        });
        await writeRejectSummary({
          context,
          options,
          target,
          rejectedCount: targetSection.hunks.length,
          totalCount: targetSection.hunks.length,
          rejectionKind: 'ignored',
        });
        return {
          exitCode: 1,
          output: { kind: 'bytes', bytes: new Uint8Array(0) },
        };
      }
    }
  }

  const structuralConflict = await getPatchStructuralConflict({
    context,
    section: targetSection,
    target,
  });
  if (structuralConflict !== undefined) {
    const action = structuralDirectionFallbackAction({ options });
    switch (action) {
    case 'apply-initial':
      forcedStructuralConflict = structuralConflict;
      break;
    case 'apply-opposite':
    case 'skip-opposite': {
      targetSection = reverseSection({ section: targetSection });
      target = await resolvePatchTarget({
        context,
        section: targetSection,
        explicitOriginalPath,
        effectiveDirectory,
        stripCount: options.stripCount,
      });
      switch (action) {
      case 'skip-opposite': {
        await writeStatus({
          context,
          options,
          text: `patching file ${formatPatchStatusTarget({ target, options })}\n`,
          always: false,
        });
        await writeStatus({
          context,
          options,
          text: options.explicitReverse
            ? 'Unreversed patch detected!  Skipping patch.\n'
            : 'Reversed (or previously applied) patch detected!  Skipping patch.\n',
          always: true,
        });
        switch (section.kind) {
        case 'text':
          await writeRejects({
            context,
            section,
            target,
            rejectedHunks: section.hunks,
            options,
            initializedRejectPaths,
            effectiveDirectory,
          });
          await writeRejectSummary({
            context,
            options,
            target,
            rejectedCount: section.hunks.length,
            totalCount: section.hunks.length,
            rejectionKind: 'ignored',
          });
          break;
        case 'ed':
          break;
        default: {
          const _ex: never = section;
          throw new Error(`Unhandled patch section: ${JSON.stringify(_ex)}`);
        }
        }
        const current = await readPatchSource({
          context,
          path: target.sourcePath,
          expectedKind: getSourceKind({ section: targetSection }),
        });
        return {
          exitCode: 1,
          output: {
            kind: 'line-plan',
            source: current.source,
            pieces: [{ kind: 'source', startLine: 0, endLine: current.source.lineCount }],
          },
        };
      }
      case 'apply-opposite':
        effectiveOptions = { ...options, explicitReverse: !options.explicitReverse };
        assumedReverse = !options.explicitReverse;
        ignoredExplicitReverse = options.explicitReverse;
        assumedMissingDeletionReverse = assumedReverse && targetSection.header.operation === 'create';
        break;
      default: {
        const _ex: never = action;
        throw new Error(`Unhandled structural reverse action: ${_ex}`);
      }
      }
      break;
    }
    default: {
      const _ex: never = action;
      throw new Error(`Unhandled structural reverse action: ${_ex}`);
    }
    }
  }

  await writeVerboseRecognition({ context, section: targetSection, options });
  assertSupportedModeChange({ section: targetSection });

  const existingEmptyCreateDestination = targetSection.header.operation === 'create'
    && await isExistingEmptyRegularFile({ context, path: target.destinationPath });

  const forcedTextStructuralConflict = (() => {
    switch (forcedStructuralConflict) {
    case 'create-destination-exists':
    case 'delete-source-missing':
      return forcedStructuralConflict;
    case 'rename-source-missing-destination-exists':
    case undefined:
      return undefined;
    default: {
      const _ex: never = forcedStructuralConflict;
      throw new Error(`Unhandled patch structural conflict: ${_ex}`);
    }
    }
  })();

  if (forcedTextStructuralConflict !== undefined) {
    const { operation, condition } = (() => {
      switch (forcedTextStructuralConflict) {
      case 'create-destination-exists':
        return { operation: 'create', condition: 'already exists' } as const;
      case 'delete-source-missing':
        return { operation: 'delete', condition: 'does not exist' } as const;
      default: {
        const _ex: never = forcedTextStructuralConflict;
        throw new Error(`Unhandled forced structural conflict: ${_ex}`);
      }
      }
    })();
    const reversePhrase = options.explicitReverse ? ', when reversed,' : '';
    await writeStatus({
      context,
      options,
      text: `The next patch${reversePhrase} would ${operation} the file ${quoteDiagnosticPath({ path: target.displayPath })},\nwhich ${condition}!  Applying it anyway.\n`,
      always: false,
    });
  } else {
    await assertDestinationAvailable({
      context,
      target,
      allowExistingEmptyCreateDestination: existingEmptyCreateDestination,
    });
  }

  const sourcePath = (() => {
    switch (forcedTextStructuralConflict) {
    case 'create-destination-exists':
      return target.destinationPath;
    case 'delete-source-missing':
      return undefined;
    case undefined:
      return existingEmptyCreateDestination ? target.destinationPath : target.sourcePath;
    default: {
      const _ex: never = forcedTextStructuralConflict;
      throw new Error(`Unhandled forced structural conflict: ${_ex}`);
    }
    }
  })();
  const source = await readPatchSource({
    context,
    path: sourcePath,
    expectedKind: getSourceKind({ section: targetSection }),
  });

  if (assumedMissingDeletionReverse) {
    await writeStatus({
      context,
      options,
      text: `The next patch would delete the file ${formatPatchStatusTarget({ target, options })},\nwhich does not exist!  Assuming -R.\n`,
      always: false,
    });
  }
  await writeStatus({
    context,
    options,
    text: `${options.dryRun ? 'checking' : 'patching'} file ${formatPatchStatusTarget({ target, options })}\n`,
    always: false,
  });
  if (assumedReverse && !assumedMissingDeletionReverse) {
    await writeStatus({
      context,
      options,
      text: 'Reversed (or previously applied) patch detected!  Assuming -R.\n',
      always: false,
    });
  }
  if (ignoredExplicitReverse) {
    await writeStatus({
      context,
      options,
      text: 'Unreversed patch detected!  Ignoring -R.\n',
      always: false,
    });
  }

  let resultContent: PatchContent;
  let direction: PatchDirection = options.explicitReverse ? 'reverse' : 'forward';
  let rejectedHunks: TextHunk[] = [];
  let rejectionKind: 'failed' | 'ignored' | undefined;
  let usedOffset = false;
  let usedFuzz = false;

  switch (section.kind) {
  case 'text': {
    if (forcedTextStructuralConflict !== undefined) {
      const activeSection = targetSection as TextPatchSection;
      rejectedHunks = activeSection.hunks;
      rejectionKind = 'failed';
      resultContent = {
        kind: 'line-plan',
        source: source.source,
        pieces: [{ kind: 'source', startLine: 0, endLine: source.source.lineCount }],
      };
      for (const [index, hunk] of activeSection.hunks.entries()) {
        await writeStatus({
          context,
          options,
          text: `Hunk #${index + 1} FAILED at ${Math.max(1, hunk.oldRange.start)}.\n`,
          always: options.quietMode !== 'quiet',
        });
      }
    } else {
      const applied = await applyTextSection({
        source: source.source,
        section,
        options: effectiveOptions,
      });
      direction = applied.direction;
      if (direction === 'reverse' && !options.explicitReverse && !assumedReverse) {
        await writeStatus({
          context,
          options,
          text: 'Reversed (or previously applied) patch detected!  Assuming -R.\n',
          always: false,
        });
      }
      rejectedHunks = applied.rejectedHunks;
      rejectionKind = applied.rejectionKind;
      usedOffset = applied.usedOffset;
      usedFuzz = applied.usedFuzz;
      resultContent = {
        kind: 'line-plan',
        source: source.source,
        pieces: applied.pieces,
      };

      for (const diagnostic of applied.diagnostics) {
        await writeStatus({
          context,
          options,
          text: `${diagnostic}\n`,
          always: options.quietMode !== 'quiet'
            && (diagnostic.includes('FAILED') || diagnostic.includes('Skipping')),
        });
      }
    }

    const rejectSection = (() => {
      switch (direction) {
      case 'forward':
        return section;
      case 'reverse':
        return reverseSection({ section }) as TextPatchSection;
      default: {
        const _ex: never = direction;
        throw new Error(`Unhandled patch direction: ${_ex}`);
      }
      }
    })();
    await writeRejects({
      context,
      section: rejectSection,
      target,
      rejectedHunks,
      options,
      initializedRejectPaths,
      effectiveDirectory,
    });
    if (rejectedHunks.length > 0 && rejectionKind !== undefined) {
      await writeRejectSummary({
        context,
        options,
        target,
        rejectedCount: rejectedHunks.length,
        totalCount: section.hunks.length,
        rejectionKind,
      });
    }
    break;
  }
  case 'ed':
    if (options.explicitReverse) throw new Error('ed patches cannot be reversed');
    resultContent = {
      kind: 'line-plan',
      source: source.source,
      pieces: applyEdSection({ source: source.source, section }),
    };
    break;
  default: {
    const _ex: never = section;
    throw new Error(`Unhandled patch section: ${JSON.stringify(_ex)}`);
  }
  }

  const adjustedSection = getDirectionAdjustedSection({ section, direction });
  const outputOnly = options.outputPath !== undefined;
  const exitCode = rejectedHunks.length > 0 ? 1 : 0;
  const resultByteLength = await getPatchContentByteLength({ context, content: resultContent });

  if (!options.dryRun && !outputOnly) {
    const backupTarget = (() => {
      switch (adjustedSection.header.operation) {
      case 'create':
        return { path: target.destinationPath, exists: source.exists };
      case 'copy':
        return { path: target.destinationPath, exists: false };
      case 'modify':
      case 'delete':
      case 'rename':
        return {
          path: target.sourcePath ?? target.destinationPath,
          exists: source.exists,
        };
      default: {
        const _ex: never = adjustedSection.header.operation;
        throw new Error(`Unhandled patch operation: ${_ex}`);
      }
      }
    })();
    const backupNeeded = shouldCreateBackup({
      options,
      usedOffset,
      usedFuzz,
      usedReverse: direction === 'reverse' && !options.explicitReverse,
      rejectedCount: (() => {
        switch (rejectionKind) {
        case 'ignored':
          return 0;
        case 'failed':
        case undefined:
          return rejectedHunks.length;
        default: {
          const _ex: never = rejectionKind;
          throw new Error(`Unhandled patch rejection kind: ${_ex}`);
        }
        }
      })(),
    });
    const backupTargetCanBeBackedUp = backupTarget.exists
      || options.backupAlways
      || forcedTextStructuralConflict === 'delete-source-missing';
    if (backupNeeded && backupTargetCanBeBackedUp && !backedUpPaths.has(backupTarget.path)) {
      await createBackup({
        context,
        targetPath: backupTarget.path,
        targetExists: backupTarget.exists,
        options,
        cwd: effectiveDirectory,
      });
      backedUpPaths.add(backupTarget.path);
    }

    const deleteTarget = shouldDeleteTarget({ section: adjustedSection, resultByteLength, options });
    const destinationKind = getDestinationKind({ section: adjustedSection });
    const destinationMode = getDestinationMode({ section: adjustedSection, sourceMode: source.mode });
    if (forcedTextStructuralConflict !== undefined) {
      return { exitCode, output: resultContent };
    }
    switch (adjustedSection.header.operation) {
    case 'rename':
      if (target.sourcePath === undefined) {
        throw new Error(`cannot determine rename source for '${target.destinationPath}'`);
      }
      if (deleteTarget) {
        throw new Error('rename patch cannot remove its destination as an empty file');
      }
      await installRenamedEntry({
        context,
        sourcePath: target.sourcePath,
        destinationPath: target.destinationPath,
        kind: destinationKind,
        content: resultContent,
        mode: destinationMode,
      });
      break;
    case 'modify':
    case 'create':
    case 'delete':
    case 'copy':
      await installPatchedEntry({
        context,
        targetPath: target.destinationPath,
        kind: destinationKind,
        content: resultContent,
        mode: destinationMode,
        deleteTarget,
      });
      break;
    default: {
      const _ex: never = adjustedSection.header.operation;
      throw new Error(`Unhandled patch operation: ${_ex}`);
    }
    }
  }

  return { exitCode, output: resultContent };
}


async function applyPatchSections({
  context,
  sections,
  operands,
  effectiveDirectory,
  options,
}: {
  context: WeshCommandContext,
  sections: PatchSection[],
  operands: ResolvedPatchOperands,
  effectiveDirectory: string,
  options: PatchOptions,
}): Promise<{ exitCode: 0 | 1, outputs: PatchContent[] }> {
  const initializedRejectPaths = new Set<string>();
  const backedUpPaths = new Set<string>();
  const outputs: PatchContent[] = [];
  let exitCode: 0 | 1 = 0;

  for (const section of sections) {
    try {
      const result = await applySection({
        context,
        section,
        explicitOriginalPath: operands.originalPath,
        effectiveDirectory,
        options,
        initializedRejectPaths,
        backedUpPaths,
      });
      outputs.push(result.output);
      if (result.exitCode !== 0) exitCode = 1;
    } catch (error: unknown) {
      const isMissingTarget = error instanceof PatchTargetResolutionError
        || isPathNotFoundError({ error });
      if (!isMissingTarget) throw error;
      const advice = error instanceof PatchTargetResolutionError || options.stripCount !== undefined
        ? 'Perhaps you used the wrong -p or --strip option?\n'
        : 'Perhaps you should have used the -p or --strip option?\n';
      const oldPath = section.header.oldPath ?? 'unknown';
      const newPath = section.header.newPath ?? oldPath;
      const hunkCount = (() => {
        switch (section.kind) {
        case 'text':
          return section.hunks.length;
        case 'ed':
          return 1;
        default: {
          const _ex: never = section;
          throw new Error(`Unhandled patch section kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
        }
        }
      })();
      const hunkWord = hunkCount === 1 ? 'hunk' : 'hunks';
      const interactiveSuffix = options.batch || options.force
        ? 'No file to patch.  Skipping patch.\n'
        : [
          'File to patch: ',
          'Skip this patch? [y] ',
          'Skipping patch.',
          '',
        ].join('\n');
      await context.text().print({
        text: `can't find file to patch at input line ${section.sourceLineNumber + 2}\n`
          + advice
          + 'The text leading up to this was:\n'
          + '--------------------------\n'
          + `|--- ${oldPath}\n`
          + `|+++ ${newPath}\n`
          + '--------------------------\n'
          + interactiveSuffix
          + `${hunkCount} out of ${hunkCount} ${hunkWord} ignored\n`,
      });
      outputs.push({ kind: 'bytes', bytes: new Uint8Array(0) });
      exitCode = 1;
    }
  }

  return { exitCode, outputs };
}

export const patchCommandImplementation: WeshCommandImplementation = {
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
    let effectiveDirectory = context.cwd;
    try {
      for (const directory of patchDirectoryOperandsBeforeTerminal({ args: context.args })) {
        effectiveDirectory = await resolveEffectiveDirectory({
          context,
          cwd: effectiveDirectory,
          directory,
        });
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `patch: **** ${message}\n` });
      return { exitCode: 2 };
    }

    const parsedArgv = parsePatchArgv({ args: context.args });
    switch (parsedArgv.kind) {
    case 'help':
      await writeCommandHelp({ context, command: 'patch', argvSpec: patchArgvSpec });
      return { exitCode: 0 };
    case 'version':
      await context.text().print({ text: 'Wesh patch 1.0\n' });
      return { exitCode: 0 };
    case 'error':
      await writeCommandUsageError({
        context,
        command: 'patch',
        message: parsedArgv.message,
        argvSpec: patchArgvSpec,
      });
      return { exitCode: 2 };
    case 'ok':
      break;
    default: {
      const _ex: never = parsedArgv;
      throw new Error(`Unhandled patch argv result: ${JSON.stringify(_ex)}`);
    }
    }

    const { options, operands } = parsedArgv;

    if (context.env.has('POSIXLY_CORRECT')) {
      options.posix = true;
    }

    if (!options.backupStyleExplicit) {
      const environmentStyle = context.env.get('VERSION_CONTROL');
      if (environmentStyle !== undefined && environmentStyle.length > 0) {
        const parsedEnvironmentStyle = parsePatchBackupStyle({ value: environmentStyle });
        if (!parsedEnvironmentStyle.ok) {
          await context.text().error({ text: `patch: invalid argument '${environmentStyle}' for '$VERSION_CONTROL'\nValid arguments are:
  - 'none', 'off'
  - 'simple', 'never'
  - 'existing', 'nil'
  - 'numbered', 't'\n` });
          return { exitCode: 2 };
        }
        options.backupStyle = parsedEnvironmentStyle.value;
      }
    }

    if (!options.backupSuffixExplicit) {
      const environmentSuffix = context.env.get('SIMPLE_BACKUP_SUFFIX');
      if (environmentSuffix !== undefined && environmentSuffix.length > 0) {
        options.backupSuffix = environmentSuffix;
      }
    }

    if (options.unsupportedOption !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'patch',
        message: `patch: option '${options.unsupportedOption}' is not supported by Wesh`,
        argvSpec: patchArgvSpec,
      });
      return { exitCode: 2 };
    }
    if (options.safePaths && options.stripCount === undefined && operands.originalPath === undefined) {
      await writeCommandUsageError({
        context,
        command: 'patch',
        message: 'patch: --safe-paths requires an explicit -p/--strip value or an explicit original file operand',
        argvSpec: patchArgvSpec,
      });
      return { exitCode: 2 };
    }

    try {
      const inputBytes = await readPatchInput({
        context,
        path: operands.patchPath,
        cwd: effectiveDirectory,
      });
      const document = parsePatchDocument({
        bytes: inputBytes,
        forcedFormat: options.forcedFormat,
        binary: options.binary,
      });

      if (document.strippedCarriageReturns) {
        await writeStatus({
          context,
          options,
          text: '(Stripping trailing CRs from patch; use --binary to disable.)\n',
          always: false,
        });
      }

      if (options.atomic && !options.dryRun) {
        const preflight = await applyPatchSections({
          context,
          sections: document.sections,
          operands,
          effectiveDirectory,
          options: {
            ...options,
            dryRun: true,
            quietMode: 'quiet',
          },
        });
        if (preflight.exitCode !== 0) {
          return { exitCode: preflight.exitCode };
        }
      }

      const applied = await applyPatchSections({
        context,
        sections: document.sections,
        operands,
        effectiveDirectory,
        options,
      });

      switch (options.quietMode) {
      case 'normal':
      case 'quiet':
        break;
      case 'verbose':
        await context.text().print({ text: 'done\n' });
        break;
      default: {
        const _ex: never = options.quietMode;
        throw new Error(`Unhandled quiet mode: ${_ex}`);
      }
      }

      if (options.outputPath !== undefined && !options.dryRun) {
        await writeOutputContent({
          context,
          path: options.outputPath,
          content: { kind: 'sequence', contents: applied.outputs },
          cwd: effectiveDirectory,
        });
      }

      return { exitCode: applied.exitCode };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await context.text().error({ text: `patch: **** ${message}\n` });
      return { exitCode: 2 };
    }
  },
};

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
