import type { ChatId, MessageId } from '@/models/ids';
export function generateMessageLink({ chatId, messageId }: { chatId: ChatId, messageId: MessageId }): string {
  const baseUrl = (() => {
    const loc = window.location;
    return `${loc.origin}${loc.pathname}${loc.search}`;
  })();
  const params = new URLSearchParams({ 'message-id': messageId });
  return `${baseUrl}#/chat/${encodeURIComponent(chatId)}?${params.toString()}`;
}
