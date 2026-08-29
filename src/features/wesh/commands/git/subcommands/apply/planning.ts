import { normalizePath } from '@/features/wesh/path';
import type { WeshCommandContext } from '@/features/wesh/types';
import { applyTextSection, reverseSection } from '@/features/wesh/commands/git/subcommands/apply/patch/engine';
import { materializePatchContent } from '@/features/wesh/commands/git/subcommands/apply/patch/filesystem';
import { createPatchLineSourceFromBytes } from '@/features/wesh/commands/git/subcommands/apply/patch/source';
import type { PatchOptions, TextPatchSection } from '@/features/wesh/commands/git/subcommands/apply/patch/types';
import type { GitIndexEntry } from '@/features/wesh/commands/git/index-file';
import { readIndex } from '@/features/wesh/commands/git/index-file';
import { cleanWorktreeBytes, loadWorktreeAttributes } from '@/features/wesh/commands/git/attributes';
import { readWorktreeContentConfig } from '@/features/wesh/commands/git/config';
import { readObject, writeObject } from '@/features/wesh/commands/git/objects';
import { relativeToWorktree } from '@/features/wesh/commands/git/repository';
import type { GitRepository } from '@/features/wesh/commands/git/repository';
import { hashWorktreeEntry, readWorktreeContent, worktreeAbsolutePath } from '@/features/wesh/commands/git/worktree';
import { pathExists } from '@/features/wesh/commands/git/files';

interface PlannedIndexEntry {
  path: string,
  mode: number,
  bytes: Uint8Array,
}

type PlannedIndexChange =
  | { kind: 'write', entry: PlannedIndexEntry }
  | { kind: 'delete', path: string };

const PATCH_OPTIONS: PatchOptions = {
  stripCount: undefined,
  fuzz: 0,
  whitespaceMode: 'exact',
  forcedFormat: undefined,
  explicitReverse: false,
  forwardOnly: true,
  batch: true,
  force: false,
  inputPath: undefined,
  outputPath: undefined,
  rejectPath: undefined,
  backupAlways: false,
  backupMismatchMode: 'disabled',
  backupPrefix: undefined,
  backupBasenamePrefix: undefined,
  backupSuffix: '.orig',
  backupSuffixExplicit: false,
  backupStyle: 'simple',
  backupStyleExplicit: false,
  removeEmptyFiles: false,
  ifdefName: undefined,
  quietMode: 'quiet',
  dryRun: false,
  atomic: true,
  safePaths: true,
  posix: true,
  binary: false,
  rejectFormat: undefined,
  getMode: undefined,
  unsupportedOption: undefined,
};

