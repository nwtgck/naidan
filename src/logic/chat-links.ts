import { idToRaw } from '@/01-models/ids';
import type { ChatId, MessageId } from '@/01-models/ids';
export function generateMessageLink({ chatId, messageId }: { chatId: ChatId, messageId: MessageId }): string {
  const baseUrl = (() => {
    const loc = window.location;
    return `${loc.origin}${loc.pathname}${loc.search}`;
  })();
  const params = new URLSearchParams({ 'message-id': idToRaw({ id: messageId }) });
  return `${baseUrl}#/chat/${encodeURIComponent(idToRaw({ id: chatId }))}?${params.toString()}`;
}
