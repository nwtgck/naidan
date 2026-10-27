import { nanoid } from 'nanoid';
import { idToRaw, toLocalModelSourceId, type LocalModelSourceId } from '@/01-models/ids';
import type { TemporaryModelDirectory } from '@/01-models/temporary-model-files';
import { readTemporaryModelFile } from '@/logic/model-file-system';
import { temporaryModelFiles, type TemporaryModelFiles } from '@/logic/temporary-model-files';
import { hasLocalRepositoryReferencePrefix, localRepositoryReference, parseLocalRepositoryReference } from '@/01-models/llama-cpp-browser-model-id';
import { LlamaCppBrowserError, type LocalModel, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { describeDirectory, validGguf, type ModelDirectory, type ResolvedModel } from './model-directory';
import { localRepositoryInput } from './model-directory-input';
import { localRepositoryDirectories } from './local-repository-layout';
import { reserveLocalRepositoryName } from './local-repository-name';
import { claimLocalRepositoryRoot, registerLocalRepositoryLifetime } from '@/features/llama-cpp-browser/local-repository-lifetime';

export type LocalRepositorySource = Readonly<{
  sourceId: LocalModelSourceId,
  rootName: string,
  root: TemporaryModelDirectory,
  configurations: readonly { selector: string, directory: ModelDirectory }[],
}>;
type Entry = {
  source: LocalRepositorySource,
  phase: 'active' | 'retiring',
  reservation: Awaited<ReturnType<typeof reserveLocalRepositoryName>>,
  operations: number,
  excluded: Set<string>,
  drained: (() => void)[],
  releaseLifetime: (() => void)[],
  retirement: Promise<void> | undefined,
  saved: { rootName: string, models: readonly LocalModel[], isPublished({ modelId }: { modelId: string }): boolean, isCurrent({ modelId }: { modelId: string }): Promise<boolean> } | undefined,
};

/** This registry deliberately owns only llama.cpp local File/OPFS-user sources.
 * Transformers.js retains its independent cache/model resolution. HF downloads
 * and linked host folders keep their existing ownership and lifetime. */
function createLocalRepositoryStore({ registry }: { registry: TemporaryModelFiles }) {
  const entries = new Map<string, Entry>();
  const savedModels = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  function notify(): void {
    for (const listener of listeners) {
      try {
        listener();
      } catch { /* Observational only. */ }
    }
  }
  function current({ entry }: { entry: Entry }): boolean {
    return entry.phase === 'active' && entries.get(entry.source.rootName) === entry
      && registry.get({ rootPath: entry.source.root.rootPath }) === entry.source.root;
  }
  function entryFor({ source }: { source: LocalRepositorySource }): Entry {
    const entry = entries.get(source.rootName);
    if (!entry || entry.source !== source || !current({ entry })) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
    return entry;
  }
  function describe({ entry, selector, directory }: { entry: Entry, selector: string, directory: ModelDirectory }): LocalModel {
    const modelId = localRepositoryReference({ storage: 'pending', rootName: entry.source.rootName, selector });
    return describeDirectory({ modelId, directory });
  }
  function sourceFor({ modelId }: { modelId: string }): LocalRepositorySource | undefined {
    if (!hasLocalRepositoryReferencePrefix({ modelId, storage: undefined })) {
      return undefined;
    }
    const reference = parseLocalRepositoryReference({ modelId });
    switch (reference.storage) {
    case 'pending': {
      const entry = entries.get(reference.rootName);
      return entry && current({ entry }) && reference.selector !== undefined && !entry.excluded.has(reference.selector) ? entry.source : undefined;
    }
    case 'saved': {
      const entry = savedModels.get(modelId);
      return entry && current({ entry }) && entry.saved?.isPublished({ modelId }) ? entry.source : undefined;
    }
    default: {
      const exhaustive: never = reference.storage;
      throw new Error(String(exhaustive));
    }
    }
  }
  function pin({ source }: { source: LocalRepositorySource }): { release(): void } {
    const entry = entryFor({ source });
    entry.operations++;
    let released = false;
    return {
      release() {
        if (released) {
          return;
        }
        released = true;
        entry.operations--;
        if (entry.operations === 0) {
          for (const resolve of entry.drained.splice(0)) {
            resolve();
          }
        }
      },
    };
  }
  function retire({ source }: { source: LocalRepositorySource }): Promise<void> {
    const entry = entries.get(source.rootName);
    if (!entry || entry.source !== source) {
      return Promise.resolve();
    }
    if (entry.retirement) {
      return entry.retirement;
    }
    entry.phase = 'retiring';
    entry.retirement = Promise.resolve().then(async () => {
      if (entry.operations) {
        await new Promise<void>(resolve => entry.drained.push(resolve));
      }
      if (entries.get(source.rootName) === entry) {
        entries.delete(source.rootName);
      }
      for (const [modelId, candidate] of savedModels) {
        if (candidate === entry) {
          savedModels.delete(modelId);
        }
      }
      for (const release of entry.releaseLifetime) {
        release();
      }
      await entry.reservation.release();
      notify();
    });
    notify();
    return entry.retirement;
  }
  registry.subscribe({
    listener: ({ rootPath }) => {
      for (const entry of entries.values()) {
        if (entry.source.root.rootPath === rootPath && registry.get({ rootPath }) !== entry.source.root) {
          void retire({ source: entry.source });
        }
      }
    },
  });
  return {
    sourceFor,
    pin,
    retire,
    isCurrent({ source }: { source: LocalRepositorySource }): boolean {
      const entry = entries.get(source.rootName);
      return entry?.source === source && current({ entry });
    },
    /** Retiring sources cannot be selected again, but their accepted writes
     * keep the same leased identity until the final pin has been released. */
    isIdentityRetained({ source }: { source: LocalRepositorySource }): boolean {
      const entry = entries.get(source.rootName);
      return entry?.source === source && (current({ entry }) || (entry.phase === 'retiring' && entry.operations > 0));
    },
    list(): LocalModel[] {
      return [...entries.values()].filter(entry => current({ entry })).flatMap(entry => {
        const saved = entry.saved;
        return saved ? saved.models.filter(model => saved.isPublished({ modelId: model.modelId }))
          : entry.source.configurations.filter(configuration => !entry.excluded.has(configuration.selector)).map(configuration => describe({ entry, ...configuration }));
      });
    },
    async register({ directory, signal }: { directory: ModelDirectoryInput, signal: AbortSignal | undefined }): Promise<LocalRepositorySource> {
      directory = localRepositoryInput({ directory });
      for (const entry of directory.files) {
        signal?.throwIfAborted();
        if (/\.gguf$/i.test(entry.relativePath) && !await validGguf({ file: entry.file })) {
          throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
        }
      }
      // Validate before reserving or publishing any source.
      localRepositoryDirectories({ files: directory.files.map(file => ({ ...file, storageKind: 'temp', registrationRevision: 1 })) });
      const reservation = await reserveLocalRepositoryName({ rootName: directory.rootName, signal });
      let root: TemporaryModelDirectory | undefined;
      try {
        root = registry.register({ directory: { ...directory, rootName: reservation.rootName }, signal });
        claimLocalRepositoryRoot({ root });
        const configurations = localRepositoryDirectories({ files: root.files.map(entry => readTemporaryModelFile({ root: root!, relativePath: entry.relativePath })) });
        signal?.throwIfAborted();
        const source: LocalRepositorySource = Object.freeze({ sourceId: toLocalModelSourceId({ raw: nanoid() }), rootName: reservation.rootName, root, configurations });
        const entry: Entry = { source, phase: 'active', reservation, operations: 0, excluded: new Set(), drained: [], saved: undefined, releaseLifetime: [], retirement: undefined };
        entries.set(source.rootName, entry);
        entry.releaseLifetime.push(registerLocalRepositoryLifetime({
          modelIds: configurations.map(({ selector }) => localRepositoryReference({ storage: 'pending', rootName: source.rootName, selector })),
          lifetime: { isCurrent: () => current({ entry }), retain: () => pin({ source }) },
        }));
        notify();
        return source;
      } catch (error) {
        if (root) {
          registry.remove({ rootPath: root.rootPath });
        }
        await reservation.release();
        throw error;
      }
    },
    models({ source }: { source: LocalRepositorySource }): LocalModel[] {
      const entry = entryFor({ source });
      const saved = entry.saved;
      return saved ? saved.models.filter(model => saved.isPublished({ modelId: model.modelId })) : source.configurations.filter(configuration => !entry.excluded.has(configuration.selector)).map(configuration => describe({ entry, ...configuration }));
    },
    removeModel({ modelId }: { modelId: string }): void {
      const source = sourceFor({ modelId });
      if (!source) {
        return;
      }
      const reference = parseLocalRepositoryReference({ modelId });
      if (reference.selector !== undefined) {
        // Removing a temporary projection never unregisters sibling variants
        // or shared Files. The raw folder has its own explicit unregister UI.
        entryFor({ source }).excluded.add(reference.selector);
        notify();
      }
    },
    savedModelId({ modelId }: { modelId: string }): string {
      const source = sourceFor({ modelId });
      if (!source || !hasLocalRepositoryReferencePrefix({ modelId, storage: 'pending' })) {
        return modelId;
      }
      const entry = entryFor({ source });
      if (!entry.saved) {
        return modelId;
      }
      const { selector } = parseLocalRepositoryReference({ modelId });
      const saved = localRepositoryReference({ storage: 'saved', rootName: entry.saved.rootName, selector });
      return entry.saved.isPublished({ modelId: saved }) ? saved : modelId;
    },
    setSaved({ source, rootName, models, isCurrent, isPublished }: {
      source: LocalRepositorySource, rootName: string, models: readonly LocalModel[], isPublished({ modelId }: { modelId: string }): boolean, isCurrent({ modelId }: { modelId: string }): Promise<boolean>,
    }): void {
      const entry = entryFor({ source });
      entry.saved = { rootName, models, isCurrent, isPublished };
      for (const model of models) {
        savedModels.set(model.modelId, entry);
      }
      entry.releaseLifetime.push(registerLocalRepositoryLifetime({ modelIds: models.map(model => model.modelId), lifetime: { isCurrent: () => current({ entry }), retain: () => pin({ source }) } }));
      notify();
    },
    async resolve({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<ResolvedModel | undefined> {
      const source = sourceFor({ modelId });
      if (!source) {
        return undefined;
      }
      const entry = entryFor({ source });
      const reference = parseLocalRepositoryReference({ modelId });
      if (reference.storage === 'saved' && !await entry.saved?.isCurrent({ modelId })) {
        savedModels.delete(modelId);
        return undefined;
      }
      signal?.throwIfAborted();
      if (!current({ entry })) {
        throw new LlamaCppBrowserError({ code: 'missing-model' });
      }
      const configuration = source.configurations.find(candidate => candidate.selector === reference.selector);
      if (!configuration) {
        throw new LlamaCppBrowserError({ code: 'missing-model' });
      }
      // Preserve File identity; callers get their own array/entry wrappers.
      const files = configuration.directory.files.map(file => ({ ...file }));
      let savedRootName: string | undefined;
      switch (reference.storage) {
      case 'pending': savedRootName = undefined;
        break;
      case 'saved': savedRootName = entry.saved?.rootName;
        break;
      default: {
        const exhaustive: never = reference.storage;
        throw new Error(String(exhaustive));
      }
      }
      return {
        modelId,
        location: {
          kind: 'local-files',
          rootPath: source.root.rootPath,
          sourceId: idToRaw({ id: source.sourceId }),
          rootName: source.rootName,
          savedRootName,
        },
        directory: {
          files,
          primaryFile: files.find(file => file.relativePath === configuration.directory.primaryFile.relativePath)!,
          projectorFile: files.find(file => file.relativePath === configuration.directory.projectorFile?.relativePath),
        },
      };
    },
    subscribe({ listener }: { listener(): void }): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const localRepositories = createLocalRepositoryStore({ registry: temporaryModelFiles });
export const TEST_ONLY = {
  createLocalRepositoryStore,
};
