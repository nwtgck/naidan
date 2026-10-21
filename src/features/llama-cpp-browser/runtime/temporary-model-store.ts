import { awaitInspection } from '@/logic/model-file-inspection/abort';
import { modelSourceRepositorySchema } from '@/01-models/llama-cpp-browser-model-launch';
import type { TemporaryModelDirectory } from '@/01-models/temporary-model-files';
import { createTemporaryModelFiles, temporaryModelFiles, type TemporaryModelFiles } from '@/logic/temporary-model-files';
import { modelGroups, modelVariantName } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { selectRepositoryModel } from '@/features/llama-cpp-browser/hugging-face/model-selector';
import { LlamaCppBrowserError, modelsSchema, type LocalModel, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { describeDirectory, resolveModelFiles, validGguf } from './model-directory';
import { parseTemporaryModelReference, temporaryModelReference } from './temporary-model-reference';
import { temporaryModelSourceSchema, temporarySourceDirectory, type TemporaryModelSource } from './temporary-model-source';

/** Model interpretation belongs to llama.cpp, not the shared file registry. */
async function projectDirectory({ root, signal }: { root: TemporaryModelDirectory, signal: AbortSignal }): Promise<Map<string, TemporaryModelSource>> {
  signal.throwIfAborted();
  const input = { name: root.sourceName, files: root.files };
  const ggufs = input.files.filter(entry => /\.gguf$/i.test(entry.path));
  if (!ggufs.length) {
    return new Map();
  }
  for (const { file } of ggufs) {
    signal.throwIfAborted();
    if (!await awaitInspection({ task: validGguf({ file }), signal })) {
      throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    }
  }
  // Files cannot reveal the user's semantic intent. Use the linked-root layout
  // exactly when every GGUF is below a syntactically valid owner/repository.
  // Otherwise treat the selected root as one ordinary model directory. Never
  // search upward, invent an owner, or move bytes between repositories.
  const collection = ggufs.every(({ path }) => {
    const parts = path.split('/');
    return parts.length >= 3 && modelSourceRepositorySchema.safeParse(parts.slice(0, 2).join('/')).success;
  });
  const directories = new Map<string | undefined, ModelDirectoryInput['files']>();
  for (const entry of ggufs) {
    const parts = entry.path.split('/');
    const repository = collection ? parts.slice(0, 2).join('/') : undefined;
    const files = directories.get(repository) ?? [];
    files.push({ path: collection ? parts.slice(2).join('/') : entry.path, file: entry.file });
    directories.set(repository, files);
  }
  const pending: { repository: string | undefined, variantRepository: string, files: ModelDirectoryInput['files'], modelPath: string, projectorPath: string | undefined }[] = [];
  for (const [repository, files] of directories) {
    const { models, projectors } = modelGroups({ files });
    if (!models.length) {
      // A collection can contain companion-only repositories. As in linked
      // inventory, they are not independent models and cannot donate a
      // projector to a different repository.
      if (collection) {
        continue;
      }
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    }
    for (const model of models) {
      const resolved = resolveModelFiles({ files: [...model, ...projectors] });
      pending.push({
        repository,
        variantRepository: repository ?? input.name,
        files: [...model, ...projectors.filter(entry => entry.path === resolved.projectorPath)],
        ...resolved,
      });
    }
  }
  if (!pending.length) {
    throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  }
  // A public variant is only accepted if the shared resolver can select its
  // exact file unambiguously. An ambiguous directory is rejected atomically.
  // Unlike a saved repository, an import is a single user action: silently
  // hiding models here would make a successful drop look misleading.
  for (const entry of pending) {
    if (!collection && pending.length === 1) {
      continue;
    }
    const selector = modelVariantName({ repository: entry.variantRepository, path: entry.modelPath });
    const candidates = pending.filter(candidate => candidate.variantRepository === entry.variantRepository);
    if (selectRepositoryModel({ models: candidates, repository: entry.variantRepository, selectors: [selector] }) !== entry) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    }
  }
  const models = new Map<string, TemporaryModelSource>();
  for (const { repository, variantRepository, files, modelPath, projectorPath } of pending) {
    const selector = collection || pending.length > 1 ? modelVariantName({ repository: variantRepository, path: modelPath }) : undefined;
    const id = temporaryModelReference({ rootName: root.name, repository, selector });
    models.set(id, { id, revision: root.revision, files, modelPath, projectorPath, variantRepository });
  }
  modelsSchema.parse([...models.values()].map(source => describeDirectory({ directory: temporarySourceDirectory({ name: source.id, source }) })));
  return models;
}

