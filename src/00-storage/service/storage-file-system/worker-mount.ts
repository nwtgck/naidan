import type {
  StorageDirectoryWorkerMountSession,
  StorageDirectoryWorkerMountSource,
} from './types';

/**
 * Reopens a structured-cloneable storage directory capability in the current
 * Worker realm. Feature Workers depend on this generic storage boundary rather
 * than importing an individual filesystem implementation.
 */
export async function openStorageDirectoryWorkerMount({ source }: {
  source: StorageDirectoryWorkerMountSource;
}): Promise<StorageDirectoryWorkerMountSession> {
  switch (source.type) {
  case 'hizofs': {
    const { openHizoFSWorkerMount } = await import(
      '@/00-storage/service/hizofs/api'
    );
    return openHizoFSWorkerMount({ source });
  }
  default: {
    const _ex: never = source.type;
    throw new Error(`Unhandled storage directory Worker mount: ${String(_ex)}`);
  }
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
