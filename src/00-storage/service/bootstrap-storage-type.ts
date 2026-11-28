import type { StorageType } from '@/01-models/types';
import { localStorageFormat } from '@/00-format/01-layout/layout';

export function readStoredBootstrapStorageType(): ReturnType<typeof localStorageFormat.storageType.read> {
  return localStorageFormat.storageType.read({ storage: typeof localStorage === 'undefined' ? undefined : localStorage });
}

export function writeStoredBootstrapStorageType({ type }: { type: StorageType }): void {
  if (typeof localStorage !== 'undefined') {
    localStorageFormat.storageType.write({ storage: localStorage, type });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
