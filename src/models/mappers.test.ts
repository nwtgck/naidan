import { describe, it, expect } from 'vitest';
import { chatToDomain } from './mappers';
import { v7 as uuidv7 } from 'uuid';

describe('Legacy Migration (Flat to Tree)', () => {
  it('should migrate linear messages to a recursive tree structure', () => {
    const legacyId1 = uuidv7();
    const legacyId2 = uuidv7();
    const legacyChat: any = {
      id: uuidv7(),
      title: 'Legacy',
      messages: [
        { id: legacyId1, role: 'user', content: 'Hi', timestamp: 1 },
        { id: legacyId2, role: 'assistant', content: 'Hello', timestamp: 2 },
      ],
      modelId: 'gpt-4',
      createdAt: 1,
      updatedAt: 2,
    };

    const domain = chatToDomain(legacyChat);

    expect(domain.root.items).toHaveLength(1);
    expect(domain.root.items[0]?.id).toBe(legacyId1);
    expect(domain.root.items[0]?.replies.items).toHaveLength(1);
    expect(domain.root.items[0]?.replies.items[0]?.id).toBe(legacyId2);
    expect(domain.root.items[0]?.replies.items[0]?.replies.items).toHaveLength(0);
  });
});
