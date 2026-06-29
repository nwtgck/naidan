// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move this Naidan-specific helper into 01-models or application logic.
import { idToRaw } from '@/01-models/ids';
// eslint-disable-next-line local-rules/enforce-dependency-directions -- TODO(dependency-direction): Move this Naidan-specific helper into 01-models or application logic.
import type { ChatId, MessageId } from '@/01-models/ids';
export function generateMessageLink({ chatId, messageId }: { chatId: ChatId, messageId: MessageId }): string {
  const baseUrl = (() => {
    const loc = window.location;
    return `${loc.origin}${loc.pathname}${loc.search}`;
  })();
  const params = new URLSearchParams({ 'message-id': idToRaw({ id: messageId }) });
  return `${baseUrl}#/chat/${encodeURIComponent(idToRaw({ id: chatId }))}?${params.toString()}`;
}
