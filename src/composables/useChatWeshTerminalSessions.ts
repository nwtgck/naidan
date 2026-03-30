import { storageService } from '@/services/storage';
import { useSettings } from '@/composables/useSettings';
import { useChat } from '@/composables/useChat';
import { createWeshTerminalSessions } from '@/composables/useWeshTerminalSessions';
import type { WeshMount } from '@/services/wesh/types';
import type { Mount } from '@/models/types';

const store = createWeshTerminalSessions({
  opfsRootName: 'naidan-chat-wesh',
  user: 'user',
  initialEnv: { HOME: '/home/user' },
  initialCwd: '/home/user',
});

async function buildWorkerMountsForChat({
  chatMounts,
  chatGroupMounts,
  chatId,
}: {
  chatMounts: readonly Mount[];
  chatGroupMounts: readonly Mount[] | undefined;
  chatId: string | undefined;
}): Promise<WeshMount[]> {
  const { settings } = useSettings();
  const result: WeshMount[] = [];

  // /tmp first (same order as shell_execute tool), only when chatId is known.
  if (chatId) {
    const { ensureChatTmpDirectory } = useChat();
    const tmp = await ensureChatTmpDirectory({ chatId });
    result.push({ path: '/tmp', handle: tmp.handle, readOnly: false });
  }

  // Global settings mounts.
  for (const mount of settings.value.mounts) {
    if (mount.type !== 'volume') continue;
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId });
    if (!handle) continue;
    result.push({ path: mount.mountPath, handle, readOnly: mount.readOnly });
  }

  // Chat group mounts override any global mount sharing the same path.
  for (const mount of chatGroupMounts ?? []) {
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

  // Chat mounts override any global or chat group mount sharing the same path.
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

type SessionArgs = { chatMounts: readonly Mount[]; chatGroupMounts: readonly Mount[] | undefined; chatId: string | undefined };

export function useChatWeshTerminalSessions() {
  return {
    ...store,
    createChatWorkerSession: ({ chatMounts, chatGroupMounts, chatId }: SessionArgs) =>
      store.createSession({ buildMounts: () => buildWorkerMountsForChat({ chatMounts, chatGroupMounts, chatId }) }),
    ensureActiveSession: ({ chatMounts, chatGroupMounts, chatId }: SessionArgs) =>
      store.ensureSession({ buildMounts: () => buildWorkerMountsForChat({ chatMounts, chatGroupMounts, chatId }) }),
    reopenSessionIfNeeded: ({ chatMounts, chatGroupMounts, chatId }: SessionArgs) =>
      store.ensureSession({ buildMounts: () => buildWorkerMountsForChat({ chatMounts, chatGroupMounts, chatId }) }),
    __testOnly: {
      buildWorkerMountsForChat,
    },
  };
}
