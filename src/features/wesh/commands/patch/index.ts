import type { WeshCommandContext, WeshCommandDefinition, WeshCommandResult } from '@/features/wesh/types';
import { writeCommandHelp, writeCommandUsageError } from '@/features/wesh/commands/_shared/usage';
import { resolvePath } from '@/features/wesh/path';
import { parsePatchArgv, patchArgvSpec } from './argv';
import {
  applyEdSection,
  applyTextSection,
  reverseSection,
  serializeContextReject,
  serializeUnifiedReject,
} from './engine';
import {
  appendFileBytes,
  createBackup,
  getPatchContentByteLength,
  installPatchedEntry,
  pathExists,
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


function concatByteChunks({ chunks }: { chunks: Uint8Array[] }): Uint8Array {
  let byteLength = 0;
  for (const chunk of chunks) {
    byteLength += chunk.byteLength;
    if (!Number.isSafeInteger(byteLength)) throw new Error('reject output is too large');
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

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
}: {
  options: PatchOptions,
  usedOffset: boolean,
  usedFuzz: boolean,
  rejectedCount: number,
}): boolean {
  switch (options.backupMode) {
  case 'always':
    return true;
  case 'never':
    return false;
  case 'if-mismatch':
    return !options.posix && (usedOffset || usedFuzz || rejectedCount > 0);
  default: {
    const _ex: never = options.backupMode;
    throw new Error(`Unhandled backup mode: ${_ex}`);
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
  if (options.outputPath === '-' || options.rejectPath === '-') {
    await context.text().error({ text });
  } else {
    await context.text().print({ text });
  }
}

function rejectBytesForHunk({
  section,
  hunk,
  target,
  options,
}: {
  section: TextPatchSection,
  hunk: TextHunk,
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
    return serializeUnifiedReject({ hunk, oldPath, newPath });
  case 'context':
    return serializeContextReject({ hunk, oldPath, newPath });
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

  const chunks = rejectedHunks.map((hunk) => rejectBytesForHunk({ section, hunk, target, options }));
  const bytes = concatByteChunks({ chunks });
  const rawPath = options.rejectPath ?? `${target.destinationPath}.rej`;
  if (rawPath === '-') {
    await writeOutputContent({
      context,
      path: '-',
      content: { kind: 'bytes', bytes },
      cwd: effectiveDirectory,
    });
    return;
  }

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
}: {
  context: WeshCommandContext,
  target: PatchTarget,
}): Promise<void> {
  if (target.sourcePath === target.destinationPath) return;
  switch (target.operation) {
  case 'create':
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

async function isStructurallyReversed({
  context,
  section,
  target,
}: {
  context: WeshCommandContext,
  section: PatchSection,
  target: PatchTarget,
}): Promise<boolean> {
  switch (section.header.operation) {
  case 'create':
    return await pathExists({ context, path: target.destinationPath });
  case 'delete':
    return target.sourcePath !== undefined
      && !await pathExists({ context, path: target.sourcePath });
  case 'rename': {
    if (target.sourcePath === undefined) return false;
    const sourceExists = await pathExists({ context, path: target.sourcePath });
    const destinationExists = await pathExists({ context, path: target.destinationPath });
    return !sourceExists && destinationExists;
  }
  case 'modify':
  case 'copy':
    return false;
  default: {
    const _ex: never = section.header.operation;
    throw new Error(`Unhandled patch operation: ${_ex}`);
  }
  }
}

function structuralReverseAction({
  options,
}: {
  options: PatchOptions,
}): 'apply-reverse' | 'skip-reversed' | 'apply-forward' {
  switch (options.directionMode) {
  case 'reverse':
    return 'apply-reverse';
  case 'forward-only':
    return 'skip-reversed';
  case 'auto':
    break;
  default: {
    const _ex: never = options.directionMode;
    throw new Error(`Unhandled direction mode: ${_ex}`);
  }
  }

  switch (options.reverseDecisionMode) {
  case 'assume-reverse':
    return 'apply-reverse';
  case 'safe-skip':
    return 'skip-reversed';
  case 'force-forward':
    return 'apply-forward';
  default: {
    const _ex: never = options.reverseDecisionMode;
    throw new Error(`Unhandled reverse decision mode: ${_ex}`);
  }
  }
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
  let targetSection = (() => {
    switch (options.directionMode) {
    case 'reverse':
      return reverseSection({ section });
    case 'auto':
    case 'forward-only':
      return section;
    default: {
      const _ex: never = options.directionMode;
      throw new Error(`Unhandled direction mode: ${_ex}`);
    }
    }
  })();

  let target = await resolvePatchTarget({
    context,
    section: targetSection,
    explicitOriginalPath,
    effectiveDirectory,
    stripCount: options.stripCount,
  });

  if (options.directionMode !== 'reverse' && await isStructurallyReversed({
    context,
    section,
    target,
  })) {
    const action = structuralReverseAction({ options });
    switch (action) {
    case 'apply-forward':
      break;
    case 'apply-reverse':
    case 'skip-reversed': {
      targetSection = reverseSection({ section });
      target = await resolvePatchTarget({
        context,
        section: targetSection,
        explicitOriginalPath,
        effectiveDirectory,
        stripCount: options.stripCount,
      });
      switch (action) {
      case 'skip-reversed': {
        await writeStatus({
          context,
          options,
          text: `patching file ${target.displayPath}\n`,
          always: false,
        });
        await writeStatus({
          context,
          options,
          text: 'Reversed (or previously applied) patch detected!  Skipping patch.\n',
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
      case 'apply-reverse':
        effectiveOptions = { ...options, directionMode: 'reverse' };
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

  assertSupportedModeChange({ section: targetSection });
  await assertDestinationAvailable({ context, target });

  await writeStatus({
    context,
    options,
    text: `patching file ${target.displayPath}\n`,
    always: false,
  });

  const sourcePath = target.sourcePath;
  const source = await readPatchSource({
    context,
    path: sourcePath,
    expectedKind: getSourceKind({ section: targetSection }),
  });

  let resultContent: PatchContent;
  let direction: PatchDirection;
  switch (options.directionMode) {
  case 'reverse':
    direction = 'reverse';
    break;
  case 'auto':
  case 'forward-only':
    direction = 'forward';
    break;
  default: {
    const _ex: never = options.directionMode;
    throw new Error(`Unhandled direction mode: ${_ex}`);
  }
  }
  let rejectedHunks: TextHunk[] = [];
  let usedOffset = false;
  let usedFuzz = false;

  switch (section.kind) {
  case 'text': {
    const applied = await applyTextSection({
      source: source.source,
      section,
      options: effectiveOptions,
    });
    direction = applied.direction;
    rejectedHunks = applied.rejectedHunks;
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
        always: diagnostic.includes('FAILED') || diagnostic.includes('Skipping'),
      });
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
    break;
  }
  case 'ed':
    switch (options.directionMode) {
    case 'reverse':
      throw new Error('ed patches cannot be reversed');
    case 'auto':
    case 'forward-only':
      break;
    default: {
      const _ex: never = options.directionMode;
      throw new Error(`Unhandled direction mode: ${_ex}`);
    }
    }
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
      rejectedCount: rejectedHunks.length,
    });
    if (backupNeeded && !backedUpPaths.has(backupTarget.path)) {
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
  }

  return { exitCode, outputs };
}

export const patchCommandDefinition: WeshCommandDefinition = {
  meta: {
    name: 'patch',
    description: 'Apply a diff file to original files',
    usage: 'patch [OPTION]... [ORIGFILE [PATCHFILE]]',
  },
  fn: async ({ context }: { context: WeshCommandContext }): Promise<WeshCommandResult> => {
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
    if (options.unsupportedOption !== undefined) {
      await writeCommandUsageError({
        context,
        command: 'patch',
        message: `patch: option '${options.unsupportedOption}' is not supported by Wesh`,
        argvSpec: patchArgvSpec,
      });
      return { exitCode: 2 };
    }
    if (options.ifdefName !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(options.ifdefName)) {
      await writeCommandUsageError({
        context,
        command: 'patch',
        message: `patch: invalid preprocessor name '${options.ifdefName}'`,
        argvSpec: patchArgvSpec,
      });
      return { exitCode: 2 };
    }
    if (options.outputPath === '-' && options.rejectPath === '-') {
      await writeCommandUsageError({
        context,
        command: 'patch',
        message: 'patch: standard output cannot be used for both patched output and rejects',
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
      const effectiveDirectory = await resolveEffectiveDirectory({ context, directory: options.directory });
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
