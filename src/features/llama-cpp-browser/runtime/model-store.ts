import { directoryForModelFile } from './model-directory-input';
import { withModelFileMarkers } from '@/logic/model-file-publication';
import { hostDownloadMarker, hostDownloadMarkerPath } from '@/features/llama-cpp-browser/hugging-face/host-download-marker';
import { resolveModel } from './model-resolution';
import { hostModelRoot, withDestinationLock, type ModelDestination } from './model-destination';
import { OPFS_MODELS_DIR } from '@/constants';
import { isProjector } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { deletionPlanSchema, executeDeletionPlan, scanDeletionTree, pruneCapturedModelRoot, repositoryLocationSchema, type RepositoryLocation, type DeletionPlan, type DeletionResult } from './deletion-plan';
export type { ModelRemovalTarget, RepositoryLocation } from './deletion-plan';
import { listHuggingFaceModels, withRepositoryLock, readJournal, repositoryDirectories, selectRepositoryModel, deleteRepository } from '@/features/llama-cpp-browser/hugging-face/storage';
import { pendingName, type DownloadJournal } from '@/features/llama-cpp-browser/hugging-face/types';
import { allowedModelDirectory, describeDirectory, opfsRoot, resolveLocalRepositoryDirectories, importModelDirectory, existingUserModelDirectory, type ModelDirectory, type ModelRootLocation } from './model-directory';
import { hasLocalRepositoryReferencePrefix, localRepositoryReference, parseLocalRepositoryReference } from '@/01-models/llama-cpp-browser-model-id';
import { LlamaCppBrowserError, type LocalModel, type Progress } from "@/features/llama-cpp-browser/types";
import { logDiagnostic } from "@/features/llama-cpp-browser/debug-log";
import { withModelMutationLock } from './model-mutation-lock';
export { withModelMutationLock } from './model-mutation-lock';

const lockName = "naidan-llama-cpp-browser-model-store";

function isMissing({ error }: { error: unknown }): boolean {
  return error instanceof DOMException && (error.name === "NotFoundError" || error.name === "TypeMismatchError");
}

export async function withModelStoreLock<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
  if (!navigator.locks) {
    throw new LlamaCppBrowserError({ code: "unavailable" });
  }
  return navigator.locks.request(lockName, operation);
}

