import { isModelSourceSegment, modelSourceRepositorySchema } from '@/01-models/llama-cpp-browser-model-launch';
import { temporaryModelRootPath, parseTemporaryModelRootPath } from '@/01-models/temporary-model-files';

/** A temporary ID names the current entry, not a permanent file identity.
 * Persisted DTO/RPC references intentionally survive reloads unchanged: they may
 * be missing or resolve to different files registered under the same name.
 * Do not migrate, invalidate, reserve old names or require reconfirmation merely
 * because a reference uses temp/. Only live directory names need disambiguation. */
export function temporaryModelReference({ rootName, repository, selector }: {
  rootName: string, repository: string | undefined, selector: string | undefined,
}): string {
  const rootPath = temporaryModelRootPath({ rootName });
  if (repository !== undefined) {
    modelSourceRepositorySchema.parse(repository);
    if (selector === undefined) {
      throw new Error('A temporary repository model needs a file selector');
    }
  }
  if (selector !== undefined && !selector.split('/').every(name => isModelSourceSegment({ name }))) {
    throw new Error('Invalid temporary model selector');
  }
  const modelId = `${rootPath}${repository === undefined ? '' : `/${repository}`}${selector === undefined ? '' : `:${selector}`}`;
  if (modelId.length > 1024 || modelId.includes('\x7f')) {
    throw new Error('Invalid temporary model reference');
  }
  return modelId;
}

export function parseTemporaryModelReference({ modelId }: { modelId: string }): {
  rootName: string, repository: string | undefined, selector: string | undefined,
} {
  const selectorStart = modelId.indexOf(':');
  const path = selectorStart < 0 ? modelId : modelId.slice(0, selectorStart);
  const parts = path.split('/');
  const { rootName } = parseTemporaryModelRootPath({ rootPath: parts.slice(0, 2).join('/') });
  const repository = parts.length > 2 ? parts.slice(2).join('/') : undefined;
  const selector = selectorStart < 0 ? undefined : modelId.slice(selectorStart + 1);
  if (temporaryModelReference({ rootName, repository, selector }) !== modelId) {
    throw new Error('Non-canonical temporary model reference');
  }
  return { rootName, repository, selector };
}

export function isTemporaryModelReference({ modelId }: { modelId: string }): boolean {
  try {
    parseTemporaryModelReference({ modelId });
    return true;
  } catch {
    return false;
  }
}

export const TEST_ONLY = {
};
