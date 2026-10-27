import { z } from 'zod';
import { exactObject } from '@/utils/exact-object';
import { isModelSourceSegment, parseLocalRepositoryReference } from '@/01-models/llama-cpp-browser-model-id';
import { modelSourceRepositorySchema } from '@/01-models/llama-cpp-browser-model-launch';
import { temporaryModelRootPath, temporaryRootPathSchema } from '@/01-models/temporary-model-files';
import { modelFileSchema, type ModelFile } from '@/logic/model-file-system';
import { modelIdSchema } from '@/features/llama-cpp-browser/types';
import { isProjector } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { parsePublicHostModelReference } from './model-destination-types';
import { parseTemporaryModelReference } from '@/features/llama-cpp-browser/temporary-model-reference';
import { resolveModelFiles } from './model-file-selection';
import type { ModelDirectory, ModelRootLocation, ResolvedModel } from './model-directory';

export const modelRootLocationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('opfs-user'), rootName: z.string().refine(name => isModelSourceSegment({ name }) && !name.startsWith('.')) }).strict(),
  z.object({ kind: z.literal('hugging-face'), repository: modelSourceRepositorySchema }).strict(),
  z.object({ kind: z.literal('host'), directoryId: z.string().min(1).max(255), repository: modelSourceRepositorySchema }).strict(),
  z.object({ kind: z.literal('temp'), rootPath: temporaryRootPathSchema }).strict(),
  z.object({ kind: z.literal('local-files'), rootPath: temporaryRootPathSchema, sourceId: z.string().min(1).max(255), rootName: z.string(), savedRootName: z.string().optional() }).strict(),
]) satisfies z.ZodType<ModelRootLocation>;

function sameEntry({ entry, selected }: { entry: ModelFile, selected: ModelFile }): boolean {
  const { relativePath, file, ...source } = entry;
  const { relativePath: selectedPath, file: selectedFile, ...selectedSource } = selected;
  if (relativePath !== selectedPath || file !== selectedFile || file.name !== selectedFile.name
    || file.size !== selectedFile.size || file.lastModified !== selectedFile.lastModified) {
    return false;
  }
  switch (source.storageKind) {
  case 'opfs': case 'host': {
    const { storageKind, handle, ...unhandledSource } = source;
    unhandledSource satisfies Record<PropertyKey, never>;
    switch (selectedSource.storageKind) {
    case 'opfs': case 'host': {
      const { storageKind: selectedKind, handle: selectedHandle, ...unhandledSelectedSource } = selectedSource;
      unhandledSelectedSource satisfies Record<PropertyKey, never>;
      return storageKind === selectedKind && handle === selectedHandle;
    }
    case 'temp': return false;
    default: {
      const exhaustive: never = selectedSource;
      throw new Error(String(exhaustive));
    }
    }
  }
  case 'temp': {
    const { storageKind, registrationRevision, ...unhandledSource } = source;
    unhandledSource satisfies Record<PropertyKey, never>;
    if (selectedSource.storageKind !== storageKind) {
      return false;
    }
    const { storageKind: _selectedKind, registrationRevision: selectedRevision, ...unhandledSelectedSource } = selectedSource;
    unhandledSelectedSource satisfies Record<PropertyKey, never>;
    return registrationRevision === selectedRevision;
  }
  default: {
    const exhaustive: never = source;
    throw new Error(String(exhaustive));
  }
  }
}

/** Worker transport only: preserve the captured File/handle graph, then select
 * the validated entry from files rather than trusting a second supplied object. */
