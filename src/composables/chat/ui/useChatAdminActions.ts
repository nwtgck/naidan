import type { ChatGroup } from '@/models/types';
import { useChatLifecycle } from './useChatLifecycle';
import { useChatOrganization } from './useChatOrganization';

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
  const chatLifecycle = useChatLifecycle();
  const chatOrganization = useChatOrganization();

  async function createChatGroup({
    name,
    options,
  }: {
    name: string;
    options?: Partial<Pick<ChatGroup, 'modelId' | 'systemPrompt' | 'lmParameters'>>;
  }) {
    return await chatOrganization.createChatGroup({
      name,
      options,
    });
  }

  async function deleteAllChats(_args: Record<never, never>) {
    await chatLifecycle.deleteAllChats({});
  }

  return {
    createChatGroup,
    deleteAllChats,
    TEST_ONLY: {},
  };
}
