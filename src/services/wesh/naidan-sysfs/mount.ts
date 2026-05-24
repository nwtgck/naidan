import type { StorageType } from '@/models/types'
import { NAIDAN_SYSFS_MOUNT_PATH, type NaidanSysfsVisibility, type WeshMount } from '@/services/wesh/types'

export function createNaidanSysfsMount({
  storageType,
  visibility,
  currentChatId,
  currentChatGroupId,
}: {
  storageType: StorageType;
  visibility: NaidanSysfsVisibility | undefined;
  currentChatId: string | undefined;
  currentChatGroupId: string | undefined;
}): WeshMount | undefined {
  if (visibility === undefined || currentChatId === undefined) {
    return undefined
  }

  switch (storageType) {
  case 'opfs':
    return {
      type: 'naidan_sysfs',
      path: NAIDAN_SYSFS_MOUNT_PATH,
      readOnly: true,
      storageType: 'opfs',
      visibility,
      currentChatId,
      currentChatGroupId,
    }
  case 'local':
  case 'memory':
    return undefined
  default: {
    const _ex: never = storageType
    throw new Error(`Unhandled storage type: ${String(_ex)}`)
  }
  }
}
