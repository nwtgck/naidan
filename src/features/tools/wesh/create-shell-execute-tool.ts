import type { Tool } from '@/01-models/tool';
import type { ChatGroupId, ChatId, VolumeId } from '@/01-models/ids';
import type { Mount, Settings } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import type { VolumeAccess } from '@/01-models/volume-access';
import { volumeAccessToWeshMount } from '@/features/wesh/volume-mount';
import { shouldIncludeWritableTmpMount } from '@/features/wesh/mount-policy';
import type { NaidanSysfsAccessScope, WeshMount } from '@/features/wesh/types';
import { createNaidanSysfsMount } from '@/features/wesh/naidan-sysfs/mount';
import { createFileProtocolCompatibleWeshWorkerClient } from '@/features/wesh/worker/client';
import { createWeshTool } from '@/features/tools/wesh';
import {
  abortOngoingScans,
  getVolumeExtensions,
  isVolumeScanned,
  startVolumeAccessExtensionScan,
} from '@/features/tools/wesh/volume-extension-cache';
import { buildShellDescription } from '@/features/tools/wesh/shell-description';

export async function createShellExecuteTool({
  settings,
  chatGroupMounts,
  chatMounts,
  chatId,
  chatGroupId,
  naidanSysfsAccessScope,
  tmpHandle,
}: {
  settings: Settings,
  chatGroupMounts: Mount[] | undefined,
  chatMounts: Mount[] | undefined,
  chatId: ChatId | undefined,
  chatGroupId: ChatGroupId | undefined,
  naidanSysfsAccessScope: NaidanSysfsAccessScope,
  tmpHandle: FileSystemDirectoryHandle | undefined,
}): Promise<Tool | undefined> {
  const shouldMountTmp = shouldIncludeWritableTmpMount({ storageType: settings.storageType });
  const allMounts = [...settings.mounts, ...(chatGroupMounts ?? []), ...(chatMounts ?? [])];
  const resolvedMounts: WeshMount[] = [];
  if (shouldMountTmp) {
    if (tmpHandle === undefined) {
      return undefined;
    }
    resolvedMounts.push({ type: 'directory', path: '/tmp', handle: tmpHandle, readOnly: false });
  }
  switch (naidanSysfsAccessScope) {
  case 'none':
    break;
  case 'current_chat_only':
  case 'current_chat_with_chat_group':
  case 'main_chats': {
    const naidanSysfsMount = createNaidanSysfsMount({
      storageType: settings.storageType,
      visibility: naidanSysfsAccessScope,
      binaryObjectAccess: 'data',
      currentChatId: chatId,
      currentChatGroupId: chatGroupId,
    });
    if (naidanSysfsMount !== undefined) {
      resolvedMounts.push(naidanSysfsMount);
    }
    break;
  }
  default: {
    const _ex: never = naidanSysfsAccessScope;
    throw new Error(`Unhandled naidan sysfs access scope: ${String(_ex)}`);
  }
  }

  const volumeAccesses = new Map<VolumeId, VolumeAccess>();
  for (const mount of allMounts) {
    const access = await storageService.resolveVolumeAccess({ volumeId: mount.volumeId });
    const resolved = volumeAccessToWeshMount({ mount, access });
    if (resolved !== undefined) {
      resolvedMounts.push(resolved);
      volumeAccesses.set(mount.volumeId, access);
    }
  }

  const hasHomeUserMount = resolvedMounts.some(mount => mount.path.startsWith('/home/user/'));
  const client = await createFileProtocolCompatibleWeshWorkerClient({
    rootHandle: 'readonly',
    mounts: resolvedMounts,
    user: 'user',
    initialEnv: {},
    initialCwd: hasHomeUserMount ? '/home/user' : undefined,
  });

  abortOngoingScans();
  const detectedExtensions = new Set<string>();
  for (const mount of allMounts) {
    for (const extension of getVolumeExtensions({ volumeId: mount.volumeId })) {
      detectedExtensions.add(extension);
    }
  }

  for (const [volumeId, access] of volumeAccesses) {
    if (!isVolumeScanned({ volumeId })) {
      void startVolumeAccessExtensionScan({ volumeId, access }).catch(() => undefined);
    }
  }

  return createWeshTool({
    client,
    mounts: resolvedMounts,
    name: 'shell_execute',
    description: buildShellDescription({ mounts: resolvedMounts, detectedExtensions }),
    defaultStdoutLimit: 32768,
    defaultStderrLimit: 16384,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
