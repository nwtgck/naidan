import type { Chat, Mount } from '@/01-models/types';
import type { ChatId, VolumeId } from '@/01-models/ids';
import { storageService } from '@/00-storage/service';
import { scheduleIdleTask } from '@/utils/idle-task';
import { normalizePath } from '@/features/wesh/path';

// Append future defaults instead of replacing historical entries. Persisted chats keep
// their stored mountPath, and every previous default must continue to suppress duplicate
// workspace provisioning when an older chat enables Shell Execute again.
const CHAT_WORKSPACE_MOUNT_PATHS = [
  '/workspace',
] as const;
export const CHAT_WORKSPACE_MOUNT_PATH = CHAT_WORKSPACE_MOUNT_PATHS[CHAT_WORKSPACE_MOUNT_PATHS.length - 1]!;
const CHAT_WORKSPACE_VOLUME_NAME = 'Workspace';

const provisioningByChat = new Map<ChatId, Promise<void>>();

function hasMountAtWorkspacePath({ mounts }: { mounts: Mount[] | undefined }): boolean {
  return mounts?.some(({ mountPath }) => {
    const normalizedMountPath = normalizePath({ cwd: '/', path: mountPath });
    return CHAT_WORKSPACE_MOUNT_PATHS.some(workspacePath => workspacePath === normalizedMountPath);
  }) ?? false;
}

async function provisionChatWorkspace({ chat }: { chat: Chat }): Promise<void> {
  if (storageService.getCurrentType() !== 'opfs' || hasMountAtWorkspacePath({ mounts: chat.mounts })) {
    return;
  }

  const volume = await storageService.createVolumeFromFiles({
    name: CHAT_WORKSPACE_VOLUME_NAME,
    entries: [],
    onProgress: undefined,
    signal: undefined,
  });
  const mount: Mount = {
    type: 'volume',
    volumeId: volume.id,
    mountPath: CHAT_WORKSPACE_MOUNT_PATH,
    readOnly: false,
  };

  try {
    const result = await storageService.addMountToChatIfPathAvailable({ chatId: chat.id, mount });
    switch (result) {
    case 'path_occupied':
      await storageService.deleteVolume({ volumeId: volume.id });
      return;
    case 'added':
      break;
    default: {
      const _ex: never = result;
      throw new Error(`Unhandled workspace mount result: ${String(_ex)}`);
    }
    }
    if (!hasMountAtWorkspacePath({ mounts: chat.mounts })) {
      chat.mounts = [...(chat.mounts ?? []), mount];
    }
  } catch (error) {
    await storageService.deleteVolume({ volumeId: volume.id }).catch(() => {});
    throw error;
  }
}

export async function ensureChatWorkspaceMounted({ chat }: { chat: Chat }): Promise<void> {
  const previous = provisioningByChat.get(chat.id) ?? Promise.resolve();
  const next = previous.then(async () => {
    await provisionChatWorkspace({ chat });
  });
  provisioningByChat.set(chat.id, next);

  try {
    await next;
  } finally {
    if (provisioningByChat.get(chat.id) === next) {
      provisioningByChat.delete(chat.id);
    }
  }
}

async function tryDeleteUnusedEmptyVolume({ volumeId }: { volumeId: VolumeId }): Promise<void> {
  // Empty-volume cleanup is intentionally best-effort. The potentially expensive
  // reference scan is deferred until idle time, and pending cleanup is not
  // persisted across reloads. Leaving an unused empty volume behind is preferable
  // to startup work or persistent GC state.
  await storageService.deleteVolumeIfEmptyAndUnreferenced({ volumeId });
}

export function scheduleUnusedEmptyVolumeCleanup({ volumeId }: { volumeId: VolumeId }): void {
  scheduleIdleTask({
    task: async () => {
      await tryDeleteUnusedEmptyVolume({ volumeId });
    },
    timeoutMs: 5_000,
    fallbackDelayMs: 1_000,
  });
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
  tryDeleteUnusedEmptyVolume,
};
