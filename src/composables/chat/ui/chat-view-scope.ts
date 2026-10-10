import { getCurrentInstance, inject, provide, type InjectionKey, type Ref } from 'vue';
import type { ChatId } from '@/01-models/ids';

// A displayed ChatPane need not be the globally selected chat. Descendant
// settings/tool controls must resolve the same identity as its messages.
const scopeKey: InjectionKey<Readonly<Ref<ChatId>>> = Symbol('naidan-chat-view-scope');

export function provideChatViewScope({ chatId }: { chatId: Readonly<Ref<ChatId>> }): void {
  provide(scopeKey, chatId);
}

export function useChatViewScope(): Readonly<Ref<ChatId>> | undefined {
  return getCurrentInstance() ? inject(scopeKey, undefined) : undefined;
}

export const TEST_ONLY = {
};
