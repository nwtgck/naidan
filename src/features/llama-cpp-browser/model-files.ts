import { storageService } from '@/00-storage/service';
import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { temporaryModels } from './runtime/temporary-model-store';
import { directoryForModelFile } from './runtime/model-directory-input';
import { describeDirectory, existingUserModelDirectory, importCapturedModelDirectory, resolveDirectory, type CapturedModelImport, type ResolvedModel } from './runtime/model-directory';
import { resolveModel } from './runtime/model-resolution';
import { listStoredModels, removeStoredModel } from './runtime/model-store';
import { listHostStoredModels, recordOpfsInventoryIssue } from './runtime/host-model-store';
import { modelMutationLockName, withModelMutationLock } from './runtime/model-mutation-lock';
import { parseTemporaryModelReference } from './temporary-model-reference';
import type { DeletionPlan, DeletionResult } from './runtime/deletion-plan';
import { LlamaCppBrowserError, modelDirectoryInputSchema, modelsSchema, type LocalModel, type ModelDirectoryInput, type Progress } from './types';

export type ModelImportReceipt = Readonly<{
  storage: 'temp' | 'opfs',
  models: readonly LocalModel[],
  publication: Readonly<{ generation: number, isCurrent({ modelId }: { modelId: string }): boolean }>,
}>;
export type TemporaryModelSource = Readonly<{
  model: LocalModel, rootPath: string, registrationRevision: number, isCurrent(): boolean,
}>;
export type SavedTemporaryModel = Readonly<{ model: LocalModel, receipt: ModelImportReceipt }>;

const modelListeners = new Set<() => void>();
const importListeners = new Set<({ receipt }: { receipt: ModelImportReceipt }) => void>();
const publications = new Map<string, number>();
const replay = new Map<string, ModelImportReceipt>();
const storedPublicationCaptures = new Map<string, { captured: CapturedModelImport, receipt: ModelImportReceipt }>();
const sourceCaptures = new WeakMap<TemporaryModelSource, ResolvedModel>();
const savedCaptures = new WeakMap<SavedTemporaryModel, { source: TemporaryModelSource, captured: CapturedModelImport }>();
let publicationGeneration = 0;

/** File registration also works before chat storage has been initialized. */
export function captureModelFileStorage(): () => boolean {
  try {
    return storageService.captureSettingsStorage();
  } catch {
    return () => {
      try {
        storageService.getCurrentType();
        return false;
      } catch {
        return true;
      }
    };
  }
}

function notifyModels(): void {
  for (const listener of modelListeners) {
    try {
      listener();
    } catch { /* Observers cannot undo a file mutation. */ }
  }
}

export function invalidateModelFilePublication({ modelId }: { modelId: string }): void {
  publications.delete(modelId);
  replay.delete(modelId);
  storedPublicationCaptures.delete(modelId);
}

export function publishModelImport({ storage, models, isCurrent }: { storage: 'temp' | 'opfs', models: readonly LocalModel[], isCurrent: () => boolean }): ModelImportReceipt {
  const parsed = modelsSchema.parse(models);
  const generation = ++publicationGeneration;
  if (!isCurrent()) {
    return Object.freeze({ storage, models: Object.freeze(parsed), publication: Object.freeze({ generation, isCurrent: () => false }) });
  }
  for (const model of parsed) {
    publications.set(model.modelId, generation);
  }
  const receipt: ModelImportReceipt = Object.freeze({
    storage,
    models: Object.freeze(parsed),
    publication: Object.freeze({ generation, isCurrent: ({ modelId }: { modelId: string }) => isCurrent() && publications.get(modelId) === generation }),
  });
  for (const model of parsed) {
    replay.set(model.modelId, receipt);
  }
  for (const listener of importListeners) {
    try {
      listener({ receipt });
    } catch { /* Publication is already committed. */ }
  }
  notifyModels();
  return receipt;
}

temporaryModelFiles.subscribe({
  listener: ({ rootPath }) => {
    for (const modelId of publications.keys()) {
      if (modelId.startsWith('temp/') && `temp/${parseTemporaryModelReference({ modelId }).rootName}` === rootPath) {
        invalidateModelFilePublication({ modelId });
      }
    }
  },
});
temporaryModels.subscribe({ listener: notifyModels });
storageService.subscribeToChanges({
  listener: ({ event }) => {
    switch (event.type) {
    case 'migration': notifyModels();
      break;
    case 'chat_content': case 'chat_meta_and_chat_group': case 'chat_content_generation': case 'settings': case 'binary_objects': case 'naidan_rpc_registry': break;
    default: {
      const exhaustive: never = event;
      throw new Error(String(exhaustive));
    }
    }
  },
});

