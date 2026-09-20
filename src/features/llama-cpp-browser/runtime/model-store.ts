import { OPFS_MODELS_DIR } from '@/constants';
import { isProjector } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { deletionPlanSchema, executeDeletionPlan, scanDeletionTree, type DeletionPlan, type DeletionResult } from './deletion-plan';
import { listHuggingFaceModels, withRepositoryLock, resolveRepositoryModel, parseModelReference, readJournal, repositoryDirectories } from '@/features/llama-cpp-browser/hugging-face/storage';
import { pendingName } from '@/features/llama-cpp-browser/hugging-face/types';
import { allowedModelDirectory, describeDirectory, opfsRoot, resolveDirectory, importModelDirectory, userModelDirectory, validSegment, type ModelDirectory } from './model-directory';
import { LlamaCppBrowserError, type LocalModel, type Progress } from "@/features/llama-cpp-browser/types";
import { logDiagnostic } from "@/features/llama-cpp-browser/debug-log";

const lockName = "naidan-llama-cpp-browser-model-store";
const mutationLockName = "naidan-llama-cpp-browser-model-mutation";

function isMissing({ error }: { error: unknown }): boolean {
  return error instanceof DOMException && (error.name === "NotFoundError" || error.name === "TypeMismatchError");
}
function userModelName({ id }: { id: string }): string {
  const parts = id.split('/');
  if (parts.length !== 2 || parts[0] !== 'user' || !allowedModelDirectory({ name: parts[1]! })) throw new LlamaCppBrowserError({ code: 'missing-model' });
  return parts[1]!;
}
export async function withModelStoreLock<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
  if (!navigator.locks) throw new LlamaCppBrowserError({ code: "unavailable" });
  return navigator.locks.request(lockName, operation);
}
export async function withModelMutationLock<T>({ operation }: { operation: () => Promise<T> }): Promise<T> {
  if (!navigator.locks) throw new LlamaCppBrowserError({ code: 'unavailable' });
  return navigator.locks.request(mutationLockName, operation);
}
export async function listStoredModels(): Promise<LocalModel[]> {
  const root = await userModelDirectory(); const result: LocalModel[] = [];
  for await (const [name, folder] of root.entries()) {
    if (folder.kind !== 'directory' || !allowedModelDirectory({ name })) continue;
    try {
      const model = describeDirectory({ directory: await resolveDirectory({ folder, id: `user/${name}`, name }) });
      result.push({ ...model, name: `user/${name}` });
    } catch (error) {
      if (!(error instanceof LlamaCppBrowserError) && !isMissing({ error })) throw error;
    }
  }
  result.push(...await listHuggingFaceModels());
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
export async function importStoredModel({ file, onProgress }: { file: File, onProgress: ({ progress }: { progress: Progress }) => void }): Promise<LocalModel> {
  if (!/^.+\.gguf$/i.test(file.name) || !validSegment({ name: file.name })) throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  const started = performance.now();
  logDiagnostic({ diagnostic: { event: 'import-start', bytes: file.size } });
  const model = await importModelDirectory({ signal: undefined, directory: { name: `${file.name.slice(0, -5)}-GGUF`, files: [{ path: file.name, file }] }, onProgress });
  logDiagnostic({ diagnostic: { event: 'import-complete', bytes: model.size, elapsedMs: performance.now() - started } });
  return model;
}
function includeSharedProjector({ choice }: { choice: 'include' | 'keep' | undefined }): boolean {
  switch (choice) {
  case 'include': case undefined: return true;
  case 'keep': return false;
  default: { const exhaustive: never = choice; throw new Error(String(exhaustive)); }
  }
}
async function removalTarget({ id, sharedProjector }: { id: string, sharedProjector: 'include' | 'keep' | undefined }): Promise<{ parent: FileSystemDirectoryHandle, name: string, folder: FileSystemDirectoryHandle, selectedPaths: string[] | undefined, projectors: string[], affectedVariants: number }> {
  let parent: FileSystemDirectoryHandle; let name: string; let selectedPaths: string[] | undefined; let projectors: string[] = []; let affectedVariants = 0;
  if (id.startsWith('hf.co/')) {
    const { repository, variant } = parseModelReference({ name: id });
    parent = await opfsRoot();
    for (const segment of [OPFS_MODELS_DIR, 'huggingface.co', ...repository.split('/'), 'resolve']) parent = await parent.getDirectoryHandle(segment);
    name = 'main'; const folder = await parent.getDirectoryHandle(name);
    let pending;
    if (variant === undefined) {
      try {
        pending = await readJournal({ folder });
      } catch (error) {
        if (!isMissing({ error })) throw error;
      }
    }
    if (pending) {
      selectedPaths = [pendingName, ...pending.selection.files.filter((_file, index) => !pending.reused?.[index]).map(file => file.path)];
    } else {
      const directory = await resolveRepositoryModel({ name: id });
      projectors = directory.projectorPath ? [directory.projectorPath] : [];
      selectedPaths = directory.files.filter(file => !projectors.includes(file.path)).map(file => file.path);
      affectedVariants = Math.max(0, (await repositoryDirectories({ repository })).length - 1);
    }
  } else {
    name = userModelName({ id });
    parent = await userModelDirectory();
    const files = (await scanDeletionTree({ folder: await parent.getDirectoryHandle(name) })).files;
    projectors = files.filter(file => /\.gguf$/i.test(file.path) && isProjector({ path: file.path })).map(file => file.path);
    // User model directories can also contain another engine's artifacts.
    // Select GGUF files and our transient marker; shared metadata is not ours.
    selectedPaths = files.filter(file => (file.path === pendingName || /\.gguf$/i.test(file.path)) && !projectors.includes(file.path)).map(file => file.path);
  }
  if (includeSharedProjector({ choice: sharedProjector })) selectedPaths?.push(...projectors);
  return { parent, name, folder: await parent.getDirectoryHandle(name), selectedPaths, projectors, affectedVariants };
}
async function withRemovalRepositoryLock<T>({ id, operation }: { id: string, operation: () => Promise<T> }): Promise<T> {
  return id.startsWith('hf.co/') ? withRepositoryLock({ repository: parseModelReference({ name: id }).repository, operation }) : operation();
}
export type ModelRemovalRequest = { plan: DeletionPlan, sharedPlan: DeletionPlan | undefined, affectedVariants: number };
export async function prepareModelRemoval({ id }: { id: string }): Promise<ModelRemovalRequest> {
  return withModelMutationLock({ operation: () => withRemovalRepositoryLock({ id, operation: async () => {
    const { folder, selectedPaths, projectors, affectedVariants } = await removalTarget({ id, sharedProjector: 'include' });
    const { files } = await scanDeletionTree({ folder });
    const selected = selectedPaths ? files.filter(file => selectedPaths.includes(file.path)) : files;
    const plan = deletionPlanSchema.parse({ id, sharedProjector: projectors.length ? 'keep' : undefined, files: selected.filter(file => !projectors.includes(file.path)) });
    const sharedPlan = projectors.length ? deletionPlanSchema.parse({ id, sharedProjector: 'include', files: selected }) : undefined;
    return { plan, sharedPlan, affectedVariants };
  } }) });
}
export async function planStoredModelRemoval({ id }: { id: string }): Promise<DeletionPlan> {
  const request = await prepareModelRemoval({ id }); return request.sharedPlan ?? request.plan;
}
export async function removeStoredModel({ plan }: { plan: DeletionPlan }): Promise<DeletionResult> {
  plan = deletionPlanSchema.parse(plan);
  return withRemovalRepositoryLock({ id: plan.id, operation: async () => {
    const { parent, name, folder, selectedPaths } = await removalTarget({ id: plan.id, sharedProjector: plan.sharedProjector });
    const result = await executeDeletionPlan({ folder, plan, selectedPaths });
    switch (result) {
    case 'changed': return result;
    case 'deleted': break;
    default: { const exhaustive: never = result; throw new Error(String(exhaustive)); }
    }
    try {
      await parent.getDirectoryHandle(name); await parent.removeEntry(name);
    } catch (error) {
      if (!(error instanceof DOMException && ['NotFoundError', 'InvalidModificationError', 'TypeMismatchError'].includes(error.name))) throw error;
    }
    return result;
  } });
}
export async function storedModelDirectory({ name }: { name: string }): Promise<ModelDirectory> {
  if (name.startsWith('hf.co/')) return resolveRepositoryModel({ name });
  const directory = userModelName({ id: name });
  try {
    const folder = await (await userModelDirectory()).getDirectoryHandle(directory);
    return await resolveDirectory({ folder, id: name, name: directory });
  } catch (error) {
    if (isMissing({ error })) throw new LlamaCppBrowserError({ code: 'missing-model' });
    throw error;
  }
}

export const TEST_ONLY = {
};
