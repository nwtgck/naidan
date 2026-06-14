import { useChatTmpDirectory } from '@/composables/chat/ui/useChatTmpDirectory'
import { useSettings } from '@/composables/useSettings'
import type { Mount } from '@/models/types'
import { storageService } from '@/services/storage'
import { shouldIncludeWritableTmpMount } from '@/services/wesh/mount-policy'
import { createNaidanSysfsMount } from '@/services/wesh/naidan-sysfs/mount'
import type { NaidanSysfsMountSelection, WeshMount } from '@/services/wesh/types'

export async function buildWorkerMountsForChat({
  chatMounts,
  chatGroupMounts,
  chatId,
  chatGroupId,
  naidanSysfsVisibility,
}: {
  chatMounts: readonly Mount[]
  chatGroupMounts: readonly Mount[] | undefined
  chatId: string | undefined
  chatGroupId: string | undefined
  naidanSysfsVisibility: NaidanSysfsMountSelection
}): Promise<WeshMount[]> {
  const { settings } = useSettings()
  const { ensureChatTmpDirectory } = useChatTmpDirectory()
  const result: WeshMount[] = []

  // /tmp first (same order as shell_execute tool), only for OPFS-backed chats.
  if (chatId && shouldIncludeWritableTmpMount({ storageType: settings.value.storageType })) {
    const tmp = await ensureChatTmpDirectory({ chatId })
    result.push({ type: 'directory', path: '/tmp', handle: tmp.handle, readOnly: false })
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
      binaryObjectAccess: 'data',
      currentChatId: chatId,
      currentChatGroupId: chatGroupId,
    })
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
    if (mount.type !== 'volume') continue
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId })
    if (!handle) continue
    result.push({ type: 'directory', path: mount.mountPath, handle, readOnly: mount.readOnly })
  }

  // Chat group mounts override any global mount sharing the same path.
  for (const mount of chatGroupMounts ?? []) {
    if (mount.type !== 'volume') continue
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId })
    if (!handle) continue
    const existing = result.findIndex(m => m.path === mount.mountPath)
    const entry: WeshMount = { type: 'directory', path: mount.mountPath, handle, readOnly: mount.readOnly }
    if (existing >= 0) {
      result[existing] = entry
    } else {
      result.push(entry)
    }
  }

  // Chat mounts override any global or chat group mount sharing the same path.
  for (const mount of chatMounts) {
    if (mount.type !== 'volume') continue
    const handle = await storageService.getVolumeDirectoryHandle({ volumeId: mount.volumeId })
    if (!handle) continue
    const existing = result.findIndex(m => m.path === mount.mountPath)
    const entry: WeshMount = { type: 'directory', path: mount.mountPath, handle, readOnly: mount.readOnly }
    if (existing >= 0) {
      result[existing] = entry
    } else {
      result.push(entry)
    }
  }

  return result
}
