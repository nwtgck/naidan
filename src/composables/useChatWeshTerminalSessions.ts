import { storageService } from '@/services/storage';
import { useSettings } from '@/composables/useSettings';
import { useChat } from '@/composables/useChat';
import { createWeshTerminalSessions } from '@/composables/useWeshTerminalSessions';
import { createNaidanSysfsMount } from '@/services/wesh/naidan-sysfs/mount';
import type { NaidanSysfsMountSelection, WeshMount } from '@/services/wesh/types';
import type { Mount } from '@/models/types';

const store = createWeshTerminalSessions({
  opfsRootName: 'naidan-chat-wesh',
  user: 'user',
  initialEnv: { HOME: '/home/user' },
  initialCwd: '/home/user',
});

export async function buildWorkerMountsForChat({
  chatMounts,
  chatGroupMounts,
  chatId,
  chatGroupId,
  naidanSysfsVisibility,
}: {
  chatMounts: readonly Mount[];
  chatGroupMounts: readonly Mount[] | undefined;
  chatId: string | undefined;
  chatGroupId: string | undefined;
  naidanSysfsVisibility: NaidanSysfsMountSelection;
}): Promise<WeshMount[]> {
  const { settings } = useSettings();
  const result: WeshMount[] = [];

  // /tmp first (same order as shell_execute tool), only when chatId is known.
  if (chatId) {
    const { ensureChatTmpDirectory } = useChat();
    const tmp = await ensureChatTmpDirectory({ chatId });
    result.push({ type: 'directory', path: '/tmp', handle: tmp.handle, readOnly: false });
  }

  switch (naidanSysfsVisibility) {
  case 'none':
    break
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
  case 'all_chats': {
    const naidanSysfsMount = createNaidanSysfsMount({
      storageType: settings.value.storageType,
      visibility: naidanSysfsVisibility,
      currentChatId: chatId,
      currentChatGroupId: chatGroupId,
    });
    if (naidanSysfsMount !== undefined) {
      result.push(naidanSysfsMount)
    }
    break
  }
  default: {
    const _ex: never = naidanSysfsVisibility
    throw new Error(`Unhandled naidan sysfs selection: ${String(_ex)}`)
  }
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
  naidanSysfsVisibility: NaidanSysfsMountSelection;
};

export function useChatWeshTerminalSessions() {
  return {
    ...store,
    createChatWorkerSession: ({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsVisibility }: SessionArgs) =>
      store.createSession({ buildMounts: () => buildWorkerMountsForChat({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsVisibility }) }),
    ensureActiveSession: ({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsVisibility }: SessionArgs) =>
      store.ensureSession({ buildMounts: () => buildWorkerMountsForChat({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsVisibility }) }),
    reopenSessionIfNeeded: ({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsVisibility }: SessionArgs) =>
      store.ensureSession({ buildMounts: () => buildWorkerMountsForChat({ chatMounts, chatGroupMounts, chatId, chatGroupId, naidanSysfsVisibility }) }),
    TEST_ONLY: {
      buildWorkerMountsForChat,
    },
  };
}
