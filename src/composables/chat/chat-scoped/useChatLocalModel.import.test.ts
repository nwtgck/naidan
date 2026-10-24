// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { toChatId } from '@/01-models/ids';
import type { Chat } from '@/01-models/types';
import type { ModelLaunchTarget } from '@/01-models/llama-cpp-browser-model-launch';
import { useChatLocalModel } from './useChatLocalModel';

const state = vi.hoisted(() => ({
  importing: Promise.withResolvers<void>(),
  release: Promise.withResolvers<void>(),
  installed: vi.fn(async () => undefined),
  enqueue: vi.fn(),
  apply: vi.fn(),
  chat: undefined as Chat | undefined,
}));
vi.mock('@/00-storage/service', () => ({ storageService: { captureSettingsStorage: () => () => true } }));
vi.mock('@/composables/useSettings', () => ({ useSettings: () => ({ settings: { value: {} } }) }));
vi.mock('@/composables/chat/global/chat-core-singletons', () => ({
  getLiveChatById: () => state.chat,
  rootItems: { value: [] },
  updateEmptyChatScopedSettings: state.apply,
  updateChatScopedSettings: state.apply,
}));
vi.mock('./chat-model-binding-operations', () => ({ withChatModelBindingFinalization: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', () => ({ installedSelection: state.installed }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download-queue', () => ({ getDownloadQueue: () => ({ jobs: { value: [] }, enqueue: state.enqueue }) }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download-plan', async () => {
  state.importing.resolve();
  await state.release.promise;
  return { selectionKey: () => 'selected-model' };
});

it('does not enqueue a host download after cancellation while lazy download code is importing', async () => {
  const chatId = toChatId({ raw: 'cancel-during-import' });
  state.chat = { id: chatId, title: null, root: { items: [] }, createdAt: 1, updatedAt: 1, debugEnabled: false };
  const scope = effectScope();
  using _cleanup = {
    [Symbol.dispose]() {
      state.release.resolve();
      scope.stop();
    },
  };
  const command = scope.run(() => useChatLocalModel({ chatId: ref(chatId), binding: 'empty-chat' }))!;
  const destination = { kind: 'host' as const, directoryId: 'root-a' };
  const target: ModelLaunchTarget = { modelId: 'hf.co/owner/model:Q4', mainFilePath: 'Q4.gguf', selection: { repository: 'owner/model', revision: 'a'.repeat(40), files: [{ path: 'Q4.gguf', size: 128 }] } };
  const pending = command.useRepositoryModel({ target, destination, authorizeDestination: async () => ({ destination, expectedRoot: { name: 'Models' } as FileSystemDirectoryHandle }) });
  await state.importing.promise;
  expect(state.installed).toHaveBeenCalledOnce();
  scope.stop();
  state.release.resolve();
  await pending;
  expect(state.enqueue).not.toHaveBeenCalled();
  expect(state.apply).not.toHaveBeenCalled();
  expect(command.maySend.value).toBe(true);
});
