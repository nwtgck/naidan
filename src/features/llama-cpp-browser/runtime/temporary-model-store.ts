import { awaitInspection } from '@/logic/model-file-inspection/abort';
import { modelSourceRepositorySchema } from '@/01-models/llama-cpp-browser-model-launch';
import { hasTemporaryModelPathPrefix, temporaryModelRootPath, type TemporaryModelDirectory } from '@/01-models/temporary-model-files';
import { readTemporaryModelFile } from '@/logic/model-file-system';
import { createTemporaryModelFiles, temporaryModelFiles, type TemporaryModelFiles } from '@/logic/temporary-model-files';
import { modelGroups, modelVariantName } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { selectRepositoryModel } from '@/features/llama-cpp-browser/hugging-face/model-selector';
import { LlamaCppBrowserError, modelsSchema, type LocalModel, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { describeDirectory, modelDirectory, validGguf, type ModelDirectory, type ResolvedModel } from './model-directory';
import { normalizeModelDirectoryInput } from './model-directory-input';
import { parseTemporaryModelReference, temporaryModelReference } from '@/features/llama-cpp-browser/temporary-model-reference';
import { isLocalRepositoryRoot } from '@/features/llama-cpp-browser/local-repository-lifetime';

type ProjectionEntry = { resolvedModel: ResolvedModel, variantRepository: string };

/** Model interpretation belongs to llama.cpp, not the shared file registry. */
async function projectDirectory({ root, signal }: { root: TemporaryModelDirectory, signal: AbortSignal }): Promise<Map<string, ProjectionEntry>> {
  signal.throwIfAborted();
  const ggufs = root.files.filter(entry => /\.gguf$/i.test(entry.relativePath));
  if (!ggufs.length) {
    return new Map();
  }
  for (const { file } of ggufs) {
    signal.throwIfAborted();
    if (!await awaitInspection({ task: validGguf({ file }), signal })) {
      throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    }
  }
  // Only GGUF layout determines the projection. Image components in the same
  // shared root cannot change its model IDs or repository boundaries.
  const collection = ggufs.every(({ relativePath }) => {
    const parts = relativePath.split('/');
    return parts.length >= 3 && modelSourceRepositorySchema.safeParse(parts.slice(0, 2).join('/')).success;
  });
  const directories = new Map<string | undefined, ModelDirectoryInput['files']>();
  for (const entry of ggufs) {
    const parts = entry.relativePath.split('/');
    const repository = collection ? parts.slice(0, 2).join('/') : undefined;
    const files = directories.get(repository) ?? [];
    files.push({ relativePath: collection ? parts.slice(2).join('/') : entry.relativePath, file: entry.file });
    directories.set(repository, files);
  }
  const pending: { repository: string | undefined, variantRepository: string, directory: ModelDirectory }[] = [];
  for (const [repository, inputs] of directories) {
    const files = inputs.map(({ relativePath }) => ({
      ...readTemporaryModelFile({ root, relativePath: repository === undefined ? relativePath : `${repository}/${relativePath}` }),
      relativePath,
    }));
    const { models, projectors } = modelGroups({ files });
    if (!models.length) {
      // Companion-only repositories cannot donate projectors across boundaries.
      if (collection) {
        continue;
      }
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    }
    for (const model of models) {
      const directory = modelDirectory({ files: [...model, ...projectors] });
      normalizeModelDirectoryInput({ directory: { rootName: root.rootName, files: directory.files.map(({ relativePath, file }) => ({ relativePath, file })) } });
      pending.push({
        repository,
        variantRepository: repository ?? root.sourceRootName,
        directory,
      });
    }
  }
  if (!pending.length) {
    throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  }
  // Reject the entire import when its readable variants are ambiguous.
  for (const entry of pending) {
    if (!collection && pending.length === 1) {
      continue;
    }
    const variant = modelVariantName({ repository: entry.variantRepository, path: entry.directory.primaryFile.relativePath });
    const candidates = pending.filter(candidate => candidate.variantRepository === entry.variantRepository).map(candidate => candidate.directory);
    if (selectRepositoryModel({ models: candidates, repository: entry.variantRepository, variant }) !== entry.directory) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    }
  }
  const models = new Map<string, ProjectionEntry>();
  for (const { repository, variantRepository, directory } of pending) {
    const selector = collection || pending.length > 1 ? modelVariantName({ repository: variantRepository, path: directory.primaryFile.relativePath }) : undefined;
    const modelId = temporaryModelReference({ rootName: root.rootName, repository, selector });
    const resolvedModel: ResolvedModel = { modelId, location: { kind: 'temp', rootPath: root.rootPath }, directory };
    models.set(modelId, { resolvedModel, variantRepository });
  }
  modelsSchema.parse([...models.values()].map(({ resolvedModel }) => describeDirectory({ modelId: resolvedModel.modelId, directory: resolvedModel.directory })));
  return models;
}

