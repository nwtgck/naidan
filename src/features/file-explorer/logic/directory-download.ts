import type { DirectoryDownloadExclusion, DirectoryDownloadSuggestion } from './types';

export function isSafeDirectoryDownloadPathSegment({ name }: { name: string }): boolean {
  return name !== ''
    && name !== '.'
    && name !== '..'
    && !name.includes('/')
    && !name.includes('\\')
    && !name.includes('\0');
}

export function normalizeDirectoryDownloadRelativePath({ path }: { path: string }): string | undefined {
  if (path.startsWith('/')) {
    return undefined;
  }

  const normalizedSegments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      return undefined;
    }
    if (!isSafeDirectoryDownloadPathSegment({ name: segment })) {
      return undefined;
    }
    normalizedSegments.push(segment);
  }
  return normalizedSegments.length > 0 ? normalizedSegments.join('/') : undefined;
}

export function isDirectoryDownloadPathExcluded({
  relativePath,
  excludedRelativePaths,
}: {
  relativePath: string,
  excludedRelativePaths: ReadonlySet<string>,
}): boolean {
  let current = relativePath;
  while (current.length > 0) {
    if (excludedRelativePaths.has(current)) {
      return true;
    }
    const slashIndex = current.lastIndexOf('/');
    if (slashIndex < 0) {
      return false;
    }
    current = current.slice(0, slashIndex);
  }
  return false;
}

export function addDirectoryDownloadExclusion({
  exclusions,
  suggestion,
}: {
  exclusions: readonly DirectoryDownloadExclusion[],
  suggestion: DirectoryDownloadSuggestion,
}): DirectoryDownloadExclusion[] {
  const relativePath = normalizeDirectoryDownloadRelativePath({ path: suggestion.relativePath });
  if (relativePath === undefined) {
    return [...exclusions];
  }

  const existingPaths = new Set(exclusions.map(exclusion => exclusion.relativePath));
  if (isDirectoryDownloadPathExcluded({ relativePath, excludedRelativePaths: existingPaths })) {
    return [...exclusions];
  }

  return [
    ...exclusions.filter(exclusion => !exclusion.relativePath.startsWith(`${relativePath}/`)),
    {
      relativePath,
      name: suggestion.name,
      kind: suggestion.kind,
    },
  ];
}