function stripGitDiffPrefix({ path }: { path: string }): string {
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

function repositoryPatchPath({ repository, path, prefixMode }: {
  repository: GitRepository,
  path: string,
  prefixMode: 'git-diff' | 'literal',
}): string {
  const normalizedPath = (() => {
    switch (prefixMode) {
    case 'git-diff': return stripGitDiffPrefix({ path });
    case 'literal': return path;
    default: {
      const _ex: never = prefixMode;
      throw new Error(`Unhandled patch path prefix mode: ${_ex}`);
    }
    }
  })();
  if (normalizedPath.length === 0 || normalizedPath === '/dev/null' || normalizedPath.includes('\0')) {
    throw new Error(`invalid patch path: ${path}`);
  }
  const absolutePath = normalizePath({ cwd: repository.worktreePath, path: normalizedPath });
  const relative = relativeToWorktree({ repository, absolutePath });
  if (relative.length === 0 || relative === '.git' || relative.startsWith('.git/')) {
    throw new Error(`invalid patch path: ${path}`);
  }
  return relative;
}

interface ApplySectionPaths {
  sourcePath: string | undefined,
  destinationPath: string | undefined,
}

function sectionPaths({ repository, section }: {
  repository: GitRepository,
  section: TextPatchSection,
}): ApplySectionPaths {
  const header = section.header;
  switch (header.operation) {
  case 'create': {
    const path = header.newPath;
    if (path === undefined || path === '/dev/null') throw new Error('create patch is missing its destination path');
    return {
      sourcePath: undefined,
      destinationPath: repositoryPatchPath({ repository, path, prefixMode: 'git-diff' }),
    };
  }
  case 'delete': {
    const path = header.oldPath;
    if (path === undefined || path === '/dev/null') throw new Error('delete patch is missing its source path');
    return {
      sourcePath: repositoryPatchPath({ repository, path, prefixMode: 'git-diff' }),
      destinationPath: undefined,
    };
  }
  case 'modify': {
    const oldPath = header.oldPath;
    const newPath = header.newPath;
    if (oldPath === undefined || newPath === undefined || oldPath === '/dev/null' || newPath === '/dev/null') {
      throw new Error('modify patch is missing a pathname');
    }
    return {
      sourcePath: repositoryPatchPath({ repository, path: oldPath, prefixMode: 'git-diff' }),
      destinationPath: repositoryPatchPath({ repository, path: newPath, prefixMode: 'git-diff' }),
    };
  }
  case 'rename': {
    if (header.renameFrom === undefined || header.renameTo === undefined) {
      throw new Error('rename patch is missing a pathname');
    }
    return {
      sourcePath: repositoryPatchPath({ repository, path: header.renameFrom, prefixMode: 'literal' }),
      destinationPath: repositoryPatchPath({ repository, path: header.renameTo, prefixMode: 'literal' }),
    };
  }
  case 'copy': {
    if (header.copyFrom === undefined || header.copyTo === undefined) throw new Error('copy patch is missing a pathname');
    return {
      sourcePath: repositoryPatchPath({ repository, path: header.copyFrom, prefixMode: 'literal' }),
      destinationPath: repositoryPatchPath({ repository, path: header.copyTo, prefixMode: 'literal' }),
    };
  }
  default: {
    const _ex: never = header.operation;
    throw new Error(`Unhandled patch operation: ${_ex}`);
  }
  }
}

function singleStageZeroIndex({ entries }: { entries: readonly GitIndexEntry[] }): Map<string, GitIndexEntry> {
  const result = new Map<string, GitIndexEntry>();
  for (const entry of entries) {
    if (entry.stage !== 0) throw new Error('git apply with unmerged index entries is not supported yet');
    result.set(entry.path, entry);
  }
  return result;
}

async function readIndexBlob({ context, repository, entry }: {
  context: WeshCommandContext,
  repository: GitRepository,
  entry: GitIndexEntry,
}): Promise<Uint8Array> {
  const object = await readObject({ files: context.files, repository, objectId: entry.objectId });
  switch (object.type) {
  case 'blob':
    return object.body;
  case 'tree':
  case 'commit':
  case 'tag':
    throw new Error(`index path ${entry.path} does not reference a blob`);
  default: {
    const _ex: never = object.type;
    throw new Error(`Unhandled object type: ${_ex}`);
  }
  }
}

async function applySectionBytes({ context, section, sourceBytes }: {
  context: WeshCommandContext,
  section: TextPatchSection,
  sourceBytes: Uint8Array,
}): Promise<Uint8Array> {
  const source = await createPatchLineSourceFromBytes({ bytes: sourceBytes });
  const applied = await applyTextSection({ source, section, options: PATCH_OPTIONS });
  if (applied.rejectedHunks.length > 0) {
    throw new Error(`patch does not apply: ${section.header.newPath ?? section.header.oldPath ?? 'unknown path'}`);
  }
  return materializePatchContent({
    context,
    content: { kind: 'line-plan', source, pieces: applied.pieces },
  });
}

function resultingMode({ section, existingMode }: {
  section: TextPatchSection,
  existingMode: number | undefined,
}): number {
  if (section.header.newMode === undefined) return existingMode ?? 0o100644;
  switch (section.header.newKind) {
  case 'regular':
    return (section.header.newMode & 0o111) === 0 ? 0o100644 : 0o100755;
  case 'symlink':
    return 0o120000;
  default: {
    const _ex: never = section.header.newKind;
    throw new Error(`Unhandled patch file kind: ${_ex}`);
  }
  }
}

interface IndexPatchState {
  exists: boolean,
  bytes: Uint8Array,
  mode: number | undefined,
}

interface PlannedApplyChanges {
  changes: PlannedIndexChange[],
  originalEntries: GitIndexEntry[],
  validationPaths: Set<string>,
  worktreeAbsentPaths: Set<string>,
}

export async function planIndexChanges({ context, repository, sections, reverse }: {
  context: WeshCommandContext,
  repository: GitRepository,
  sections: readonly TextPatchSection[],
  reverse: boolean,
}): Promise<PlannedApplyChanges> {
  const originalEntries = await readIndex({ files: context.files, repository });
  const index = singleStageZeroIndex({ entries: originalEntries });
  const states = new Map<string, IndexPatchState>();
  const changes: PlannedIndexChange[] = [];
  const validationPaths = new Set<string>();
  const worktreeAbsentPaths = new Set<string>();

  const readState = async ({ path }: { path: string }): Promise<IndexPatchState> => {
    const cached = states.get(path);
    if (cached !== undefined) return cached;
    const entry = index.get(path);
    if (entry === undefined) {
      const missing = { exists: false, bytes: new Uint8Array(), mode: undefined };
      states.set(path, missing);
      return missing;
    }
    const state = {
      exists: true,
      bytes: await readIndexBlob({ context, repository, entry }),
      mode: entry.mode,
    };
    states.set(path, state);
    return state;
  };

  for (const rawSection of sections) {
    const reversed = reverse ? reverseSection({ section: rawSection }) : rawSection;
    switch (reversed.kind) {
    case 'text':
      break;
    case 'ed':
      throw new Error('ed patches are not supported by git apply');
    default: {
      const _ex: never = reversed;
      throw new Error(`Unhandled patch section kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
    const section = reversed;
    switch (section.format) {
    case 'unified':
      break;
    case 'context':
    case 'normal':
      throw new Error(`git apply ${section.format} patches are not supported yet`);
    default: {
      const _ex: never = section.format;
      throw new Error(`Unhandled patch format: ${_ex}`);
    }
    }
    if (section.header.gitBinary) throw new Error('git binary patches are not supported yet');

    const { sourcePath, destinationPath } = sectionPaths({ repository, section });
    const sourceState = sourcePath === undefined ? undefined : await readState({ path: sourcePath });
    const destinationState = destinationPath === undefined
      ? undefined
      : destinationPath === sourcePath
        ? sourceState
        : await readState({ path: destinationPath });
    switch (section.header.operation) {
    case 'create': {
      if (destinationPath === undefined || destinationState === undefined) throw new Error('create patch is missing its destination path');
      validationPaths.add(destinationPath);
      worktreeAbsentPaths.add(destinationPath);
      if (destinationState.exists) throw new Error(`${destinationPath}: already exists in index`);
      const outputBytes = await applySectionBytes({ context, section, sourceBytes: new Uint8Array() });
      const mode = resultingMode({ section, existingMode: undefined });
      states.set(destinationPath, { exists: true, bytes: outputBytes, mode });
      changes.push({ kind: 'write', entry: { path: destinationPath, mode, bytes: outputBytes } });
      break;
    }
    case 'delete': {
      if (sourcePath === undefined || sourceState === undefined) throw new Error('delete patch is missing its source path');
      validationPaths.add(sourcePath);
      if (!sourceState.exists) throw new Error(`${sourcePath}: does not exist in index`);
      await applySectionBytes({ context, section, sourceBytes: sourceState.bytes });
      states.set(sourcePath, { exists: false, bytes: new Uint8Array(), mode: undefined });
      changes.push({ kind: 'delete', path: sourcePath });
      break;
    }
    case 'modify':
    case 'rename': {
      if (sourcePath === undefined || destinationPath === undefined || sourceState === undefined || destinationState === undefined) {
        throw new Error(`${section.header.operation} patch is missing a pathname`);
      }
      validationPaths.add(sourcePath);
      if (section.header.operation === 'rename' && destinationPath !== sourcePath) {
        validationPaths.add(destinationPath);
        worktreeAbsentPaths.add(destinationPath);
      }
      if (!sourceState.exists) throw new Error(`${sourcePath}: does not exist in index`);
      if (destinationPath !== sourcePath && destinationState.exists) throw new Error(`${destinationPath}: already exists in index`);
      const outputBytes = await applySectionBytes({ context, section, sourceBytes: sourceState.bytes });
      const mode = resultingMode({ section, existingMode: sourceState.mode });
      if (destinationPath !== sourcePath) {
        states.set(sourcePath, { exists: false, bytes: new Uint8Array(), mode: undefined });
        changes.push({ kind: 'delete', path: sourcePath });
      }
      states.set(destinationPath, { exists: true, bytes: outputBytes, mode });
      changes.push({ kind: 'write', entry: { path: destinationPath, mode, bytes: outputBytes } });
      break;
    }
    case 'copy': {
      if (sourcePath === undefined || destinationPath === undefined || sourceState === undefined || destinationState === undefined) {
        throw new Error('copy patch is missing a pathname');
      }
      validationPaths.add(sourcePath);
      validationPaths.add(destinationPath);
      worktreeAbsentPaths.add(destinationPath);
      if (!sourceState.exists) throw new Error(`${sourcePath}: does not exist in index`);
      if (destinationState.exists) throw new Error(`${destinationPath}: already exists in index`);
      const outputBytes = await applySectionBytes({ context, section, sourceBytes: sourceState.bytes });
      const mode = resultingMode({ section, existingMode: sourceState.mode });
      states.set(destinationPath, { exists: true, bytes: outputBytes, mode });
      changes.push({ kind: 'write', entry: { path: destinationPath, mode, bytes: outputBytes } });
      break;
    }
    default: {
      const _ex: never = section.header.operation;
      throw new Error(`Unhandled patch operation: ${_ex}`);
    }
    }
  }
  return { changes, originalEntries, validationPaths, worktreeAbsentPaths };
}

interface WorktreePatchState {
  exists: boolean,
  bytes: Uint8Array,
  mode: number | undefined,
}

export async function planWorktreeChanges({ context, repository, sections, reverse }: {
  context: WeshCommandContext,
  repository: GitRepository,
  sections: readonly TextPatchSection[],
  reverse: boolean,
}): Promise<PlannedApplyChanges> {
  const originalEntries = await readIndex({ files: context.files, repository });
  const indexByPath = singleStageZeroIndex({ entries: originalEntries });
  const attributes = await loadWorktreeAttributes({ files: context.files, repository, contentConfig: await readWorktreeContentConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env }) });
  const states = new Map<string, WorktreePatchState>();
  const changes: PlannedIndexChange[] = [];
  const validationPaths = new Set<string>();
  const worktreeAbsentPaths = new Set<string>();

  const readState = async ({ path }: { path: string }): Promise<WorktreePatchState> => {
    const cached = states.get(path);
    if (cached !== undefined) return cached;
    const absolutePath = worktreeAbsolutePath({ repository, path });
    if (!await pathExists({ files: context.files, path: absolutePath })) {
      const missing = { exists: false, bytes: new Uint8Array(), mode: undefined };
      states.set(path, missing);
      return missing;
    }
    const indexEntry = indexByPath.get(path);
    const stat = await context.files.lstat({ path: absolutePath });
    const content = await readWorktreeContent({
      files: context.files,
      absolutePath,
      type: stat.type,
      regularFileMode: indexEntry?.mode === 0o100755 ? 0o100755 : 0o100644,
    });
    const bytes = content.mode === 0o100644 || content.mode === 0o100755
      ? await cleanWorktreeBytes({ attributes, files: context.files, repository, path, bytes: content.bytes, indexObjectId: indexEntry?.objectId })
      : content.bytes;
    const state = { exists: true, bytes, mode: content.mode };
    states.set(path, state);
    return state;
  };

  for (const rawSection of sections) {
    const reversed = reverse ? reverseSection({ section: rawSection }) : rawSection;
    switch (reversed.kind) {
    case 'text':
      break;
    case 'ed':
      throw new Error('ed patches are not supported by git apply');
    default: {
      const _ex: never = reversed;
      throw new Error(`Unhandled patch section kind: ${((_ex satisfies never) as { readonly kind: string }).kind}`);
    }
    }
    const section = reversed;
    switch (section.format) {
    case 'unified':
      break;
    case 'context':
    case 'normal':
      throw new Error(`git apply ${section.format} patches are not supported yet`);
    default: {
      const _ex: never = section.format;
      throw new Error(`Unhandled patch format: ${_ex}`);
    }
    }
    if (section.header.gitBinary) throw new Error('git binary patches are not supported yet');

    const { sourcePath, destinationPath } = sectionPaths({ repository, section });
    const sourceState = sourcePath === undefined ? undefined : await readState({ path: sourcePath });
    const destinationState = destinationPath === undefined
      ? undefined
      : destinationPath === sourcePath
        ? sourceState
        : await readState({ path: destinationPath });
    if (sourcePath !== undefined) validationPaths.add(sourcePath);
    if (destinationPath !== undefined) validationPaths.add(destinationPath);

    switch (section.header.operation) {
    case 'create': {
      if (destinationPath === undefined || destinationState === undefined) throw new Error('create patch is missing its destination path');
      if (destinationState.exists) throw new Error(`${destinationPath}: already exists in working directory`);
      const outputBytes = await applySectionBytes({ context, section, sourceBytes: new Uint8Array() });
      const mode = resultingMode({ section, existingMode: undefined });
      states.set(destinationPath, { exists: true, bytes: outputBytes, mode });
      changes.push({ kind: 'write', entry: { path: destinationPath, mode, bytes: outputBytes } });
      break;
    }
    case 'delete': {
      if (sourcePath === undefined || sourceState === undefined) throw new Error('delete patch is missing its source path');
      if (!sourceState.exists) throw new Error(`${sourcePath}: No such file or directory`);
      await applySectionBytes({ context, section, sourceBytes: sourceState.bytes });
      states.set(sourcePath, { exists: false, bytes: new Uint8Array(), mode: undefined });
      changes.push({ kind: 'delete', path: sourcePath });
      break;
    }
    case 'modify':
    case 'rename': {
      if (sourcePath === undefined || destinationPath === undefined || sourceState === undefined || destinationState === undefined) {
        throw new Error(`${section.header.operation} patch is missing a pathname`);
      }
      if (!sourceState.exists) throw new Error(`${sourcePath}: No such file or directory`);
      if (destinationPath !== sourcePath && destinationState.exists) {
        throw new Error(`${destinationPath}: already exists in working directory`);
      }
      const outputBytes = await applySectionBytes({ context, section, sourceBytes: sourceState.bytes });
      const mode = resultingMode({ section, existingMode: sourceState.mode });
      if (destinationPath !== sourcePath) {
        states.set(sourcePath, { exists: false, bytes: new Uint8Array(), mode: undefined });
        changes.push({ kind: 'delete', path: sourcePath });
      }
      states.set(destinationPath, { exists: true, bytes: outputBytes, mode });
      changes.push({ kind: 'write', entry: { path: destinationPath, mode, bytes: outputBytes } });
      break;
    }
    case 'copy': {
      if (sourcePath === undefined || destinationPath === undefined || sourceState === undefined || destinationState === undefined) {
        throw new Error('copy patch is missing a pathname');
      }
      if (!sourceState.exists) throw new Error(`${sourcePath}: No such file or directory`);
      if (destinationState.exists) throw new Error(`${destinationPath}: already exists in working directory`);
      const outputBytes = await applySectionBytes({ context, section, sourceBytes: sourceState.bytes });
      const mode = resultingMode({ section, existingMode: sourceState.mode });
      states.set(destinationPath, { exists: true, bytes: outputBytes, mode });
      changes.push({ kind: 'write', entry: { path: destinationPath, mode, bytes: outputBytes } });
      break;
    }
    default: {
      const _ex: never = section.header.operation;
      throw new Error(`Unhandled patch operation: ${_ex}`);
    }
    }
  }
  return { changes, originalEntries, validationPaths, worktreeAbsentPaths };
}

function regularFileMode({ entry }: { entry: GitIndexEntry }): 0o100644 | 0o100755 | undefined {
  switch (entry.mode) {
  case 0o100644:
  case 0o100755:
    return entry.mode;
  case 0o120000:
  case 0o160000:
    return undefined;
  default:
    throw new Error(`unsupported index mode ${entry.mode.toString(8)}: ${entry.path}`);
  }
}

export async function validateIndexMatchesWorktree({
  context,
  repository,
  originalEntries,
  validationPaths,
  worktreeAbsentPaths,
}: {
  context: WeshCommandContext,
  repository: GitRepository,
  originalEntries: readonly GitIndexEntry[],
  validationPaths: ReadonlySet<string>,
  worktreeAbsentPaths: ReadonlySet<string>,
}): Promise<void> {
  const originalByPath = new Map(originalEntries.map(entry => [entry.path, entry]));
  const attributes = await loadWorktreeAttributes({ files: context.files, repository, contentConfig: await readWorktreeContentConfig({ files: context.files, repository, homePath: context.env.get('HOME') ?? '/', cwd: context.cwd, env: context.env }) });
  for (const path of validationPaths) {
    const existing = originalByPath.get(path);
    const absolutePath = worktreeAbsolutePath({ repository, path });
    const exists = await pathExists({ files: context.files, path: absolutePath });
    if (existing === undefined) {
      if (exists) {
        if (worktreeAbsentPaths.has(path)) throw new Error(`${path}: already exists in working directory`);
        throw new Error(`${path}: does not match index`);
      }
      continue;
    }
    if (!exists) throw new Error(`${path}: does not match index`);
    const worktreeEntry = await hashWorktreeEntry({
      files: context.files,
      repository,
      path,
      write: false,
      regularFileMode: regularFileMode({ entry: existing }),
      attributes,
      indexObjectId: existing.objectId,
    });
    if (worktreeEntry.objectId !== existing.objectId || worktreeEntry.mode !== existing.mode) {
      throw new Error(`${path}: does not match index`);
    }
  }
}

export async function writePlannedObjects({ context, repository, plan }: {
  context: WeshCommandContext,
  repository: GitRepository,
  plan: { changes: PlannedIndexChange[], originalEntries: GitIndexEntry[] },
}): Promise<{ entries: GitIndexEntry[], touchedPaths: Set<string> }> {
  const resultByPath = new Map(plan.originalEntries.map(entry => [entry.path, entry]));
  const touchedPaths = new Set<string>();
  for (const change of plan.changes) {
    switch (change.kind) {
    case 'delete':
      touchedPaths.add(change.path);
      resultByPath.delete(change.path);
      break;
    case 'write': {
      touchedPaths.add(change.entry.path);
      const objectId = await writeObject({
        files: context.files,
        repository,
        type: 'blob',
        body: change.entry.bytes,
      });
      resultByPath.set(change.entry.path, {
        path: change.entry.path,
        objectId,
        mode: change.entry.mode,
        size: change.entry.bytes.byteLength,
        stage: 0,
      });
      break;
    }
    default: {
      const _ex: never = change;
      throw new Error(`Unhandled planned index change: ${JSON.stringify(_ex)}`);
    }
    }
  }
  return { entries: [...resultByPath.values()], touchedPaths };
}


export const TEST_ONLY = {
};
