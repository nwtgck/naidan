import { useSettings } from '@/composables/useSettings';
import { createWeshTerminalSessions } from '@/features/wesh-terminal/composables/useWeshTerminalSessions';
import { storageService } from '@/00-storage/service';
import type { WeshMount } from '@/features/wesh/types';

const store = createWeshTerminalSessions({
  opfsRootName: 'naidan-debug-wesh',
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
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId });
    if (!handle) continue;
    mounts.push({ type: 'directory', path: mount.mountPath, handle, readOnly: mount.readOnly });
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