/** Keep the caller's file list mutations separate from the retained projection. */
function copyResolvedModel({ resolvedModel }: { resolvedModel: ResolvedModel }): ResolvedModel {
  const { modelId, location, directory, ...unhandled } = resolvedModel;
  unhandled satisfies Record<PropertyKey, never>;
  const { files, primaryFile, projectorFile, ...unhandledDirectory } = directory;
  unhandledDirectory satisfies Record<PropertyKey, never>;
  const copies = files.map(file => ({ ...file }));
  return {
    modelId,
    location: { ...location },
    directory: {
      files: copies,
      primaryFile: copies[files.indexOf(primaryFile)]!,
      projectorFile: projectorFile === undefined ? undefined : copies[files.indexOf(projectorFile)]!,
    },
  };
}

function createTemporaryModelStore({ registry }: { registry: TemporaryModelFiles }) {
  type Projection = { registrationRevision: number, controller: AbortController, ready: Promise<void>, models: Map<string, ProjectionEntry>, issue: Error | undefined };
  const projections = new Map<string, Projection>();
  const listeners = new Set<() => void>();
  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch { /* Observational only. */ }
    }
  }
  registry.subscribe({
    listener: ({ rootPath }) => {
      // Drop retained File references on explicit root removal or replacement.
      // In-flight projections check their identity again before publishing.
      projections.get(rootPath)?.controller.abort();
      projections.delete(rootPath);
      notify();
    },
  });
  function ensureRoot({ root }: { root: TemporaryModelDirectory }): Promise<void> {
    const existing = projections.get(root.rootPath);
    if (existing?.registrationRevision === root.registrationRevision) {
      return existing.ready;
    }
    const projection: Projection = { registrationRevision: root.registrationRevision, controller: new AbortController(), ready: Promise.resolve(), models: new Map(), issue: undefined };
    projections.set(root.rootPath, projection);
    projection.ready = projectDirectory({ root, signal: projection.controller.signal }).then(models => {
      if (registry.get({ rootPath: root.rootPath }) === root && projections.get(root.rootPath) === projection) {
        projection.models = models;
      }
    }).catch(error => {
      if (registry.get({ rootPath: root.rootPath }) === root && projections.get(root.rootPath) === projection) {
        projection.issue = error instanceof Error ? error : new Error(String(error));
      }
    });
    return projection.ready;
  }
  async function ensure({ signal }: { signal: AbortSignal | undefined }): Promise<void> {
    signal?.throwIfAborted();
    const pending = registry.list().filter(root => !isLocalRepositoryRoot({ root })).map(root => ensureRoot({ root }));
    await awaitInspection({ task: Promise.all(pending), signal });
    signal?.throwIfAborted();
  }
  function resolveProjectedModel({ modelId }: { modelId: string }): ResolvedModel {
    const { rootName, selector } = parseTemporaryModelReference({ modelId });
    const rootPath = temporaryModelRootPath({ rootName });
    const projection = projections.get(rootPath);
    const found = projection?.models.get(modelId);
    const root = registry.get({ rootPath });
    if (!projection || !found || !root || projection.registrationRevision !== root.registrationRevision) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
    if (selector !== undefined) {
      const siblings = [...projection.models.values()].filter(entry => entry.variantRepository === found.variantRepository).map(entry => entry.resolvedModel.directory);
      if (selectRepositoryModel({ models: siblings, repository: found.variantRepository, variant: selector }) !== found.resolvedModel.directory) {
        throw new LlamaCppBrowserError({ code: 'missing-model' });
      }
    }
    return copyResolvedModel({ resolvedModel: found.resolvedModel });
  }
  function list(): LocalModel[] {
    return [...projections].filter(([rootPath]) => {
      const root = registry.get({ rootPath });
      return root !== undefined && !isLocalRepositoryRoot({ root });
    }).flatMap(([, { models }]) => [...models.values()].map(({ resolvedModel }) => describeDirectory({ modelId: resolvedModel.modelId, directory: resolvedModel.directory })))
      .sort((a, b) => a.modelId.localeCompare(b.modelId));
  }
  async function registerDirectoryWithRoot({ directory, signal }: { directory: ModelDirectoryInput, signal: AbortSignal | undefined }): Promise<{ root: TemporaryModelDirectory, models: LocalModel[] }> {
    const root = registry.register({ directory, signal });
    try {
      await awaitInspection({ task: ensureRoot({ root }), signal });
      signal?.throwIfAborted();
    } catch (error) {
      if (signal?.aborted && registry.get({ rootPath: root.rootPath }) === root) {
        registry.remove({ rootPath: root.rootPath });
      }
      throw error;
    }
    const projection = projections.get(root.rootPath);
    if (!projection || registry.get({ rootPath: root.rootPath }) !== root) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
    if (projection.issue) {
      throw projection.issue;
    }
    return { root, models: [...projection.models.values()].map(({ resolvedModel }) => describeDirectory({ modelId: resolvedModel.modelId, directory: resolvedModel.directory })) };
  }
  return {
    ensure,
    list,
    registerDirectoryWithRoot,
    hasModel({ modelId, rootPath, registrationRevision }: { modelId: string, rootPath: string, registrationRevision: number }): boolean {
      return registry.get({ rootPath })?.registrationRevision === registrationRevision
        && projections.get(rootPath)?.registrationRevision === registrationRevision
        && projections.get(rootPath)?.models.has(modelId) === true;
    },
    issues(): { rootPath: string, message: string }[] {
      return [...projections].flatMap(([rootPath, projection]) => projection.issue ? [{ rootPath, message: projection.issue.message }] : []);
    },
    async resolveModel({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<ResolvedModel | undefined> {
      if (!hasTemporaryModelPathPrefix({ path: modelId })) {
        return undefined;
      }
      const { rootName } = parseTemporaryModelReference({ modelId });
      const root = registry.get({ rootPath: temporaryModelRootPath({ rootName }) });
      if (!root || isLocalRepositoryRoot({ root })) {
        throw new LlamaCppBrowserError({ code: 'missing-model' });
      }
      await awaitInspection({ task: ensureRoot({ root }), signal });
      signal?.throwIfAborted();
      return resolveProjectedModel({ modelId });
    },
    async registerDirectory({ directory, signal }: { directory: ModelDirectoryInput, signal: AbortSignal | undefined }): Promise<LocalModel[]> {
      return (await registerDirectoryWithRoot({ directory, signal })).models;
    },
    removeModel({ modelId }: { modelId: string }): void {
      const { rootName } = parseTemporaryModelReference({ modelId });
      // Preserve shared files for image generation and preserve exclusions for
      // this root revision. Explicit unregister starts a separate lifecycle.
      if (projections.get(temporaryModelRootPath({ rootName }))?.models.delete(modelId)) {
        notify();
      }
    },
    subscribe({ listener }: { listener: () => void }): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const temporaryModels = createTemporaryModelStore({ registry: temporaryModelFiles });
export const TEST_ONLY = {
  createTemporaryModelStore: () => createTemporaryModelStore({ registry: createTemporaryModelFiles() }),
  createWithRegistry: createTemporaryModelStore,
};
