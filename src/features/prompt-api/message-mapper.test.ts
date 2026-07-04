import { describe, expect, it } from 'vitest';

import { mapChatMessagesToPromptApi } from './message-mapper';

describe('mapChatMessagesToPromptApi', () => {
  it('combines leading system messages and separates the final user prompt', () => {
    expect(mapChatMessagesToPromptApi({
      messages: [
        { role: 'system', content: 'Global instruction' },
        { role: 'system', content: 'Chat instruction' },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
        { role: 'user', content: 'Next question' },
      ],
    })).toEqual({
      initialPrompts: [
        { role: 'system', content: `\
Global instruction

Chat instruction` },
        { role: 'user', content: 'First question' },
        { role: 'assistant', content: 'First answer' },
      ],
      prompt: 'Next question',
    });
  });

  it('rejects multimodal content without silently dropping it', () => {
    expect(() => mapChatMessagesToPromptApi({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      }],
    })).toThrow('multimodal input is not supported');
  });

  it('rejects tool history without silently flattening it', () => {
    expect(() => mapChatMessagesToPromptApi({
      messages: [{
        role: 'tool',
        content: 'result',
      }],
    })).toThrow('tool history is not supported');
  });

  it('requires the final conversation message to be from the user', () => {
    expect(() => mapChatMessagesToPromptApi({
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
      ],
    })).toThrow('final message to be from the user');
  });
});
