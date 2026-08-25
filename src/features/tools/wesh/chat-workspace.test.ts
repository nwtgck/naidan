import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chat, Volume } from '@/01-models/types';
import { toChatId, toVolumeId } from '@/01-models/ids';

const mocks = vi.hoisted(() => ({
  getCurrentType: vi.fn(),
  createVolumeFromFiles: vi.fn(),
  addMountToChat: vi.fn(),
  addMountToChatIfPathAvailable: vi.fn(),
  deleteVolume: vi.fn(),
  deleteVolumeIfEmptyAndUnreferenced: vi.fn(),
}));

vi.mock('@/00-storage/service', () => ({ storageService: mocks }));

import {
  CHAT_WORKSPACE_MOUNT_PATH,
  ensureChatWorkspaceMounted,
  TEST_ONLY,
} from './chat-workspace';

function chat({ mounts = undefined }: { mounts?: Chat['mounts'] }): Chat {
  return {
    id: toChatId({ raw: 'chat-1' }),
    title: null,
    root: { items: [] },
    createdAt: 1,
    updatedAt: 1,
    debugEnabled: false,
    mounts,
  };
}

describe('chat workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentType.mockReturnValue('opfs');
    mocks.createVolumeFromFiles.mockResolvedValue({
      id: toVolumeId({ raw: 'volume-workspace' }),
      name: 'Workspace',
      type: 'opfs',
      createdAt: 1,
    } satisfies Volume);
    mocks.addMountToChat.mockResolvedValue(undefined);
    mocks.addMountToChatIfPathAvailable.mockResolvedValue('added');
    mocks.deleteVolume.mockResolvedValue(undefined);
    mocks.deleteVolumeIfEmptyAndUnreferenced.mockResolvedValue('kept');
  });

  it('creates one writable /workspace mount for an OPFS chat', async () => {
    const target = chat({});

    await ensureChatWorkspaceMounted({ chat: target });
    await ensureChatWorkspaceMounted({ chat: target });

    expect(mocks.createVolumeFromFiles).toHaveBeenCalledTimes(1);
    expect(mocks.createVolumeFromFiles).toHaveBeenCalledWith({
      name: 'Workspace',
      entries: [],
      onProgress: undefined,
      signal: undefined,
    });
    expect(mocks.addMountToChatIfPathAvailable).toHaveBeenCalledWith({
      chatId: target.id,
      mount: {
        type: 'volume',
        volumeId: toVolumeId({ raw: 'volume-workspace' }),
        mountPath: CHAT_WORKSPACE_MOUNT_PATH,
        readOnly: false,
      },
    });
    expect(target.mounts).toEqual([{
      type: 'volume',
      volumeId: toVolumeId({ raw: 'volume-workspace' }),
      mountPath: '/workspace',
      readOnly: false,
    }]);
  });

  it('recognizes a lexically equivalent existing workspace path', async () => {
    const target = chat({ mounts: [{
      type: 'volume',
      volumeId: toVolumeId({ raw: 'existing' }),
      mountPath: '/workspace/./',
      readOnly: true,
    }] });

    await ensureChatWorkspaceMounted({ chat: target });

    expect(mocks.createVolumeFromFiles).not.toHaveBeenCalled();
  });

  it('does not duplicate the live mount if synchronization updates the chat before provisioning returns', async () => {
    const target = chat({ mounts: [] });
    mocks.addMountToChatIfPathAvailable.mockImplementation(async ({ mount }: { mount: NonNullable<Chat['mounts']>[number] }) => {
      target.mounts = [mount];
      return 'added';
    });

    await ensureChatWorkspaceMounted({ chat: target });

    expect(target.mounts).toHaveLength(1);
    expect(target.mounts?.[0]?.mountPath).toBe('/workspace');
  });

  it('does not provision when /workspace is already occupied', async () => {
    const target = chat({ mounts: [{
      type: 'volume',
      volumeId: toVolumeId({ raw: 'existing' }),
      mountPath: '/workspace',
      readOnly: true,
    }] });

    await ensureChatWorkspaceMounted({ chat: target });

    expect(mocks.createVolumeFromFiles).not.toHaveBeenCalled();
  });

  it('deletes the fresh volume when an inherited mount already occupies /workspace', async () => {
    const target = chat({});
    mocks.addMountToChatIfPathAvailable.mockResolvedValue('path_occupied');

    await ensureChatWorkspaceMounted({ chat: target });

    expect(mocks.deleteVolume).toHaveBeenCalledWith({ volumeId: toVolumeId({ raw: 'volume-workspace' }) });
    expect(target.mounts).toBeUndefined();
  });

  it('does not provision on storage backends without volume support', async () => {
    mocks.getCurrentType.mockReturnValue('local');

    await ensureChatWorkspaceMounted({ chat: chat({}) });

    expect(mocks.createVolumeFromFiles).not.toHaveBeenCalled();
  });

  it('delegates best-effort cleanup to the storage service', async () => {
    const volumeId = toVolumeId({ raw: 'volume-1' });

    await TEST_ONLY.tryDeleteUnusedEmptyVolume({ volumeId });

    expect(mocks.deleteVolumeIfEmptyAndUnreferenced).toHaveBeenCalledWith({ volumeId });
  });
});
