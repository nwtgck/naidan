import { storageService } from '@/services/storage';
import { useSettings } from '@/composables/useSettings';
import { createWeshTerminalSessions } from '@/composables/useWeshTerminalSessions';
import type { WeshMount } from '@/services/wesh/types';
import type { Mount } from '@/models/types';

const store = createWeshTerminalSessions({
  opfsRootName: 'naidan-chat-wesh',
  user: 'user',
  initialEnv: { HOME: '/home/user' },
  initialCwd: '/home/user',
});

async function buildWorkerMountsForChat({ chatMounts }: { chatMounts: readonly Mount[] }): Promise<WeshMount[]> {
  const { settings } = useSettings();
  const result: WeshMount[] = [];

  // Global settings mounts first.
  for (const mount of settings.value.mounts) {
    if (mount.type !== 'volume') continue;
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId });
    if (!handle) continue;
    result.push({ path: mount.mountPath, handle, readOnly: mount.readOnly });
  }

  // Chat mounts override any global mount sharing the same path.
  for (const mount of chatMounts) {
    if (mount.type !== 'volume') continue;
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId });
    if (!handle) continue;
    const existing = result.findIndex(m => m.path === mount.mountPath);
    const entry: WeshMount = { path: mount.mountPath, handle, readOnly: mount.readOnly };
    if (existing >= 0) {
      result[existing] = entry;
    } else {
      result.push(entry);
    }
  }

  return result;
}

export function useChatWeshTerminalSessions() {
  return {
    ...store,
    createChatWorkerSession: ({ chatMounts }: { chatMounts: readonly Mount[] }) =>
      store.createSession({ buildMounts: () => buildWorkerMountsForChat({ chatMounts }) }),
    ensureActiveSession: ({ chatMounts }: { chatMounts: readonly Mount[] }) =>
      store.ensureSession({ buildMounts: () => buildWorkerMountsForChat({ chatMounts }) }),
    reopenSessionIfNeeded: ({ chatMounts }: { chatMounts: readonly Mount[] }) =>
      store.ensureSession({ buildMounts: () => buildWorkerMountsForChat({ chatMounts }) }),
    __testOnly: {
      buildWorkerMountsForChat,
    },
  };
}
