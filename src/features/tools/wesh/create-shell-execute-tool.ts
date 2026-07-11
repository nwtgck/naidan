import type { Tool } from '@/01-models/tool';
import type { ChatGroupId, ChatId, VolumeId } from '@/01-models/ids';
import type { Mount, Settings } from '@/01-models/types';
import { storageService } from '@/00-storage/service';
import { shouldIncludeWritableTmpMount } from '@/features/wesh/mount-policy';
import type { NaidanSysfsAccessScope, WeshMount } from '@/features/wesh/types';
import type { StorageVolumeAccess } from '@/00-storage/service/volume-access';
import { createWeshStorageMount } from '@/features/wesh/storage-mount';
import { createNaidanSysfsMount } from '@/features/wesh/naidan-sysfs/mount';
import { createFileProtocolCompatibleWeshWorkerClient } from '@/features/wesh/worker/client';
import { createWeshTool } from '@/features/tools/wesh';
import {
  abortOngoingScans,
  getVolumeExtensions,
  isVolumeScanned,
  startVolumeExtensionScan,
} from '@/features/tools/wesh/volume-extension-cache';
import { buildShellDescription } from '@/features/tools/wesh/shell-description';

export async function createShellExecuteTool({
  settings,
  chatGroupMounts,
  chatMounts,
  chatId,
  chatGroupId,
  naidanSysfsAccessScope,
  tmpAccess,
}: {
  settings: Settings,
  chatGroupMounts: Mount[] | undefined,
  chatMounts: Mount[] | undefined,
  chatId: ChatId | undefined,
  chatGroupId: ChatGroupId | undefined,
  naidanSysfsAccessScope: NaidanSysfsAccessScope,
  tmpAccess: StorageVolumeAccess | undefined,
}): Promise<Tool | undefined> {
  const shouldMountTmp = shouldIncludeWritableTmpMount({ storageType: settings.storageType });
  const allMounts = [...settings.mounts, ...(chatGroupMounts ?? []), ...(chatMounts ?? [])];
  const resolvedMounts: WeshMount[] = [];
  if (shouldMountTmp) {
    if (tmpAccess === undefined) {
      return undefined;
    }
    resolvedMounts.push(createWeshStorageMount({ path: '/tmp', access: tmpAccess, readOnly: false }));
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

  const volumeHandles = new Map<VolumeId, FileSystemDirectoryHandle>();
  for (const mount of allMounts) {
    const access = await storageService.openVolume({ volumeId: mount.volumeId });
    if (access === null) {
      continue;
    }
    resolvedMounts.push(createWeshStorageMount({
      path: mount.mountPath,
      access,
      readOnly: mount.readOnly,
    }));
    switch (access.type) {
    case 'direct_directory':
      volumeHandles.set(mount.volumeId, access.handle);
      break;
    case 'encrypted_directory':
      break;
    default: {
      const _ex: never = access;
      throw new Error(`Unhandled storage volume access: ${((_ex satisfies never) as { readonly type: string }).type}`);
    }
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

  for (const [volumeId, handle] of volumeHandles) {
    if (!isVolumeScanned({ volumeId })) {
      startVolumeExtensionScan({ volumeId, handle });
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
