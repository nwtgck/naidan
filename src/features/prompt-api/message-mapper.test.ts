import { describe, expect, it } from 'vitest';

import type { PromptApiMessageContent, PromptApiPrompt } from './language-model';
import { mapChatMessagesToPromptApi } from './message-mapper';

function getPromptMessages({ prompt }: { prompt: PromptApiPrompt }) {
  if (typeof prompt === 'string') {
    throw new Error('Expected a message-array Prompt API prompt.');
  }
  return prompt;
}

function getImageContent({ content }: {
  content: string | PromptApiMessageContent[],
}) {
  if (typeof content === 'string') {
    throw new Error('Expected multimodal Prompt API content.');
  }
  const image = content.find(part => part.type === 'image');
  if (image === undefined || image.type !== 'image') {
    throw new Error('Expected image content.');
  }
  return image;
}

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
      inputMode: 'text',
    });
  });

  it('maps a final user image data URL to a Blob prompt', async () => {
    const result = mapChatMessagesToPromptApi({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image.' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,aGVsbG8=' },
          },
        ],
      }],
    });

    expect(result.inputMode).toBe('image');
    expect(result.initialPrompts).toEqual([]);

    const promptMessages = getPromptMessages({ prompt: result.prompt });
    expect(promptMessages).toHaveLength(1);
    expect(promptMessages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', value: 'Describe this image.' },
        { type: 'image' },
      ],
    });

    const image = getImageContent({ content: promptMessages[0]!.content });
    expect(image.value).toBeInstanceOf(Blob);
    expect(image.value.type).toBe('image/png');
    await expect(image.value.text()).resolves.toBe('hello');
  });

  it('uses image session options when an earlier user message contains an image', () => {
    const result = mapChatMessagesToPromptApi({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'First image' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,AQID' },
            },
          ],
        },
        { role: 'assistant', content: 'I can see it.' },
        { role: 'user', content: 'What was in it?' },
      ],
    });

    expect(result.inputMode).toBe('image');
    expect(result.prompt).toBe('What was in it?');
    expect(result.initialPrompts[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', value: 'First image' },
        { type: 'image' },
      ],
    });
  });

  it('accepts a text-only content array without declaring image input', () => {
    expect(mapChatMessagesToPromptApi({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      }],
    })).toEqual({
      initialPrompts: [],
      prompt: [{
        role: 'user',
        content: [{ type: 'text', value: 'hello' }],
      }],
      inputMode: 'text',
    });
  });

  it('rejects non-embedded image URLs instead of fetching them', () => {
    expect(() => mapChatMessagesToPromptApi({
      messages: [{
        role: 'user',
        content: [{
          type: 'image_url',
          image_url: { url: 'https://example.com/image.png' },
        }],
      }],
    })).toThrow('embedded data URL');
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