async function importTemporaryDirectory({ directory, signal }: { directory: ModelDirectoryInput, signal: AbortSignal | undefined }): Promise<ModelImportReceipt> {
  const isStorageCurrent = captureModelFileStorage();
  const { root, models } = await temporaryModels.registerDirectoryWithRoot({ directory, signal });
  return publishModelImport({
    storage: 'temp',
    models,
    isCurrent: () => isStorageCurrent()
    && temporaryModelFiles.get({ rootPath: root.rootPath })?.registrationRevision === root.registrationRevision,
  });
}

async function importStoredDirectory({ directory, signal, onProgress }: { directory: ModelDirectoryInput, signal: AbortSignal | undefined, onProgress: (({ progress }: { progress: Progress }) => void) | undefined }): Promise<ModelImportReceipt> {
  directory = modelDirectoryInputSchema.parse(directory);
  const isStorageCurrent = captureModelFileStorage();
  let receipt: ModelImportReceipt | undefined;
  await importCheckedDirectory({
    directory,
    signal,
    collision: 'reject',
    onProgress: onProgress ?? (() => {}),
    onCommitted: ({ captured }) => {
      receipt = publishModelImport({ storage: 'opfs', models: [captured.model], isCurrent: isStorageCurrent });
      retainStoredPublication({ captured, receipt });
    },
  });
  if (!receipt) {
    throw new LlamaCppBrowserError({ code: 'storage-error' });
  }
  return receipt;
}

async function importCheckedDirectory({ directory, signal, collision, onProgress, onCommitted }: { directory: ModelDirectoryInput, signal: AbortSignal | undefined, collision: 'reject' | 'rename', onProgress: ({ progress }: { progress: Progress }) => void, onCommitted: ({ captured }: { captured: CapturedModelImport }) => void }): Promise<CapturedModelImport> {
  try {
    return await importCapturedModelDirectory({ directory, signal, collision, onProgress, onCommitted });
  } catch (error) {
    if (error instanceof DOMException && ['QuotaExceededError', 'NoModificationAllowedError', 'NotAllowedError'].includes(error.name)) {
      throw new LlamaCppBrowserError({ code: 'storage-error' });
    }
    throw error;
  }
}