export async function listStoredModels(): Promise<LocalModel[]> {
  const root = await existingUserModelDirectory();
  const result: LocalModel[] = [];
  for await (const [name, folder] of root?.entries() ?? []) {
    if (folder.kind !== 'directory' || !allowedModelDirectory({ name })) {
      continue;
    }
    try {
      for (const { selector, directory } of await resolveLocalRepositoryDirectories({ folder, rootName: name, signal: undefined })) {
        result.push(describeDirectory({ directory, modelId: localRepositoryReference({ storage: 'saved', rootName: name, selector }) }));
      }
    } catch (error) {
      if (!(error instanceof LlamaCppBrowserError) && !isMissing({ error })) {
        throw error;
      }
    }
  }
  result.push(...await listHuggingFaceModels());
  return result.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export async function importStoredModel({ file, onProgress, signal }: { file: File, signal: AbortSignal | undefined, onProgress: ({ progress }: { progress: Progress }) => void }): Promise<LocalModel> {
  const directory = directoryForModelFile({ file });
  const started = performance.now();
  logDiagnostic({ diagnostic: { event: 'import-start', bytes: file.size } });
  const model = await importModelDirectory({ signal, directory, onProgress });
  logDiagnostic({ diagnostic: { event: 'import-complete', bytes: model.size, elapsedMs: performance.now() - started } });
  return model;
}

type StoredLocation = Exclude<ModelRootLocation, { kind: 'temp' | 'local-files' }>;
export type ModelRemovalRequest = { plan: DeletionPlan, sharedPlan: DeletionPlan | undefined, affectedVariants: number };

async function withRemovalLocationLock<T>({ location, operation }: { location: StoredLocation, operation: () => Promise<T> }): Promise<T> {
  switch (location.kind) {
  case 'host': return withDestinationLock({ destination: { kind: 'host', directoryId: location.directoryId }, operation: () => withRepositoryLock({ repository: location.repository, operation }) });
  case 'hugging-face': return withRepositoryLock({ repository: location.repository, operation });
  case 'opfs-user': return operation();
  default: {
    const exhaustive: never = location;
    throw new Error(String(exhaustive));
  }
  }
}

function repositoryDestination({ location }: { location: RepositoryLocation }): ModelDestination | undefined {
  switch (location.kind) {
  case 'host': return { kind: 'host', directoryId: location.directoryId };
  case 'hugging-face': return undefined;
  default: {
    const exhaustive: never = location;
    throw new Error(String(exhaustive));
  }
  }
}

function ownedDownloadPaths({ location, journal }: { location: RepositoryLocation, journal: DownloadJournal }): string[] {
  const ownedFiles = journal.selection.files.filter((_file, index) => !journal.reused?.[index]);
  switch (location.kind) {
  case 'host': return [pendingName, ...ownedFiles.flatMap(file => [file.path, hostDownloadMarkerPath({ path: file.path })])];
  case 'hugging-face': return [pendingName, ...ownedFiles.map(file => file.path)];
  default: {
    const exhaustive: never = location;
    throw new Error(String(exhaustive));
  }
  }
}

async function captureRoot({ location }: { location: StoredLocation }): Promise<{ parent: FileSystemDirectoryHandle, folder: FileSystemDirectoryHandle, rootName: string }> {
  let parent: FileSystemDirectoryHandle;
  let rootName: string;
  switch (location.kind) {
  case 'opfs-user': {
    const existing = await existingUserModelDirectory();
    if (!existing) {
      throw new LlamaCppBrowserError({ code: 'missing-model' });
    }
    parent = existing;
    rootName = location.rootName;
    break;
  }
  case 'host': {
    parent = await hostModelRoot({ destination: { kind: 'host', directoryId: location.directoryId }, mode: 'readwrite' });
    const [owner, repositoryName] = location.repository.split('/');
    parent = await parent.getDirectoryHandle(owner!);
    rootName = repositoryName!;
    break;
  }
  case 'hugging-face': {
    parent = await opfsRoot();
    for (const segment of [OPFS_MODELS_DIR, 'huggingface.co', ...location.repository.split('/'), 'resolve']) {
      parent = await parent.getDirectoryHandle(segment);
    }
    rootName = 'main';
    break;
  }
  default: {
    const exhaustive: never = location;
    throw new Error(String(exhaustive));
  }
  }
  return { parent, rootName, folder: await parent.getDirectoryHandle(rootName) };
}

async function captureRemovalPlans({ target, root, selectedRelativePaths, projectorRelativePaths, affectedVariants }: {
  target: DeletionPlan['target'], root: { parent: FileSystemDirectoryHandle, folder: FileSystemDirectoryHandle, rootName: string },
  selectedRelativePaths: string[], projectorRelativePaths: string[], affectedVariants: number,
}): Promise<ModelRemovalRequest> {
  const { files } = await scanDeletionTree({ folder: root.folder });
  const selected = [...new Set(withModelFileMarkers({ paths: selectedRelativePaths }))];
  const projectors = [...new Set(withModelFileMarkers({ paths: projectorRelativePaths }))];
  const plan = deletionPlanSchema.parse({
    target,
    ...root,
    selectedRelativePaths: selected,
    sharedProjector: projectors.length ? 'keep' : undefined,
    files: files.filter(file => selected.includes(file.relativePath)),
  });
  const sharedPaths = [...new Set([...selected, ...projectors])];
  const sharedPlan = projectors.length ? deletionPlanSchema.parse({
    target,
    ...root,
    selectedRelativePaths: sharedPaths,
    sharedProjector: 'include',
    files: files.filter(file => sharedPaths.includes(file.relativePath)),
  }) : undefined;
  return { plan, sharedPlan, affectedVariants };
}

/** Resolve and capture the folder before showing a confirmation. Execution uses
 * this folder even if public aliases are recomputed in the meantime.
 */
export async function prepareModelRemoval({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }): Promise<ModelRemovalRequest> {
  return withModelMutationLock({
    operation: async () => {
      signal?.throwIfAborted();
      // Incomplete user imports must remain explicitly removable even though they
      // are intentionally absent from the readable model inventory.
      const userReference = hasLocalRepositoryReferencePrefix({ modelId, storage: 'saved' }) ? parseLocalRepositoryReference({ modelId }) : undefined;
      const userRootName = userReference?.rootName;
      let location: StoredLocation;
      let directory: ModelDirectory | undefined;
      if (userRootName !== undefined && allowedModelDirectory({ name: userRootName })) {
        location = { kind: 'opfs-user', rootName: userRootName };
      } else {
        const resolved = await resolveModel({ modelId, signal });
        switch (resolved.location.kind) {
        case 'temp': case 'local-files': throw new LlamaCppBrowserError({ code: 'missing-model' });
        case 'opfs-user': case 'hugging-face': case 'host': location = resolved.location;
          break;
        default: {
          const exhaustive: never = resolved.location;
          throw new Error(String(exhaustive));
        }
        }
        directory = resolved.directory;
      }
      return withRemovalLocationLock({
        location,
        operation: async () => {
          const root = await captureRoot({ location });
          let selectedRelativePaths: string[];
          let projectorRelativePaths: string[];
          let affectedVariants = 0;
          switch (location.kind) {
          case 'opfs-user': {
            const { files } = await scanDeletionTree({ folder: root.folder });
            if (userReference?.selector !== undefined) {
              const configurations = await resolveLocalRepositoryDirectories({ folder: root.folder, rootName: root.rootName, signal });
              const selected = configurations.find(configuration => configuration.selector === userReference.selector);
              if (!selected) {
                throw new LlamaCppBrowserError({ code: 'missing-model' });
              }
              const siblings = configurations.filter(configuration => configuration !== selected);
              const shared = new Set(siblings.flatMap(configuration => configuration.directory.files.map(file => file.relativePath)));
              const selectedFiles = selected.directory.files.map(file => file.relativePath);
              selectedRelativePaths = selectedFiles.filter(path => !shared.has(path));
              projectorRelativePaths = selectedFiles.filter(path => shared.has(path) && isProjector({ path }));
              affectedVariants = siblings.length;
            } else {
              projectorRelativePaths = files.filter(file => /\.gguf$/i.test(file.relativePath) && isProjector({ path: file.relativePath })).map(file => file.relativePath);
              selectedRelativePaths = files.filter(file => (file.relativePath === pendingName || /\.gguf$/i.test(file.relativePath)) && !projectorRelativePaths.includes(file.relativePath)).map(file => file.relativePath);
            }
            break;
          }
          case 'hugging-face': case 'host': {
            if (!directory) {
              throw new LlamaCppBrowserError({ code: 'missing-model' });
            }
            projectorRelativePaths = directory.projectorFile ? [directory.projectorFile.relativePath] : [];
            selectedRelativePaths = directory.files.filter(file => !projectorRelativePaths.includes(file.relativePath)).map(file => file.relativePath);
            affectedVariants = Math.max(0, (await repositoryDirectories({ repository: location.repository, destination: repositoryDestination({ location }), signal })).length - 1);
            break;
          }
          default: {
            const exhaustive: never = location;
            throw new Error(String(exhaustive));
          }
          }
          signal?.throwIfAborted();
          return captureRemovalPlans({ target: { kind: 'model', modelId, location }, root, selectedRelativePaths, projectorRelativePaths, affectedVariants });
        },
      });
    },
  });
}

export async function prepareRepositoryRemoval({ location, signal }: { location: RepositoryLocation, signal: AbortSignal | undefined }): Promise<ModelRemovalRequest> {
  location = repositoryLocationSchema.parse(location);
  return withModelMutationLock({
    operation: () => withRemovalLocationLock({
      location,
      operation: async () => {
        signal?.throwIfAborted();
        const root = await captureRoot({ location });
        let journal: DownloadJournal | undefined;
        try {
          journal = await readJournal({ folder: root.folder });
        } catch (error) {
          if (!isMissing({ error })) {
            throw error;
          }
        }
        let selectedRelativePaths: string[];
        let projectorRelativePaths: string[] = [];
        if (journal) {
          if (journal.selection.repository !== location.repository) {
            throw new Error('Download journal repository mismatch');
          }
          switch (location.kind) {
          case 'host': {
            for (let index = 0; index < journal.selection.files.length; index++) {
              if (!journal.reused?.[index]) {
                await hostDownloadMarker({ folder: root.folder, selection: journal.selection, index, action: 'check' });
              }
            }
            break;
          }
          case 'hugging-face': break;
          default: {
            const exhaustive: never = location;
            throw new Error(String(exhaustive));
          }
          }
          selectedRelativePaths = ownedDownloadPaths({ location, journal });
        } else {
          const directory = selectRepositoryModel({ models: await repositoryDirectories({ repository: location.repository, destination: repositoryDestination({ location }), signal }), repository: location.repository, variant: undefined });
          projectorRelativePaths = directory.projectorFile ? [directory.projectorFile.relativePath] : [];
          selectedRelativePaths = directory.files.filter(file => !projectorRelativePaths.includes(file.relativePath)).map(file => file.relativePath);
        }
        signal?.throwIfAborted();
        return captureRemovalPlans({ target: { kind: 'repository', location, journal }, root, selectedRelativePaths, projectorRelativePaths, affectedVariants: 0 });
      },
    }),
  });
}

export async function removeStoredModel({ plan }: { plan: DeletionPlan }): Promise<DeletionResult> {
  plan = deletionPlanSchema.parse(plan);
  return withRemovalLocationLock({
    location: plan.target.location,
    operation: async () => {
      const location = plan.target.location;
      switch (location.kind) {
      case 'host': case 'hugging-face': return deleteRepository({ repository: location.repository, plan, destination: repositoryDestination({ location }) });
      case 'opfs-user': {
        const result = await executeDeletionPlan({ folder: plan.folder, files: plan.files, selectedRelativePaths: plan.selectedRelativePaths });
        switch (result) {
        case 'deleted': await pruneCapturedModelRoot({ plan });
          return result;
        case 'changed': return result;
        default: {
          const exhaustive: never = result;
          throw new Error(String(exhaustive));
        }
        }
      }
      default: {
        const exhaustive: never = location;
        throw new Error(String(exhaustive));
      }
      }
    },
  });
}

export const TEST_ONLY = {
};
