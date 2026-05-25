import type { Chat } from '@/models/types';

export type ChatOpenService = {
  openChat({
    id,
    leafId,
  }: {
    id: string;
    leafId?: string;
  }): Promise<Chat | null>;

  openChatAtMessage({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }): Promise<Chat | null>;

  openChatGroup({
    id,
  }: {
    id: string | null;
  }): void;
};

export function createChatOpenService({
  setCurrentChatId,
  setToolEnabled,
  hasMountsForChat,
  openChatInStore,
  openChatAtMessageInStore,
  openChatGroupInStore,
}: {
  setCurrentChatId: ({ chatId }: { chatId: string | null }) => void;
  setToolEnabled: ({ name, enabled }: { name: 'shell_execute'; enabled: boolean }) => void;
  hasMountsForChat: ({ chat }: { chat: Pick<Chat, 'mounts' | 'groupId'> }) => boolean;
  openChatInStore: ({ id, leafId }: { id: string; leafId?: string }) => Promise<Chat | null>;
  openChatAtMessageInStore: ({ chatId, messageId }: { chatId: string; messageId: string }) => Promise<Chat | null>;
  openChatGroupInStore: ({ id }: { id: string | null }) => void;
}): ChatOpenService {
  async function openChat({
    id,
    leafId,
  }: {
    id: string;
    leafId?: string;
  }) {
    setCurrentChatId({ chatId: id });
    const chat = await openChatInStore({ id, leafId });
    if (!chat) {
      setCurrentChatId({ chatId: null });
      return null;
    }
    if (hasMountsForChat({ chat })) {
      setToolEnabled({ name: 'shell_execute', enabled: true });
    }
    return chat;
  }

  async function openChatAtMessage({
    chatId,
    messageId,
  }: {
    chatId: string;
    messageId: string;
  }) {
    setCurrentChatId({ chatId });
    const chat = await openChatAtMessageInStore({ chatId, messageId });
    if (!chat) {
      setCurrentChatId({ chatId: null });
      return null;
    }
    if (hasMountsForChat({ chat })) {
      setToolEnabled({ name: 'shell_execute', enabled: true });
    }
    return chat;
  }

  function openChatGroup({
    id,
  }: {
    id: string | null;
  }) {
    openChatGroupInStore({ id });
  }

  return {
    openChat,
    openChatAtMessage,
    openChatGroup,
  };
}
