import { storageService } from '@/services/storage';
import { useSettings } from '@/composables/useSettings';
import { createWeshTerminalSessions } from '@/composables/useWeshTerminalSessions';
import type { WeshMount } from '@/services/wesh/types';

const store = createWeshTerminalSessions({
  opfsRootName: 'naidan-debug-wesh',
  user: 'debug',
  initialEnv: {},
  initialCwd: undefined,
});

async function buildWorkerMounts(): Promise<WeshMount[]> {
  const { settings } = useSettings();
  const mounts: WeshMount[] = [];
  for (const mount of settings.value.mounts) {
    if (mount.type !== 'volume') continue;
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId });
    if (!handle) continue;
    mounts.push({ path: mount.mountPath, handle, readOnly: mount.readOnly });
  }
  return mounts;
}

export function useDebugWeshTerminalSessions() {
  return {
    ...store,
    createWorkerSession: () => store.createSession({ buildMounts: buildWorkerMounts }),
    ensureActiveSession: () => store.ensureSession({ buildMounts: buildWorkerMounts }),
    reopenSessionIfNeeded: () => store.ensureSession({ buildMounts: buildWorkerMounts }),
    __testOnly: {
      buildWorkerMounts,
    },
  };
}
