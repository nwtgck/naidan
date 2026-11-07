import { describe, expect, it } from 'vitest';
import { generateMessageLink } from './chat-links';
import { toChatId, toMessageId } from '@/01-models/ids';

describe('chat link utilities', () => {
  it('generates hash-router message links with message-id query parameter', () => {
    const link = generateMessageLink({ chatId: toChatId({ raw: 'chat 1' }), messageId: toMessageId({ raw: 'message/1' }) });

    expect(link).toBe(`${window.location.origin}${window.location.pathname}${window.location.search}#/chat/chat%201?message-id=message%2F1`);
  });
});

it('shares a chat from a model entry at the real origin, not the model path', () => {
  const previous = window.location.href;
  window.history.replaceState(undefined, '', '/llama-cpp-browser/hf.co/LiquidAI/LFM2.5-230M-GGUF:Q4_K_M/');
  using _location = { [Symbol.dispose]: () => window.history.replaceState(undefined, '', previous) };
  expect(generateMessageLink({ chatId: toChatId({ raw: 'chat 1' }), messageId: toMessageId({ raw: 'message/1' }) })).toBe(`${window.location.origin}/#/chat/chat%201?message-id=message%2F1`);
});
