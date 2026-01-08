import { describe, it, expect } from 'vitest';
import { ChatSchema } from './types';
import { v4 as uuidv4 } from 'uuid';

describe('Zod Schemas', () => {
  it('should validate a correct chat object', () => {
    const chat = {
      id: uuidv4(),
      title: 'Hello',
      messages: [
        {
          id: uuidv4(),
          role: 'user',
          content: 'Hi',
          timestamp: 123456
        }
      ],
      modelId: 'gpt-4',
      createdAt: 123,
      updatedAt: 123
    };
    
    expect(() => ChatSchema.parse(chat)).not.toThrow();
  });

  it('should reject invalid UUID', () => {
    const chat = {
      id: '123',
      title: 'Hello',
      messages: [],
      modelId: 'gpt-4',
      createdAt: 123,
      updatedAt: 123
    };
    expect(() => ChatSchema.parse(chat)).toThrow();
  });
});
