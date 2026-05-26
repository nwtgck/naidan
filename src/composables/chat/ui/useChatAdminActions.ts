import type { ChatGroup } from '@/models/types';
import { useChatUiServices } from './useChatUiServices';

export type ChatAdminActionsAdapter = {
  createChatGroup({
    name,
    options,
  }: {
    name: string;
    options?: Partial<Pick<ChatGroup, 'modelId' | 'systemPrompt' | 'lmParameters'>>;
  }): Promise<string>;

  deleteAllChats(_args: Record<never, never>): Promise<void>;

  TEST_ONLY: Record<string, never>;
};

export function useChatAdminActions(): ChatAdminActionsAdapter {
  const { hierarchyService, lifecycleService } = useChatUiServices({});

  async function createChatGroup({
    name,
    options,
  }: {
    name: string;
    options?: Partial<Pick<ChatGroup, 'modelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    return await hierarchyService.createChatGroup({
      name,
      options,
    });
  }

  async function deleteAllChats(_args: Record<never, never>) {
    await lifecycleService.deleteAllChats({});
  }

  return {
    createChatGroup,
    deleteAllChats,
    TEST_ONLY: {},
  };
}
