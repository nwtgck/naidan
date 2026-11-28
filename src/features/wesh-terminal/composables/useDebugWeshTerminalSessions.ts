import { opfsFormat } from '@/00-format/01-layout/layout';
import { useSettings } from '@/composables/useSettings';
import { createWeshTerminalSessions } from '@/features/wesh-terminal/composables/useWeshTerminalSessions';
import { storageService } from '@/00-storage/service';
import type { WeshMount } from '@/features/wesh/types';
import { volumeAccessToWeshMount } from '@/features/wesh/volume-mount';

const { path: opfsPath, home: homeEntry, tmp: tmpEntry } = opfsFormat.debugWesh.global;
const home = '/' + homeEntry.path.slice(opfsPath.length).join('/');
const tmp = '/' + tmpEntry.path.slice(opfsPath.length).join('/');
const store = createWeshTerminalSessions({
  opfsPath,
  user: 'debug',
  initialEnv: { HOME: home, TMPDIR: tmp },
  initialCwd: home,
  homeDirectory: home,
  tmpDirectory: tmp,
});

async function buildWorkerMounts(): Promise<WeshMount[]> {
  const { settings } = useSettings();
  const mounts: WeshMount[] = [];
  for (const mount of settings.value.mounts) {
    if (mount.type !== 'volume') {
      continue;
    }
    const access = await storageService.resolveVolumeAccess({ volumeId: mount.volumeId });
    const entry = volumeAccessToWeshMount({ mount, access });
    if (entry === undefined) {
      continue;
    }
    mounts.push(entry);
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
