import { repositoryFileSchema, repositoryUrlPath, revisionSchema, type DownloadSelection, type RepositoryFile } from './types';

/** A normal anchor download, not a fetch-to-Blob or an OPFS import. */
export function fileDownloadUrl({ repository, revision, file }: { repository: string, revision: string, file: RepositoryFile }): string {
  const path = repositoryFileSchema.parse(file).path.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${repositoryUrlPath({ repository })}/resolve/${revisionSchema.parse(revision)}/${path}?download=true`;
}

export function selectionKey({ selection }: { selection: DownloadSelection }): string {
  // A key is an exact plan identity, NOT a bundled suggestion identity.
  return JSON.stringify([selection.repository, selection.revision, [...selection.files].sort((a, b) => a.path.localeCompare(b.path)).map(file => [file.path, file.size])]);
}

export { formatDownloadBytes } from './presentation';

export const TEST_ONLY = {
};
