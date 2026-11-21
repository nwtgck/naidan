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
  // Punctuation is part of the saved identity: ignoring it here can make an
  // existing modelId resolve to a different file in the same repository.
  while (prefix) {
    const remainder = stem.slice(prefix.length);
    const continuesVersion = /\d$/.test(prefix) && /^\.\d/.test(remainder);
    if (stem.toLowerCase().startsWith(prefix.toLowerCase()) && /^[-_.]/.test(remainder) && !continuesVersion) {
      return remainder.slice(1);
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

function comparableModelName({ name, owner }: { name: string, owner: string }): string {
  let modelName = name.toLowerCase();
  const publisher = owner.toLowerCase();
  if (modelName.startsWith(publisher + '-') || modelName.startsWith(publisher + '_')) {
    modelName = modelName.slice(publisher.length + 1);
  }
  return modelName.replace(/[-_]\d+(?:\.\d+)?gi?b$/, '').replace(/[-_]/g, '');
}

function compactRepositoryVariant({ repository, path, label }: { repository: string, path: string, label: string }): string {
  const [owner = '', repoName] = repository.split('/');
  if (repoName === undefined) {
    return label;
  }
  const slash = label.lastIndexOf('/');
  const directory = label.slice(0, slash + 1);
  const variant = label.slice(slash + 1);
  // These annotations repeat information already present in the quantization.
  const compactVariant = variant
    .replace(/^Unsloth[-_](?=UD[-_])/i, '')
    .replace(/^KQuant[-_]\d+(?:\.\d+)?Gi?B[-_](?=Q[1-8]_K(?:_|$))/i, '');
  if (compactVariant !== variant) {
    return directory + compactVariant;
  }
  const stem = path.slice(path.lastIndexOf('/') + 1).replace(/(?:-\d{5}-of-\d{5})?\.gguf$/i, '');
  const quantization = /[-_.]((?:(?:UD|QAD|QAT)[-_])?(?:(?:I?Q|PQ|P?TQ)[1-8](?:_[A-Z0-9]+)+|(?:MXFP|NVFP)[0-9]+|BF16|F16|F32))$/i.exec(stem);
  if (quantization === null) {
    return label;
  }
  const fileModelName = stem.slice(0, quantization.index);
  const repositoryName = repoName.replace(/[-_.]gguf$/i, '');
  const comparableRepository = comparableModelName({ name: repositoryName, owner });
  const matches = ({ name }: { name: string }) => comparableModelName({ name, owner }) === comparableRepository;
  // A file can spell out a parameter count that its repository leaves implicit.
  // Compare the full names first and retain explicitly different model sizes.
  const parameterCount = /[-_]\d+(?:\.\d+)?[MB](?=[-_]|$)/i;
  const nameMatches = matches({ name: fileModelName })
    || (!parameterCount.test(repositoryName) && matches({ name: fileModelName.replace(parameterCount, '') }));
  return nameMatches ? directory + quantization[1]! : label;
}

/** Split files form one model; their count is not part of its public modelId variant. */
export function modelVariantName({ repository, path }: { repository: string, path: string }): string {
  const label = variantLabel({ repository, path });
  const name = compactRepositoryVariant({ repository, path, label });
  // Degenerate stems such as '.gguf' must still have a routable selector.
  return name.split('/').every(name => isModelSourceSegment({ name })) ? name : path;
}

type RepositoryModelSource = { kind: 'hugging-face' } | { kind: 'host', alias: string };

function isRepositoryPath({ repository }: { repository: string }): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository) && repository.split('/').every(name => isModelSourceSegment({ name }));
}

export function formatRepositoryModelId({ source, repository, mainFilePath }: { source: RepositoryModelSource, repository: string, mainFilePath: string }): string {
  if (!isRepositoryPath({ repository })
      || !mainFilePath.split('/').every(name => isModelSourceSegment({ name }))
      || !/\.gguf$/i.test(mainFilePath)) {
    throw new Error('Invalid model source path');
  }
  let root: string;
  switch (source.kind) {
  case 'hugging-face': root = 'hf.co';
    break;
  case 'host': root = `host/${encodeURIComponent(source.alias)}`;
    break;
  default: throw new Error(String(source satisfies never));
  }
  return `${root}/${repository}:${modelVariantName({ repository, path: mainFilePath })}`;
}

/** Derive the saved, user-visible selection without requiring installed files. */
export function formatHuggingFaceModelId({ repository, mainFilePath }: { repository: string, mainFilePath: string }): string {
  return formatRepositoryModelId({ source: { kind: 'hugging-face' }, repository, mainFilePath });
}

/** Use the same transformation for listing and selection. The caller handles
 * an absent or ambiguous match before opening any files. */
export function matchingRepositoryModelVariants<Model extends { primaryFile: { relativePath: string } }>({ models, repository, variant }: {
  models: Model[], repository: string, variant: string | undefined,
}): Model[] {
  return variant === undefined ? models : models.filter(model => modelVariantName({ repository, path: model.primaryFile.relativePath }) === variant);
}

function splitModelIdVariant({ modelId }: { modelId: string }): { address: string, variant: string | undefined } {
  const colon = modelId.indexOf(':');
  return { address: colon === -1 ? modelId : modelId.slice(0, colon), variant: colon === -1 ? undefined : modelId.slice(colon + 1) };
}

export function splitModelIdDisplay({ modelId }: { modelId: string }): { source: string, name: string, variant: string | undefined } {
  // Users read and copy model IDs. Display everything after the first colon
  // verbatim so the option matches the copied ID. Keep IDs concise and
  // unambiguous where they are created. Breaking changes can invalidate saved
  // selections and require explicit approval from the Naidan repository owner.
  const { address, variant } = splitModelIdVariant({ modelId });
  const slash = address.lastIndexOf('/');
  return { source: address.slice(0, slash + 1), name: address.slice(slash + 1), variant };
}

export function parseRepositoryModelId({ modelId }: { modelId: string }): {
  source: RepositoryModelSource, repository: string, variant: string | undefined,
} {
  const { address, variant } = splitModelIdVariant({ modelId });
  const [prefix, ...segments] = address.split('/');
  let source: RepositoryModelSource;
  switch (prefix) {
  case 'hf.co': source = { kind: 'hugging-face' };
    break;
  case 'host': {
    const encoded = segments.shift();
    if (!encoded) {
      throw new Error('Missing linked model folder');
    }
    const alias = decodeURIComponent(encoded);
    if (encodeURIComponent(alias) !== encoded) {
      throw new Error('Non-canonical linked model folder');
    }
    source = { kind: 'host', alias };
    break;
  }
  default: throw new Error('Unknown model source');
  }
  const repository = segments.join('/');
  if (!isRepositoryPath({ repository }) || (variant !== undefined && !variant.split('/').every(name => isModelSourceSegment({ name })))) {
    throw new Error('Invalid model reference');
  }
  return { source, repository, variant };
}

export const TEST_ONLY = {
};
