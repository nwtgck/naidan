import { describe, expect, it, vi } from 'vitest';
import type { ChatContent } from '@/01-models/types';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import { buildChatGenerationMessages } from '@/logic/build-chat-generation-messages';

describe('buildChatGenerationMessages', () => {
  it('projects the selected branch with exact historical tool-call arguments and excludes the active assistant', async () => {
    const firstUserId = toMessageId({ raw: 'first-user' });
    const assistantId = toMessageId({ raw: 'assistant-tool-call' });
    const toolId = toMessageId({ raw: 'tool-result' });
    const followUpId = toMessageId({ raw: 'follow-up' });
    const activeAssistantId = toMessageId({ raw: 'active-assistant' });
    const toolCallId = toToolCallId({ raw: 'call-1' });
    const argumentsText = `\
{
  "city": "Tokyo",
  "unit": "C"
}`;
    const content: ChatContent = {
      currentLeafId: activeAssistantId,
      root: {
        items: [{
          id: firstUserId,
          role: 'user',
          content: 'weather',
          timestamp: 1,
          replies: {
            items: [{
              id: assistantId,
              role: 'assistant',
              content: 'calling',
              timestamp: 2,
              toolCalls: [{
                id: toolCallId,
                type: 'function',
                function: { name: 'lookup_weather', arguments: argumentsText },
              }],
              replies: {
                items: [{
                  id: toolId,
                  role: 'tool',
                  content: undefined,
                  attachments: undefined,
                  thinking: undefined,
                  error: undefined,
                  modelId: undefined,
                  lmParameters: undefined,
                  toolCalls: undefined,
                  timestamp: 3,
                  results: [{
                    toolCallId,
                    status: 'success',
                    content: { type: 'text', text: '20 C' },
                  }],
                  replies: {
                    items: [{
                      id: followUpId,
                      role: 'user',
                      content: 'continue',
                      timestamp: 4,
                      replies: {
                        items: [{
                          id: activeAssistantId,
                          role: 'assistant',
                          content: '',
                          timestamp: 5,
                          replies: { items: [] },
                        }],
                      },
                    }],
                  },
                }],
              },
            }],
          },
        }],
      },
    };
    const resolveUserContent = vi.fn(async ({ message }: { message: { content: string } }) => message.content);
    const resolveToolResultText = vi.fn(async () => 'formatted tool result');

    const messages = await buildChatGenerationMessages({
      chat: content,
      excludedMessageId: activeAssistantId,
      systemPromptMessages: ['system'],
      resolveUserContent,
      resolveToolResultText,
    });

    expect(messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'weather', tool_calls: undefined },
      {
        role: 'assistant',
        content: 'calling',
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: { name: 'lookup_weather', arguments: argumentsText },
        }],
      },
      { role: 'tool', tool_call_id: toolCallId, content: 'formatted tool result' },
      { role: 'user', content: 'continue', tool_calls: undefined },
    ]);
    expect(resolveUserContent).toHaveBeenCalledTimes(2);
    expect(resolveToolResultText).toHaveBeenCalledTimes(1);
  });

  it('preserves the legacy multimodal user-message object shape without an undefined tool_calls property', async () => {
    const userId = toMessageId({ raw: 'multimodal-user' });
    const content: ChatContent = {
      currentLeafId: userId,
      root: {
        items: [{
          id: userId,
          role: 'user',
          content: 'look',
          timestamp: 1,
          replies: { items: [] },
        }],
      },
    };

    const messages = await buildChatGenerationMessages({
      chat: content,
      excludedMessageId: undefined,
      systemPromptMessages: [],
      resolveUserContent: async () => [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } },
      ],
      resolveToolResultText: async () => 'unused',
    });

    expect(messages).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } },
      ],
    }]);
    expect(Object.hasOwn(messages[0]!, 'tool_calls')).toBe(false);
  });

});
