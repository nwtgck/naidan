import { modelSourceRepositorySchema } from '@/01-models/llama-cpp-browser-model-launch';
import { modelGroups, modelVariantName } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { selectRepositoryModel } from '@/features/llama-cpp-browser/hugging-face/model-selector';
import { LlamaCppBrowserError, modelDirectoryInputSchema, modelsSchema, type LocalModel, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { describeDirectory, resolveModelFiles, validGguf } from './model-directory';
import { normalizeModelDirectoryInput } from './model-directory-input';
import { parseTemporaryModelReference, temporaryModelReference } from './temporary-model-reference';
import { temporaryModelSourceSchema, temporarySourceDirectory, type TemporaryModelSource } from './temporary-model-source';

function createTemporaryModelStore() {
  // A small directory/file tree, not an emulated writable filesystem. Sources
  // retain repository/root-relative paths and File references, never copied model bytes.
  const roots = new Map<string, Map<string, TemporaryModelSource>>();
  const listeners = new Set<() => void>();
  let revision = 0;

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch { /* Inventory observers cannot roll back an accepted registration. */ }
    }
  }

  function availableRootName({ name }: { name: string }): string {
    let candidate = name;
    for (let suffix = 2; roots.has(candidate); suffix++) {
      const ending = `-${suffix}`;
      const characters = Array.from(name);
      while (new TextEncoder().encode(characters.join('') + ending).length > 255) {
        characters.pop();
      }
      candidate = characters.join('') + ending;
    }
    return candidate;
  }

  function source({ name }: { name: string }): TemporaryModelSource | undefined {
    if (!name.startsWith('temp/')) {
      return undefined;
    }
    const { rootName, selector } = parseTemporaryModelReference({ name });
    const models = roots.get(rootName);
    const found = models?.get(name);
    if (!models || !found) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
    if (selector !== undefined) {
      // Share the same exact-path-or-variant resolution and ambiguity rules as
      // Hugging Face and linked folders, even after a sibling is removed.
      const siblings = [...models.values()].filter(entry => entry.variantRepository === found.variantRepository);
      if (selectRepositoryModel({ models: siblings, repository: found.variantRepository, selectors: [selector] }) !== found) {
        throw new LlamaCppBrowserError({ code: 'missing-model' });
      }
    }
    // Do not expose mutable registry arrays. File itself is an immutable snapshot.
    return temporaryModelSourceSchema.parse(found);
  }

  function list(): LocalModel[] {
    return [...roots.values()].flatMap(models => [...models.values()].map(source => describeDirectory({ directory: temporarySourceDirectory({ name: source.id, source }) })))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function registerDirectory({ directory, signal }: { directory: ModelDirectoryInput, signal: AbortSignal | undefined }): Promise<LocalModel[]> {
    signal?.throwIfAborted();
    const input = normalizeModelDirectoryInput({ directory: modelDirectoryInputSchema.parse(directory) });
    const ggufs = input.files.filter(entry => /\.gguf$/i.test(entry.path));
    if (!ggufs.length) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    }
    for (const { file } of ggufs) {
      signal?.throwIfAborted();
      if (!await validGguf({ file })) {
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
    signal?.throwIfAborted();
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
    // Reserve and publish synchronously after validation. Concurrent drops cannot
    // choose the same live name; a failed/cancelled import leaves no partial root.
    const rootName = availableRootName({ name: input.name });
    const nextRevision = ++revision;
    const models = new Map<string, TemporaryModelSource>();
    for (const { repository, variantRepository, files, modelPath, projectorPath } of pending) {
      const selector = collection || pending.length > 1 ? modelVariantName({ repository: variantRepository, path: modelPath }) : undefined;
      const id = temporaryModelReference({ rootName, repository, selector });
      models.set(id, { id, revision: nextRevision, files, modelPath, projectorPath, variantRepository });
    }
    const result = modelsSchema.parse([...models.values()].map(source => describeDirectory({ directory: temporarySourceDirectory({ name: source.id, source }) })));
    roots.set(rootName, models);
    notify();
    return result;
  }

  function remove({ name }: { name: string }): void {
    const { rootName } = parseTemporaryModelReference({ name });
    const models = roots.get(rootName);
    if (!models?.delete(name)) {
      return;
    }
    if (!models.size) {
      roots.delete(rootName);
    }
    // Names become reusable immediately. Existing requests may finish reading
    // their captured Files; persisted references are intentionally left alone.
    notify();
  }

  return {
    registerDirectory,
    source,
    list,
    remove,
    subscribe({ listener }: { listener: () => void }): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// Page-owned, not Worker-owned: closing the manager or restarting inference does
// not unregister models. Reloading the page does; no storage or tab synchronization.
export const temporaryModels = createTemporaryModelStore();

export const TEST_ONLY = {
  createTemporaryModelStore,
};