export const modelDirectorySchema = z.object({
  files: z.array(modelFileSchema).min(1),
  primaryFile: modelFileSchema,
  projectorFile: modelFileSchema.optional(),
}).strict().superRefine((directory, context) => {
  const paths = new Set<string>();
  for (const [index, entry] of directory.files.entries()) {
    const path = entry.relativePath;
    if (!/\.gguf$/i.test(path) || !path.split('/').every(name => isModelSourceSegment({ name })) || paths.has(path)) {
      context.addIssue({ code: 'custom', path: ['files', index, 'relativePath'], message: 'Invalid or duplicate model file path' });
    }
    paths.add(path);
  }
  for (const path of paths) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join('/'))) {
        context.addIssue({ code: 'custom', path: ['files'], message: 'A model file cannot also be a directory' });
      }
      parts.pop();
    }
  }
  if (!directory.files.some(entry => sameEntry({ entry, selected: directory.primaryFile }))) {
    context.addIssue({ code: 'custom', path: ['primaryFile'], message: 'Primary file is not the captured file entry' });
  }
  const projector = directory.projectorFile;
  if (directory.files.filter(entry => isProjector({ path: entry.relativePath })).length > 1) {
    context.addIssue({ code: 'custom', path: ['files'], message: 'Model directory contains an unselected projector' });
  }
  if (projector && !directory.files.some(entry => sameEntry({ entry, selected: projector }))) {
    context.addIssue({ code: 'custom', path: ['projectorFile'], message: 'Projector file is not the captured file entry' });
  }
  try {
    const expected = resolveModelFiles({ files: directory.files });
    if (expected.primaryRelativePath !== directory.primaryFile.relativePath || expected.projectorRelativePath !== projector?.relativePath) {
      context.addIssue({ code: 'custom', message: 'Resolved model file selection does not match the captured directory' });
    }
  } catch {
    context.addIssue({ code: 'custom', path: ['files'], message: 'Model file group is incomplete or ambiguous' });
  }
}).transform(({ files, primaryFile, projectorFile, ...unhandledDirectory }) => {
  unhandledDirectory satisfies Record<PropertyKey, never>;
  return exactObject<ModelDirectory>()({
    files,
    primaryFile: files.find(entry => entry.relativePath === primaryFile.relativePath)!,
    projectorFile: files.find(entry => entry.relativePath === projectorFile?.relativePath),
  });
}) satisfies z.ZodType<ModelDirectory>;

export const resolvedModelSchema = z.object({
  modelId: modelIdSchema,
  location: modelRootLocationSchema,
  directory: modelDirectorySchema,
}).strict().superRefine((resolved, context) => {
  const location = resolved.location;
  let matchesLocation = false;
  try {
    switch (location.kind) {
    case 'opfs-user': {
      const reference = parseLocalRepositoryReference({ modelId: resolved.modelId });
      matchesLocation = reference.storage === 'saved' && reference.rootName === location.rootName;
      break;
    }
    case 'hugging-face': matchesLocation = resolved.modelId.startsWith(`hf.co/${location.repository}:`);
      break;
    case 'host': matchesLocation = parsePublicHostModelReference({ modelId: resolved.modelId }).repository === location.repository;
      break;
    case 'temp': matchesLocation = temporaryModelRootPath({ rootName: parseTemporaryModelReference({ modelId: resolved.modelId }).rootName }) === location.rootPath;
      break;
    case 'local-files': {
      const reference = parseLocalRepositoryReference({ modelId: resolved.modelId });
      switch (reference.storage) {
      case 'pending': matchesLocation = reference.rootName === location.rootName;
        break;
      case 'saved': matchesLocation = reference.rootName === location.savedRootName;
        break;
      default: {
        const exhaustive: never = reference.storage;
        throw new Error(String(exhaustive));
      }
      }
      break;
    }
    default: {
      const exhaustive: never = location;
      throw new Error(String(exhaustive));
    }
    }
  } catch { /* Invalid source-specific references are rejected below. */ }
  if (!matchesLocation) {
    context.addIssue({ code: 'custom', path: ['location'], message: 'Model root location does not match modelId' });
  }
  const kind = location.kind;
  let storageKind: ModelFile['storageKind'];
  switch (kind) {
  case 'opfs-user': case 'hugging-face': storageKind = 'opfs';
    break;
  case 'host': storageKind = 'host';
    break;
  case 'temp': case 'local-files': storageKind = 'temp';
    break;
  default: {
    const exhaustive: never = kind;
    throw new Error(String(exhaustive));
  }
  }
  if (resolved.directory.files.some(entry => entry.storageKind !== storageKind)) {
    context.addIssue({ code: 'custom', path: ['directory', 'files'], message: 'Model file source does not match its root location' });
  }
  const temporaryFiles = resolved.directory.files.filter(entry => entry.storageKind === 'temp');
  if (new Set(temporaryFiles.map(entry => entry.registrationRevision)).size > 1) {
    context.addIssue({ code: 'custom', path: ['directory', 'files'], message: 'Temporary files belong to different registrations' });
  }
}) satisfies z.ZodType<ResolvedModel>;

export const TEST_ONLY = {
};
