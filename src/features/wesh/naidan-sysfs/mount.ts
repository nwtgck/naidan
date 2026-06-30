import type { ChatGroupId, ChatId } from '@/01-models/ids';
import type { StorageType } from '@/01-models/types';
import { NAIDAN_SYSFS_MOUNT_PATH, type NaidanSysfsBinaryObjectAccess, type NaidanSysfsVisibility, type WeshMount } from '@/features/wesh/types';

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

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {};
