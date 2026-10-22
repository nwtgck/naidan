import type { ChatId } from '@/01-models/ids';
import { chatLocalModelInputs, type ChatLocalModelInput } from './chat-local-model-input';

/** Represents an actual open input operation without inventing production guard APIs. */
export function openChatLocalModelInput({ chatId }: { chatId: ChatId }) {
  const input: ChatLocalModelInput = {
    chatId,
    owner: {},
    controller: new AbortController(),
    isStorageCurrent: () => true,
    state: { id: 1, phase: 'reading', candidates: [], model: undefined, error: undefined, downloadJobId: undefined },
    pending: undefined,
    run: async () => {},
  };
  chatLocalModelInputs.value = new Map(chatLocalModelInputs.value).set(chatId, input);
  function release(): void {
    input.controller.abort();
    if (chatLocalModelInputs.value.get(chatId) === input) {
      const next = new Map(chatLocalModelInputs.value);
      next.delete(chatId);
      chatLocalModelInputs.value = next;
    }
  }
  return { input, release, [Symbol.dispose]: release };
}
