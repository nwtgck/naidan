import { generateOpaqueId } from '@/01-models/id';
import { describe, it, expect, vi } from 'vitest';
import { ChatSchemaDto } from './dto';

vi.mock('../../01-models/id', () => ({
  generateOpaqueId: vi.fn(() => 'test-id'),
}));

describe('Zod Schemas', () => {
  it('should validate a correct chat object', () => {
    const chat = {
      id: generateOpaqueId(),
      title: 'Hello',
      root: {
        items: [
          {
            id: generateOpaqueId(),
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
