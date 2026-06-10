import type { StorageType } from '@/models/types';

export function shouldIncludeWritableTmpMount({
  storageType,
}: {
  storageType: StorageType;
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
