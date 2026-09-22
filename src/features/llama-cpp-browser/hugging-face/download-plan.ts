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

export function formatDownloadBytes({ bytes }: { bytes: number }): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export const TEST_ONLY = {
};
