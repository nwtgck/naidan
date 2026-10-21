// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Build configuration consumes model schemas before Vite aliases exist.
import { isModelSourceSegment, modelSourceRepositorySchema } from '../../../01-models/llama-cpp-browser-model-launch';

/** A temporary ID names the current entry, not a permanent file identity.
 * Persisted DTO/RPC references intentionally survive reloads unchanged: they may
 * be missing or resolve to different files registered under the same name.
 * Do not migrate, invalidate, reserve old names or require reconfirmation merely
 * because a reference uses temp/. Only live directory names need disambiguation. */
export function temporaryModelReference({ rootName, repository, selector }: {
  rootName: string, repository: string | undefined, selector: string | undefined,
}): string {
  if (!isModelSourceSegment({ name: rootName }) || rootName.startsWith('.') || rootName.includes(':')) {
    throw new Error('Invalid temporary model directory');
  }
  if (repository !== undefined) {
    modelSourceRepositorySchema.parse(repository);
    if (selector === undefined) {
      throw new Error('A temporary repository model needs a file selector');
    }
  }
  if (selector !== undefined && !selector.split('/').every(name => isModelSourceSegment({ name }))) {
    throw new Error('Invalid temporary model selector');
  }
  const modelId = `temp/${rootName}${repository === undefined ? '' : `/${repository}`}${selector === undefined ? '' : `:${selector}`}`;
  if (modelId.length > 1024 || modelId.includes('\x7f')) {
    throw new Error('Invalid temporary model reference');
  }
  return modelId;
}

export function parseTemporaryModelReference({ modelId }: { modelId: string }): {
  rootName: string, repository: string | undefined, selector: string | undefined,
} {
  const match = /^temp\/([^/:]+)(?:\/([^/:]+\/[^/:]+))?(?::(.+))?$/.exec(modelId);
  if (!match) {
    throw new Error('Invalid temporary model reference');
  }
  const rootName = match[1]!;
  const repository = match[2];
  const selector = match[3];
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
