import { describe, it, expect } from 'vitest';
import { ChatSchemaDto } from './dto';

describe('Zod Schemas', () => {
  it('should validate a correct chat object', () => {
    const chat = {
      id: crypto.randomUUID(),
      title: 'Hello',
      root: {
        items: [
          {
            id: crypto.randomUUID(),
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

  it('should reject invalid UUID', () => {
    const chat = {
      id: '123',
      title: 'Hello',
      messages: [],
      modelId: 'gpt-4',
      createdAt: 123,
      updatedAt: 123,
      debugEnabled: false,
    };
    expect(() => ChatSchemaDto.parse(chat)).toThrow();
  });
});
