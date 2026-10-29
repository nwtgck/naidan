import type { StorageType } from '@/01-models/types';
import { normalizePath } from './path';

/** Match VFS mount replacement before opening sources or issuing access grants. */
export function getEffectiveWeshMounts<T extends { path: string }>({ mounts }: { mounts: readonly T[] }): T[] {
  return [...new Map(mounts.map(mount => [normalizePath({ cwd: '/', path: mount.path }), mount])).values()];
}

export function shouldIncludeWritableTmpMount({
  storageType,
}: {
  storageType: StorageType,
}): boolean {
  switch (storageType) {
  case 'opfs':
    return true;
  case 'local':
  case 'memory':
    return false;
  default: {
    const _ex: never = storageType;
    throw new Error(`Unhandled storage type: ${String(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
