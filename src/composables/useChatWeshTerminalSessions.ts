import { storageService } from '@/services/storage';
import { useSettings } from '@/composables/useSettings';
import { useChat } from '@/composables/useChat';
import { createWeshTerminalSessions } from '@/composables/useWeshTerminalSessions';
import { createNaidanSysfsMount } from '@/services/wesh/naidan-sysfs/mount';
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
  chatGroupId,
}: {
  chatMounts: readonly Mount[];
  chatGroupMounts: readonly Mount[] | undefined;
  chatId: string | undefined;
  chatGroupId: string | undefined;
}): Promise<WeshMount[]> {
  const { settings } = useSettings();
  const result: WeshMount[] = [];

  // /tmp first (same order as shell_execute tool), only when chatId is known.
  if (chatId) {
    const { ensureChatTmpDirectory } = useChat();
    const tmp = await ensureChatTmpDirectory({ chatId });
    result.push({ type: 'directory', path: '/tmp', handle: tmp.handle, readOnly: false });
  }

  const naidanSysfsMount = createNaidanSysfsMount({
    storageType: settings.value.storageType,
    visibility: 'current_chat_with_chat_group',
    currentChatId: chatId,
    currentChatGroupId: chatGroupId,
  });
  if (naidanSysfsMount !== undefined) {
    result.push(naidanSysfsMount)
  }

  // Global settings mounts.
  for (const mount of settings.value.mounts) {
    if (mount.type !== 'volume') continue;
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId });
    if (!handle) continue;
    result.push({ type: 'directory', path: mount.mountPath, handle, readOnly: mount.readOnly });
  }

  // Chat group mounts override any global mount sharing the same path.
  for (const mount of chatGroupMounts ?? []) {
    if (mount.type !== 'volume') continue;
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId });
    if (!handle) continue;
    const existing = result.findIndex(m => m.path === mount.mountPath);
    const entry: WeshMount = { type: 'directory', path: mount.mountPath, handle, readOnly: mount.readOnly };
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
    const entry: WeshMount = { type: 'directory', path: mount.mountPath, handle, readOnly: mount.readOnly };
    if (existing >= 0) {
      result[existing] = entry;
    } else {
      result.push(entry);
    }
  }

  return result;
}

type SessionArgs = {
  chatMounts: readonly Mount[];
  chatGroupMounts: readonly Mount[] | undefined;
  chatId: string | undefined;
  chatGroupId: string | undefined;
};

export function useChatWeshTerminalSessions() {
  return {
    ...store,
    createChatWorkerSession: ({ chatMounts, chatGroupMounts, chatId, chatGroupId }: SessionArgs) =>
      store.createSession({ buildMounts: () => buildWorkerMountsForChat({ chatMounts, chatGroupMounts, chatId, chatGroupId }) }),
    ensureActiveSession: ({ chatMounts, chatGroupMounts, chatId, chatGroupId }: SessionArgs) =>
      store.ensureSession({ buildMounts: () => buildWorkerMountsForChat({ chatMounts, chatGroupMounts, chatId, chatGroupId }) }),
    reopenSessionIfNeeded: ({ chatMounts, chatGroupMounts, chatId, chatGroupId }: SessionArgs) =>
      store.ensureSession({ buildMounts: () => buildWorkerMountsForChat({ chatMounts, chatGroupMounts, chatId, chatGroupId }) }),
    TEST_ONLY: {
      buildWorkerMountsForChat,
    },
  };
}
