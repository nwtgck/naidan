export function isModelSourceSegment({ name }: { name: string }): boolean {
  return name.length > 0 && name !== '.' && name !== '..'
    && !/[\\/]/.test(name)
    && !Array.from(name).some(character => character.charCodeAt(0) < 32)
    && new TextEncoder().encode(name).length <= 255;
}

const localRepositoryPrefixes = { pending: '~user', saved: 'user' } as const;

/** Classify llama.cpp public references; other endpoints own their ID formats. */
export function localRepositoryReferenceStorage({ modelId }: { modelId: string }): 'pending' | 'saved' | undefined {
  const separator = modelId.indexOf('/');
  if (separator < 0) {
    return undefined;
  }
  const prefix = modelId.slice(0, separator);
  switch (prefix) {
  case localRepositoryPrefixes.pending: return 'pending';
  case localRepositoryPrefixes.saved: return 'saved';
  default: return undefined;
  }
}

/** Routing check only; parse the complete reference before resolving files. */
export function hasLocalRepositoryReferencePrefix({ modelId, storage }: { modelId: string, storage: 'pending' | 'saved' | undefined }): boolean {
  switch (storage) {
  case 'pending': return modelId.startsWith(`${localRepositoryPrefixes.pending}/`);
  case 'saved': return modelId.startsWith(`${localRepositoryPrefixes.saved}/`);
  case undefined: return localRepositoryReferenceStorage({ modelId }) !== undefined;
  default: {
    const exhaustive: never = storage;
    throw new Error(String(exhaustive));
  }
  }
}

/** File identity stays in its captured source, never in the public reference. */
export function localRepositoryReference({ storage, rootName, selector }: {
  storage: 'pending' | 'saved', rootName: string, selector: string | undefined,
}): string {
  if (!isModelSourceSegment({ name: rootName }) || rootName.startsWith('.')
    || (selector !== undefined && !selector.split('/').every(name => isModelSourceSegment({ name })))) {
    throw new Error('Invalid local repository reference');
  }
  let prefix: string;
  switch (storage) {
  case 'pending': prefix = localRepositoryPrefixes.pending;
    break;
  case 'saved': prefix = localRepositoryPrefixes.saved;
    break;
  default: {
    const exhaustive: never = storage;
    throw new Error(String(exhaustive));
  }
  }
  return `${prefix}/${rootName}${selector === undefined ? '' : `/${selector}`}`;
}

export function parseLocalRepositoryReference({ modelId }: { modelId: string }): {
  storage: 'pending' | 'saved', rootName: string, selector: string | undefined,
} {
  const storage = localRepositoryReferenceStorage({ modelId });
  const [, rootName, ...parts] = modelId.split('/');
  if (storage === undefined || !rootName) {
    throw new Error('Invalid local repository reference');
  }
  const selector = parts.length ? parts.join('/') : undefined;
  if (localRepositoryReference({ storage, rootName, selector }) !== modelId) {
    throw new Error('Non-canonical local repository reference');
  }
  return { storage, rootName, selector };
}

export function withoutRepositoryPrefix({ repository, stem }: { repository: string, stem: string }): string {
  let prefix = repository.split('/').at(-1)!.replace(/[-_.]gguf$/i, '');
  // Repository names can have extra model descriptors. Match whole hyphen-delimited
  // components so dotted versions and unknown variant modifiers remain intact.
  while (prefix) {
    const remainder = stem.slice(prefix.length);
    const continuesVersion = /\d$/.test(prefix) && /^\.\d/.test(remainder);
    if (stem.toLowerCase().startsWith(prefix.toLowerCase()) && /^[-_.]/.test(remainder) && !continuesVersion) {
      return stem.slice(prefix.length + 1);
    }
    prefix = prefix.slice(0, Math.max(0, prefix.lastIndexOf('-')));
  }
  return stem;
}

/** Labels depend only on the repository and group path, never on its siblings. */
export function variantLabel({ repository, path }: { repository: string, path: string }): string {
  const parts = path.split('/');
  const filename = parts.pop()!;
  const stem = withoutRepositoryPrefix({ repository, stem: filename.replace(/(?:-\d{5}-of-\d{5})?\.gguf$/i, '') });
  // Common repositories repeat the variant in its containing directory.
  // Keep meaningful ancestors such as 'imatrix' and unknown variant modifiers.
  while (parts.length && withoutRepositoryPrefix({ repository, stem: parts.at(-1)! }).toLowerCase() === stem.toLowerCase()) {
    parts.pop();
  }
  return [...parts, stem].join('/');
}

/** Split files form one model; their count is not part of its public modelId variant. */
export function modelVariantName({ repository, path }: { repository: string, path: string }): string {
  const name = variantLabel({ repository, path });
  // Degenerate stems such as '.gguf' must still have a routable selector.
  return name.split('/').every(name => isModelSourceSegment({ name })) ? name : path;
}

/** Derive the saved, user-visible selection without requiring installed files. */
export function formatHuggingFaceModelId({ repository, mainFilePath }: { repository: string, mainFilePath: string }): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)
      || !repository.split('/').every(name => isModelSourceSegment({ name }))
      || !mainFilePath.split('/').every(name => isModelSourceSegment({ name }))
      || !/\.gguf$/i.test(mainFilePath)) {
    throw new Error('Invalid model source path');
  }
  return `hf.co/${repository}:${modelVariantName({ repository, path: mainFilePath })}`;
}

export const TEST_ONLY = {
};
