import { parseGgufSplitPath } from '@/utils/gguf-file-paths';
import { rankedProjectors } from '@/features/llama-cpp-browser/hugging-face/presentation';
import { isProjector } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { LlamaCppBrowserError } from '@/features/llama-cpp-browser/types';

/** Select one complete weight group and the existing preferred companion. */
export function resolveModelFiles({ files }: { files: { relativePath: string }[] }): { primaryRelativePath: string, projectorRelativePath: string | undefined } {
  const projectors = rankedProjectors({ files: files.filter(entry => isProjector({ path: entry.relativePath })).map(entry => ({ path: entry.relativePath })) });
  const bases = files.filter(entry => !isProjector({ path: entry.relativePath }));
  if (bases.length === 0) {
    throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  }
  const first = bases[0]!;
  const split = parseGgufSplitPath({ relativePath: first.relativePath });
  if (!split) {
    if (bases.length !== 1) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    }
  } else {
    if (split.count < 1 || split.count !== bases.length) {
      throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    }
    const expected = new Set(Array.from({ length: split.count }, (_, index) => `${split.stem}-${String(index + 1).padStart(5, '0')}-of-${String(split.count).padStart(5, '0')}${split.extension}`));
    if (bases.some(entry => !expected.delete(entry.relativePath)) || expected.size) {
      throw new LlamaCppBrowserError({ code: 'invalid-gguf' });
    }
  }
  return { primaryRelativePath: first.relativePath, projectorRelativePath: projectors[0]?.path };
}

export const TEST_ONLY = {
};
