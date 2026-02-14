import { generateId } from '../utils/id';
import { describe, it, expect, vi } from 'vitest';
import { ChatSchemaDto } from './dto';

vi.mock('../utils/id', () => ({
  generateId: vi.fn(() => 'test-id')
}));

describe('Zod Schemas', () => {
  it('should validate a correct chat object', () => {
    const chat = {
      id: generateId(),
      title: 'Hello',
      root: {
        items: [
          {
            id: generateId(),
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
