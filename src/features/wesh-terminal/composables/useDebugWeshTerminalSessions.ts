import { useSettings } from '@/composables/useSettings';
import { createWeshTerminalSessions } from '@/features/wesh-terminal/composables/useWeshTerminalSessions';
import { storageService } from '@/00-storage/service';
import type { WeshMount } from '@/features/wesh/types';
import { createWeshStorageMount } from '@/features/wesh/storage-mount';

const store = createWeshTerminalSessions({
  fileSystemType: 'debug_wesh',
  user: 'debug',
  initialEnv: { HOME: '/home/debug', TMPDIR: '/tmp' },
  initialCwd: '/home/debug',
  homeDirectory: '/home/debug',
  tmpDirectory: '/tmp',
});

async function buildWorkerMounts(): Promise<WeshMount[]> {
  const { settings } = useSettings();
  const mounts: WeshMount[] = [];
  for (const mount of settings.value.mounts) {
    if (mount.type !== 'volume') continue;
    const access = await storageService.openVolume({ volumeId: mount.volumeId });
    if (access === null) continue;
    mounts.push(createWeshStorageMount({
      path: mount.mountPath,
      access,
      readOnly: mount.readOnly,
    }));
  }
  return mounts;
}

export function useDebugWeshTerminalSessions() {
  return {
    ...store,
    createWorkerSession: () => store.createSession({ buildMounts: buildWorkerMounts }),
    ensureActiveSession: () => store.ensureSession({ buildMounts: buildWorkerMounts }),
    reopenSessionIfNeeded: () => store.ensureSession({ buildMounts: buildWorkerMounts }),
    ...((__BUILD_MODE_IS_TEST__ && {
      TEST_ONLY: {
        buildWorkerMounts,
      },
    }) || {}),
  };
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
