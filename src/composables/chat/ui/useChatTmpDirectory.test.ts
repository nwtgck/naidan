import { toChatId } from '@/01-models/ids';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEnsureChatTmpDirectory } = vi.hoisted(() => ({
  mockEnsureChatTmpDirectory: vi.fn().mockResolvedValue({ handle: { name: 'tmp' }, mountPath: '/tmp' }),
}));

vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  ensureChatTmpDirectory: mockEnsureChatTmpDirectory,
}));

import { useChatTmpDirectory } from './useChatTmpDirectory';

describe('useChatTmpDirectory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates tmp directory access to the compat store', async () => {
    const chatTmpDirectory = useChatTmpDirectory();

    await chatTmpDirectory.ensureChatTmpDirectory({
      chatId: toChatId({ raw: 'chat-1' }),
    });

    expect(mockEnsureChatTmpDirectory).toHaveBeenCalledWith({
      chatId: toChatId({ raw: 'chat-1' }),
    });
  });
});
