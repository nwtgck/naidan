import type { ChatGroupId, ChatId } from '@/models/ids';
import type { StorageType } from '@/models/types';
import { NAIDAN_SYSFS_MOUNT_PATH, type NaidanSysfsBinaryObjectAccess, type NaidanSysfsVisibility, type WeshMount } from '@/services/wesh/types';

export function createNaidanSysfsMount({
  storageType,
  visibility,
  binaryObjectAccess,
  currentChatId,
  currentChatGroupId,
}: {
  storageType: StorageType,
  visibility: NaidanSysfsVisibility,
  binaryObjectAccess: NaidanSysfsBinaryObjectAccess,
  currentChatId: ChatId | undefined,
  currentChatGroupId: ChatGroupId | undefined,
}): WeshMount | undefined {
  if (currentChatId === undefined) {
    return undefined;
  }

  switch (storageType) {
  case 'local':
  case 'opfs':
  case 'memory':
    return {
      type: 'naidan_sysfs',
      path: NAIDAN_SYSFS_MOUNT_PATH,
      readOnly: true,
      storageType,
      visibility,
      binaryObjectAccess,
      currentChatId,
      currentChatGroupId,
    };
  default: {
    const _ex: never = storageType;
    throw new Error(`Unhandled storage type: ${String(_ex)}`);
  }
  }
}
