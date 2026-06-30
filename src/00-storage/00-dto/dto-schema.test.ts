import { describe, it, expect } from 'vitest';
import { ChatSchemaDto } from './dto';

describe('Zod Schemas', () => {
  it('should validate a correct chat object', () => {
    const chat = {
      id: 'test-id',
      title: 'Hello',
      root: {
        items: [
          {
            id: 'test-id',
            role: 'user',
            content: 'Hi',
            timestamp: 123456,
            replies: { items: [] },
          },
        ],
      },
      modelId: 'gpt-4',
      createdAt: 123,
      updatedAt: 123,
      debugEnabled: false,
    };

    expect(() => ChatSchemaDto.parse(chat)).not.toThrow();
  });
});
