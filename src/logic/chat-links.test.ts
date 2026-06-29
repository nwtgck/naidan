import { describe, expect, it } from 'vitest';
import { generateMessageLink } from './chat-links';
import { toChatId, toMessageId } from '@/01-models/ids';

describe('chat link utilities', () => {
  it('generates hash-router message links with message-id query parameter', () => {
    const link = generateMessageLink({ chatId: toChatId({ raw: 'chat 1' }), messageId: toMessageId({ raw: 'message/1' }) });

    expect(link).toBe(`${window.location.origin}${window.location.pathname}${window.location.search}#/chat/chat%201?message-id=message%2F1`);
  });
});
