// eslint-disable-next-line local-rules-imports/prefer-root-alias-imports -- Build configuration consumes model schemas before Vite aliases exist.
import { isModelSourceSegment, modelSourceRepositorySchema } from '../../../01-models/llama-cpp-browser-model-launch';

/** A temporary ID names the current entry, not a permanent file identity.
 * Persisted DTO/RPC references intentionally survive reloads unchanged: they may
 * be missing or resolve to different files registered under the same name.
 * Do not migrate, invalidate, reserve old names or require reconfirmation merely
 * because a reference uses temp/. Only live directory names need disambiguation. */
export function temporaryModelReference({ rootName, repository, modelPath }: {
  rootName: string, repository: string | undefined, modelPath: string | undefined,
}): string {
  if (!isModelSourceSegment({ name: rootName }) || rootName.startsWith('.') || rootName.includes(':')) {
    throw new Error('Invalid temporary model directory');
  }
  if (repository !== undefined) {
    modelSourceRepositorySchema.parse(repository);
    if (modelPath === undefined) {
      throw new Error('A temporary repository model needs a file selector');
    }
  }
  if (modelPath !== undefined && (!modelPath.split('/').every(name => isModelSourceSegment({ name })) || !/\.gguf$/i.test(modelPath))) {
    throw new Error('Invalid temporary model path');
  }
  const name = `temp/${rootName}${repository === undefined ? '' : `/${repository}`}${modelPath === undefined ? '' : `:${encodeURIComponent(modelPath)}`}`;
  if (name.length > 1024 || name.includes('\x7f')) {
    throw new Error('Invalid temporary model reference');
  }
  return name;
}

export function parseTemporaryModelReference({ name }: { name: string }): {
  rootName: string, repository: string | undefined, modelPath: string | undefined,
} {
  const match = /^temp\/([^/:]+)(?:\/([^/:]+\/[^/:]+))?(?::(.+))?$/.exec(name);
  if (!match) {
    throw new Error('Invalid temporary model reference');
  }
  const rootName = match[1]!;
  const repository = match[2];
  const modelPath = match[3] === undefined ? undefined : decodeURIComponent(match[3]);
  if (temporaryModelReference({ rootName, repository, modelPath }) !== name) {
    throw new Error('Non-canonical temporary model reference');
  }
  return { rootName, repository, modelPath };
}

export function isTemporaryModelReference({ name }: { name: string }): boolean {
  try {
    parseTemporaryModelReference({ name });
    return true;
  } catch {
    return false;
  }
}

export const TEST_ONLY = {
};