async function listModelEntries({ signal }: { signal: AbortSignal | undefined }): Promise<LocalModel[]> {
  signal?.throwIfAborted();
  await temporaryModels.ensure({ signal });
  const temporary = temporaryModels.list();
  const directories = await storageService.loadHostModelDirectories().catch(error => {
    if (!temporary.length) {
      throw error;
    }
    return [];
  });
  let models: LocalModel[];
  let opfsFailure: { error: unknown } | undefined;
  try {
    models = await listStoredModels();
  } catch (error) {
    if (!directories.length && !temporary.length) {
      throw error;
    }
    models = [];
    opfsFailure = { error };
  }
  models.push(...await listHostStoredModels({ directories, signal }), ...temporary);
  await validateStoredPublications({ signal, modelId: undefined });
  if (opfsFailure) {
    recordOpfsInventoryIssue(opfsFailure);
  }
  signal?.throwIfAborted();
  return models.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export const llamaCppBrowserModelFiles = {
  listModelEntries,
  async getModelEntry({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<LocalModel> {
    await validateStoredPublications({ signal, modelId });
    const resolved = await resolveModel({ modelId, signal });
    return describeDirectory({ modelId, directory: resolved.directory });
  },
  subscribeModelList({ listener }: { listener: () => void }): () => void {
    modelListeners.add(listener);
    return () => {
      modelListeners.delete(listener);
    };
  },
  subscribeModelImports({ listener }: { listener: ({ receipt }: { receipt: ModelImportReceipt }) => void }): () => void {
    importListeners.add(listener);
    for (const receipt of new Set(replay.values())) {
      if (receipt.models.some(model => receipt.publication.isCurrent({ modelId: model.modelId }))) {
        listener({ receipt });
      }
    }
    return () => {
      importListeners.delete(listener);
    };
  },
  async importModel({ file, signal, storage, onProgress }: { file: File, signal: AbortSignal | undefined, storage?: 'opfs' | 'temp', onProgress?: ({ progress }: { progress: Progress }) => void }): Promise<ModelImportReceipt> {
    switch (storage) {
    case 'temp': return importTemporaryDirectory({ directory: directoryForModelFile({ file }), signal });
    case 'opfs': case undefined: return importStoredDirectory({ directory: directoryForModelFile({ file }), signal, onProgress });
    default: {
      const exhaustive: never = storage;
      throw new Error(String(exhaustive));
    }
    }
  },
  async importDirectory({ directory, signal, storage, onProgress }: { directory: ModelDirectoryInput, signal: AbortSignal | undefined, storage?: 'opfs' | 'temp', onProgress?: ({ progress }: { progress: Progress }) => void }): Promise<ModelImportReceipt> {
    switch (storage) {
    case 'temp': return importTemporaryDirectory({ directory, signal });
    case 'opfs': case undefined: return importStoredDirectory({ directory, signal, onProgress });
    default: {
      const exhaustive: never = storage;
      throw new Error(String(exhaustive));
    }
    }
  },
  async removeTemporaryModel({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<void> {
    signal?.throwIfAborted();
    invalidateModelFilePublication({ modelId });
    temporaryModels.removeModel({ modelId });
  },
  async removeModel({ plan, signal }: { plan: DeletionPlan, signal: AbortSignal | undefined }): Promise<DeletionResult> {
    signal?.throwIfAborted();
    const result = await withModelMutationLock({
      signal,
      operation: async () => {
        const removed = await removeStoredModel({ plan });
        if (removed === 'deleted' && plan.target.kind === 'model') {
          invalidateModelFilePublication({ modelId: plan.target.modelId });
        }
        return removed;
      },
    });
    notifyModels();
    return result;
  },
};

export async function captureTemporaryModelSource({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<TemporaryModelSource> {
  const { rootName, repository } = parseTemporaryModelReference({ modelId });
  const rootPath = `temp/${rootName}`;
  const root = temporaryModelFiles.get({ rootPath });
  const isStorageCurrent = captureModelFileStorage();
  if (!root) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  const sourceFiles = new Map(root.files.map(entry => [entry.relativePath, entry.file]));
  const resolved = await temporaryModels.resolveModel({ modelId, signal });
  if (!resolved || resolved.location.kind !== 'temp' || resolved.location.rootPath !== rootPath
    || temporaryModelFiles.get({ rootPath }) !== root || !isStorageCurrent()
    || resolved.directory.files.some(entry => entry.storageKind !== 'temp' || entry.registrationRevision !== root.registrationRevision
      || sourceFiles.get(repository === undefined ? entry.relativePath : `${repository}/${entry.relativePath}`) !== entry.file)) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  const source: TemporaryModelSource = Object.freeze({
    model: describeDirectory({ modelId, directory: resolved.directory }),
    rootPath,
    registrationRevision: root.registrationRevision,
    isCurrent: () => isStorageCurrent() && temporaryModelFiles.get({ rootPath }) === root
      && temporaryModels.hasModel({ modelId, rootPath, registrationRevision: root.registrationRevision }),
  });
  if (!source.isCurrent()) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  sourceCaptures.set(source, resolved);
  return source;
}

export async function copyTemporaryModel({ source, signal, onProgress }: { source: TemporaryModelSource, signal: AbortSignal | undefined, onProgress: ({ progress }: { progress: Progress }) => void }): Promise<SavedTemporaryModel> {
  const resolved = sourceCaptures.get(source);
  if (!resolved || !source.isCurrent()) {
    throw new LlamaCppBrowserError({ code: 'missing-model' });
  }
  const isStorageCurrent = captureModelFileStorage();
  let receipt: ModelImportReceipt | undefined;
  const captured = await importCheckedDirectory({
    directory: { rootName: source.rootPath.slice('temp/'.length), files: resolved.directory.files.map(({ relativePath, file }) => ({ relativePath, file })) },
    signal,
    onProgress,
    collision: 'rename',
    onCommitted: ({ captured }) => {
      receipt = publishModelImport({ storage: 'opfs', models: [captured.model], isCurrent: isStorageCurrent });
      retainStoredPublication({ captured, receipt });
    },
  });
  if (!receipt) {
    throw new LlamaCppBrowserError({ code: 'storage-error' });
  }
  const saved = Object.freeze({ model: captured.model, receipt });
  savedCaptures.set(saved, { source, captured });
  return saved;
}

function retainStoredPublication({ captured, receipt }: { captured: CapturedModelImport, receipt: ModelImportReceipt }): void {
  if (receipt.publication.isCurrent({ modelId: captured.model.modelId })) {
    storedPublicationCaptures.set(captured.model.modelId, { captured, receipt });
  }
}

async function validateStoredPublications({ signal, modelId }: { signal: AbortSignal | undefined, modelId: string | undefined }): Promise<void> {
  const candidates = [...storedPublicationCaptures].filter(([candidateId]) => modelId === undefined || candidateId === modelId);
  if (!candidates.length) {
    return;
  }
  const invalidated = await withModelMutationLock({
    signal,
    operation: async () => {
      let invalidated = false;
      for (const [candidateId, capture] of candidates) {
        signal?.throwIfAborted();
        let current = capture.receipt.publication.isCurrent({ modelId: candidateId });
        if (current) {
          try {
            current = await savedFilesAreCurrent({ captured: capture.captured, signal });
          } catch (error) {
            signal?.throwIfAborted();
            if (!(error instanceof DOMException && ['NotFoundError', 'TypeMismatchError'].includes(error.name))) {
              throw error;
            }
            current = false;
          }
        }
        if (!current && storedPublicationCaptures.get(candidateId) === capture) {
          invalidateModelFilePublication({ modelId: candidateId });
          invalidated = true;
        }
      }
      return invalidated;
    },
  });
  if (invalidated) {
    notifyModels();
  }
}

async function savedFilesAreCurrent({ captured, signal }: { captured: CapturedModelImport, signal: AbortSignal | undefined }): Promise<boolean> {
  const rootName = captured.model.modelId.slice('user/'.length);
  const parent = await existingUserModelDirectory();
  if (!parent || !await parent.isSameEntry(captured.parent)) {
    return false;
  }
  const folder = await parent.getDirectoryHandle(rootName);
  if (!await folder.isSameEntry(captured.folder)) {
    return false;
  }
  const directory = await resolveDirectory({ folder, signal });
  if (directory.primaryFile.relativePath !== captured.directory.primaryFile.relativePath
    || directory.projectorFile?.relativePath !== captured.directory.projectorFile?.relativePath
    || directory.files.length !== captured.directory.files.length) {
    return false;
  }
  for (const previous of captured.directory.files) {
    const current = directory.files.find(entry => entry.relativePath === previous.relativePath);
    if (!current || previous.storageKind !== 'opfs' || current.storageKind !== 'opfs'
      || previous.file.size !== current.file.size || previous.file.lastModified !== current.file.lastModified
      || !await previous.handle.isSameEntry(current.handle)) {
      return false;
    }
  }
  return true;
}

export async function withSavedTemporaryModelFiles<T>({ source, saved, signal, operation }: { source: TemporaryModelSource, saved: SavedTemporaryModel, signal: AbortSignal | undefined, operation: ({ model }: { model: LocalModel }) => Promise<T> }): Promise<{ status: 'busy' | 'changed' } | { status: 'completed', value: T }> {
  if (!navigator.locks) {
    throw new LlamaCppBrowserError({ code: 'unavailable' });
  }
  signal?.throwIfAborted();
  return navigator.locks.request(modelMutationLockName, { mode: 'exclusive', ifAvailable: true }, async lock => {
    signal?.throwIfAborted();
    if (!lock) {
      return { status: 'busy' as const };
    }
    const capture = savedCaptures.get(saved);
    if (!capture || capture.source !== source || !source.isCurrent()
      || !saved.receipt.publication.isCurrent({ modelId: saved.model.modelId })) {
      return { status: 'changed' as const };
    }
    try {
      if (!await savedFilesAreCurrent({ captured: capture.captured, signal })) {
        return { status: 'changed' as const };
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof DOMException && ['NotFoundError', 'TypeMismatchError'].includes(error.name)) {
        return { status: 'changed' as const };
      }
      throw error;
    }
    if (!source.isCurrent()) {
      return { status: 'changed' as const };
    }
    return { status: 'completed' as const, value: await operation({ model: saved.model }) };
  });
}

export async function waitForModelFileMutation({ signal }: { signal: AbortSignal | undefined }): Promise<void> {
  await withModelMutationLock({ signal, operation: async () => {} });
}

export const TEST_ONLY = {
  resetPublications() {
    publications.clear();
    replay.clear();
    storedPublicationCaptures.clear();
    publicationGeneration = 0;
  },
};