function createTemporaryModelStore({ registry }: { registry: TemporaryModelFiles }) {
  type Projection = { revision: number, controller: AbortController, ready: Promise<void>, models: Map<string, TemporaryModelSource>, issue: Error | undefined };
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
    listener: ({ rootId }) => {
      // Drop all retained File references, including exclusions, on root removal.
      // In-flight projections check their identity again before publishing.
      projections.get(rootId)?.controller.abort();
      projections.delete(rootId);
      notify();
    },
  });
  async function ensure({ signal }: { signal: AbortSignal | undefined }): Promise<void> {
    signal?.throwIfAborted();
    const pending = registry.list().map(root => {
      const existing = projections.get(root.id);
      if (existing?.revision === root.revision) {
        return existing.ready;
      }
      const projection: Projection = { revision: root.revision, controller: new AbortController(), ready: Promise.resolve(), models: new Map(), issue: undefined };
      projections.set(root.id, projection);
      projection.ready = projectDirectory({ root, signal: projection.controller.signal }).then(models => {
        if (registry.get({ rootId: root.id }) === root && projections.get(root.id) === projection) {
          projection.models = models;
        }
      }).catch(error => {
        if (registry.get({ rootId: root.id }) === root && projections.get(root.id) === projection) {
          projection.issue = error instanceof Error ? error : new Error(String(error));
        }
      });
      return projection.ready;
    });
    await awaitInspection({ task: Promise.all(pending), signal });
    signal?.throwIfAborted();
  }
  function source({ name }: { name: string }): TemporaryModelSource | undefined {
    if (!name.startsWith('temp/')) {
      return undefined;
    }
    const { rootName, selector } = parseTemporaryModelReference({ name });
    const models = projections.get(`temp/${rootName}`)?.models;
    const found = models?.get(name);
    if (!models || !found || !registry.get({ rootId: `temp/${rootName}` })) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
    if (selector !== undefined) {
      const siblings = [...models.values()].filter(entry => entry.variantRepository === found.variantRepository);
      if (selectRepositoryModel({ models: siblings, repository: found.variantRepository, selectors: [selector] }) !== found) {
        throw new LlamaCppBrowserError({ code: 'missing-model' });
      }
    }
    return temporaryModelSourceSchema.parse(found);
  }
  function list(): LocalModel[] {
    return [...projections.values()].flatMap(({ models }) => [...models.values()].map(source => describeDirectory({ directory: temporarySourceDirectory({ name: source.id, source }) })))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return {
    ensure,
    source,
    list,
    issues(): { rootId: string, message: string }[] {
      return [...projections].flatMap(([rootId, projection]) => projection.issue ? [{ rootId, message: projection.issue.message }] : []);
    },
    async resolveSource({ name, signal }: { name: string, signal: AbortSignal | undefined }): Promise<TemporaryModelSource | undefined> {
      if (!name.startsWith('temp/')) {
        return undefined;
      }
      await ensure({ signal });
      return source({ name });
    },
    async registerDirectory({ directory, signal }: { directory: ModelDirectoryInput, signal: AbortSignal | undefined }): Promise<LocalModel[]> {
      const root = registry.register({ directory, signal });
      try {
        await ensure({ signal });
      } catch (error) {
        if (signal?.aborted && registry.get({ rootId: root.id }) === root) {
          registry.remove({ rootId: root.id });
        }
        throw error;
      }
      const issue = projections.get(root.id)?.issue;
      if (issue) {
        throw issue;
      }
      return list().filter(model => parseTemporaryModelReference({ name: model.id }).rootName === root.name);
    },
    remove({ name }: { name: string }): void {
      const { rootName } = parseTemporaryModelReference({ name });
      // Remove only this engine's projection. The shared folder may still supply
      // image-generation components. Its explicit folder-unregister action frees it.
      if (projections.get(`temp/${rootName}`)?.models.delete(name)) {
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
