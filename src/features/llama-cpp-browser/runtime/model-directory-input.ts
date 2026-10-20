import { isModelSourceSegment } from '@/01-models/llama-cpp-browser-model-launch';
import { LlamaCppBrowserError, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';

export const modelImportPendingName = '.llama-cpp-import-pending';

/** A loose GGUF has the same model-directory shape regardless of its lifetime. */
export function directoryForModelFile({ file }: { file: File }): ModelDirectoryInput {
  if (!/^.+\.gguf$/i.test(file.name) || !isModelSourceSegment({ name: file.name })) {
    throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  }
  return { name: `${file.name.slice(0, -5)}-GGUF`, files: [{ path: file.name, file }] };
}

/** These tree invariants deliberately apply to both saved and temporary imports.
 * Storage writes, collision policy and model grouping do not belong here. */
export function normalizeModelDirectoryInput({ directory }: { directory: ModelDirectoryInput }): ModelDirectoryInput {
  const parsed = directory;
  const name = parsed.name.replaceAll(':', '_');
  if (!isModelSourceSegment({ name }) || name.startsWith('.') || parsed.files.length === 0) {
    throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
  }
  const paths = new Set<string>();
  for (const { path } of parsed.files) {
    if (!path.split('/').every(name => isModelSourceSegment({ name })) || path.split('/')[0] === modelImportPendingName || paths.has(path)) {
      throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    }
    paths.add(path);
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
  return { name, files: parsed.files };
}

export const TEST_ONLY = {
};
