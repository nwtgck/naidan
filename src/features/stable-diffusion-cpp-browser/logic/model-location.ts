import type { BrowserImageModelLocation } from '@/01-models/types';
import { modelFileLocation } from '@/logic/model-file-system';
import type { HostImageRepositorySource } from './repository-store';

/** One source classification for UI, history and RPC. A temp repository is not
 * OPFS merely because it lacks a host handle. IDs are produced by the registry. */
export function imageModelLocation({ repositoryKey, hostSource, relativePath }: { repositoryKey: string, hostSource: HostImageRepositorySource | undefined, relativePath: string }): BrowserImageModelLocation {
  return modelFileLocation({ repositoryKey, hostSource, relativePath });
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
