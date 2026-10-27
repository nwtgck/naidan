import { modelGroups, modelVariantName } from '@/features/llama-cpp-browser/hugging-face/model-variants';
import { LlamaCppBrowserError, type ModelDirectoryInput } from '@/features/llama-cpp-browser/types';
import { modelDirectory, type ModelDirectory, type ModelFile } from './model-directory';
import { localRepositoryInput } from './model-directory-input';

export type LocalRepositoryLayoutChoice = {
  layout: 'repository' | 'repositories' | 'owner-repositories', directories: ModelDirectoryInput[],
};

export function localRepositoryLayoutChoices({ directory }: { directory: ModelDirectoryInput }): LocalRepositoryLayoutChoice[] {
  return (['repository', 'repositories', 'owner-repositories'] as const).flatMap(layout => {
    try {
      const directories = localRepositoryInputs({ directory, layout });
      for (const repository of directories) {
        localRepositoryDirectories({ files: repository.files.map(file => ({ ...file, storageKind: 'temp', registrationRevision: 1 })) });
      }
      return directories.length ? [{ layout, directories }] : [];
    } catch {
      return [];
    }
  });
}

/** One interpretation is shared by File execution, copying and OPFS loading. */
export function localRepositoryDirectories({ files }: {
  files: ModelFile[],
}): { selector: string, directory: ModelDirectory }[] {
  const { models, projectors } = modelGroups({ files: files.filter(file => /\.gguf$/i.test(file.relativePath)) });
  const directories = models.map(model => modelDirectory({ files: [...model, ...projectors] }));
  if (!directories.length) {
    throw new LlamaCppBrowserError({ code: 'unsupported-input' });
  }
  const selectors = new Set<string>();
  return directories.map(directory => {
    // A collision can rename the pending or saved root. Derive identity only
    // from repo-relative paths, never a prefix shortened against that root.
    const selector = modelVariantName({ repository: '', path: directory.primaryFile.relativePath });
    if (selectors.has(selector)) {
      throw new LlamaCppBrowserError({ code: 'unsupported-input' });
    }
    selectors.add(selector);
    return { selector, directory };
  });
}

/** Explicit boundaries prevent companion files from crossing repositories.
 * A tree cannot reliably reveal whether children are repos or quantizations. */
export function localRepositoryInputs({ directory, layout }: {
  directory: ModelDirectoryInput, layout: 'repository' | 'repositories' | 'owner-repositories',
}): ModelDirectoryInput[] {
  directory = localRepositoryInput({ directory });
  let depth: number;
  switch (layout) {
  case 'repository': return [directory];
  case 'repositories': depth = 1;
    break;
  case 'owner-repositories': depth = 2;
    break;
  default: {
    const exhaustive: never = layout;
    throw new Error(String(exhaustive));
  }
  }
  const repositories = new Map<string, ModelDirectoryInput['files']>();
  for (const entry of directory.files) {
    const parts = entry.relativePath.split('/');
    if (parts.length <= depth) {
      if (/\.gguf$/i.test(entry.relativePath)) {
        throw new LlamaCppBrowserError({ code: 'unsupported-input' });
      }
      continue;
    }
    const prefix = parts.slice(0, depth).join('/');
    const files = repositories.get(prefix) ?? [];
    files.push({ relativePath: parts.slice(depth).join('/'), file: entry.file });
    repositories.set(prefix, files);
  }
  return [...repositories].map(([prefix, files]) => ({ rootName: prefix.split('/').at(-1)!, files }))
    .filter(repository => repository.files.some(entry => /\.gguf$/i.test(entry.relativePath) && !/mmproj/i.test(entry.relativePath.split('/').at(-1)!)));
}

export const TEST_ONLY = {
};
