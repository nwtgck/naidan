import { idToRaw } from '@/01-models/ids';
import { appUrlFromLocation } from './app-location';
import type { ChatId, MessageId } from '@/01-models/ids';

export function generateMessageLink({ chatId, messageId }: { chatId: ChatId, messageId: MessageId }): string {
  const url = appUrlFromLocation({ href: window.location.href });
  url.hash = '';
  const baseUrl = url.href;
  const params = new URLSearchParams({ 'message-id': idToRaw({ id: messageId }) });
  return `${baseUrl}#/chat/${encodeURIComponent(idToRaw({ id: chatId }))}?${params.toString()}`;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
