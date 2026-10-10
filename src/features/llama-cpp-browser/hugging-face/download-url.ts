import { repositoryFileSchema, repositoryUrlPath, revisionSchema, type RepositoryFile } from './types';

/** The pinned request URL, not a signed redirect URL or a download permission. */
export function modelDownloadUrl({ repository, revision, file }: { repository: string, revision: string, file: RepositoryFile }): string {
  const path = repositoryFileSchema.parse(file).path.split('/').map(encodeURIComponent).join('/');
  return `https://huggingface.co/${repositoryUrlPath({ repository })}/resolve/${revisionSchema.parse(revision)}/${path}`;
}

export const TEST_ONLY = {
};
