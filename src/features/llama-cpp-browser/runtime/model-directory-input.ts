import { directoryForGgufFile } from '@/logic/model-directory-input';
import { isModelSourceSegment } from '@/01-models/llama-cpp-browser-model-id';
import { LlamaCppBrowserError, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';

export const modelImportPendingName = '.llama-cpp-import-pending';

/** A loose GGUF has the same model-directory shape regardless of its lifetime. */
export function directoryForModelFile({ file }: { file: File }): ModelDirectoryInput {
  try {
    return directoryForGgufFile({ file });
  } catch {
    throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  }
}

/** These tree invariants deliberately apply to both saved and temporary imports.
 * Storage writes, collision policy and model grouping do not belong here. */
export function normalizeModelDirectoryInput({ directory }: { directory: ModelDirectoryInput }): ModelDirectoryInput {
  const parsed = directory;
  const rootName = parsed.rootName.replaceAll(':', '_');
  if (!isModelSourceSegment({ name: rootName }) || rootName.startsWith('.') || parsed.files.length === 0) {
    throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  }
  const paths = new Set<string>();
  for (const { relativePath } of parsed.files) {
    if (!relativePath.split('/').every(name => isModelSourceSegment({ name })) || relativePath.split('/')[0] === modelImportPendingName || paths.has(relativePath)) {
      throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    }
    paths.add(relativePath);
  }
  for (const path of paths) {
    const parts = path.split('/');
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join('/'))) {
        throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
      }
      parts.pop();
    }
  }
  return { rootName, files: parsed.files };
}

export const TEST_ONLY = {
};
