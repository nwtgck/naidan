import type { BrowserImageModelLocation } from '@/01-models/types';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { temporaryRootIdSchema } from '@/01-models/temporary-model-files';
import { OPFS_MODELS_DIR } from '@/constants';
import type { HostImageRepositorySource } from './repository-store';

/** One source classification for UI, history and RPC. A temp repository is not
 * OPFS merely because it lacks a host handle. IDs are produced by the registry. */
export function imageModelLocation({ repositoryId, hostSource, path }: { repositoryId: string, hostSource: HostImageRepositorySource | undefined, path: string }): BrowserImageModelLocation {
  if (hostSource) {
    return { kind: 'host', directoryId: toHostModelDirectoryId({ raw: hostSource.directoryId }), path: `${hostSource.repository}/${path}` };
  }
  if (repositoryId.startsWith('temp/')) {
    temporaryRootIdSchema.parse(repositoryId);
    return { kind: 'temp', path: `${repositoryId}/${path}` };
  }
  return { kind: 'opfs', path: `${OPFS_MODELS_DIR}/${repositoryId}/${path}` };
}

export function sameImageModelLocation({ left, right }: { left: BrowserImageModelLocation, right: BrowserImageModelLocation }): boolean {
  switch (left.kind) {
  case 'opfs': case 'temp': return right.kind === left.kind && right.path === left.path;
  case 'host': return right.kind === 'host' && right.directoryId === left.directoryId && right.path === left.path;
  default: {
    const exhaustive: never = left;
    throw new Error(String(exhaustive));
  }
  }
}

export const TEST_ONLY = {
};
