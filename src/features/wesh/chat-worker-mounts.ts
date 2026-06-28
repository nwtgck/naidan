import { useChatTmpDirectory } from '@/composables/chat/ui/useChatTmpDirectory';
import { useSettings } from '@/composables/useSettings';
import type { ChatGroupId, ChatId } from '@/01-models/ids';
import type { Mount } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import { shouldIncludeWritableTmpMount } from '@/features/wesh/mount-policy';
import { createNaidanSysfsMount } from '@/features/wesh/naidan-sysfs/mount';
import type { NaidanSysfsAccessScope, WeshMount } from '@/features/wesh/types';

export async function buildWorkerMountsForChat({
  chatMounts,
  chatGroupMounts,
  chatId,
  chatGroupId,
  naidanSysfsAccessScope,
}: {
  chatMounts: readonly Mount[],
  chatGroupMounts: readonly Mount[] | undefined,
  chatId: ChatId | undefined,
  chatGroupId: ChatGroupId | undefined,
  naidanSysfsAccessScope: NaidanSysfsAccessScope,
}): Promise<WeshMount[]> {
  const { settings } = useSettings();
  const { ensureChatTmpDirectory } = useChatTmpDirectory();
  const result: WeshMount[] = [];

  // /tmp first (same order as shell_execute tool), only for OPFS-backed chats.
  if (chatId && shouldIncludeWritableTmpMount({ storageType: settings.value.storageType })) {
    const tmp = await ensureChatTmpDirectory({ chatId });
    result.push({ type: 'directory', path: '/tmp', handle: tmp.handle, readOnly: false });
  }

  switch (naidanSysfsAccessScope) {
  case 'none':
    break;
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
  case 'main_chats': {
    const naidanSysfsMount = createNaidanSysfsMount({
      storageType: settings.value.storageType,
      visibility: naidanSysfsAccessScope,
      binaryObjectAccess: 'data',
      currentChatId: chatId,
      currentChatGroupId: chatGroupId,
    });
    if (naidanSysfsMount !== undefined) {
      result.push(naidanSysfsMount);
    }
    break;
  }
  default: {
    const _ex: never = naidanSysfsAccessScope;
    throw new Error(`Unhandled naidan sysfs access scope: ${String(_ex)}`);
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
