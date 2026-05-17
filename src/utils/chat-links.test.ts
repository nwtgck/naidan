import { describe, expect, it } from 'vitest';
import { generateMessageLink } from './chat-links';

describe('chat link utilities', () => {
  it('generates hash-router message links with message-id query parameter', () => {
    const link = generateMessageLink({ chatId: 'chat 1', messageId: 'message/1' });

    expect(link).toBe(`${window.location.origin}${window.location.pathname}${window.location.search}#/chat/chat%201?message-id=message%2F1`);
  });
});
