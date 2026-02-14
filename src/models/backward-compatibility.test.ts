import { describe, it, expect } from 'vitest';
import { ChatSchemaDto } from './dto';
import { chatToDomain } from './mappers';

describe('DTO Backward Compatibility', () => {
  /**
   * TEST SET: Initial Version (v1)
   * Description: Original structure before adding per-chat overrides or other features.
   */
  it('should load v1 chat data (minimal original structure)', () => {
    const v1LegacyData = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      title: 'Legacy Chat',
      messages: [
        {
          id: '660e8400-e29b-41d4-a716-446655440001',
          role: 'user',
          content: 'Hello',
          timestamp: 1700000000000,
        },
      ],
      modelId: 'gpt-3.5-turbo',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      // Note: debugEnabled, endpointType, etc. are missing
    };

    // 1. Validate DTO parsing (Zod should handle defaults/optionals)
    const dto = ChatSchemaDto.parse(v1LegacyData);

    // 2. Map to Domain
    const domain = chatToDomain(dto);

    // 3. Verify expectations
    expect(domain.id).toBe(v1LegacyData.id);
    expect(domain.debugEnabled).toBe(false); // Default should be applied
    expect(domain.endpointType).toBeUndefined(); // Should be optional

    // In new tree structure, we check root.items
    expect(domain.root.items[0]?.id).toBe(v1LegacyData.messages[0]?.id);
    expect(domain.root.items[0]?.role).toBe('user');
  });

  /**
   * TEST SET: v1.1 (Added debugEnabled)
   */
  it('should load v1.1 chat data (added debugEnabled)', () => {
    const v1_1Data = {
      id: '550e8400-e29b-41d4-a716-446655440002',
      title: 'Debug Chat',
      messages: [],
      modelId: 'gpt-4',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      debugEnabled: true,
    };

    const dto = ChatSchemaDto.parse(v1_1Data);
    const domain = chatToDomain(dto);

    expect(domain.debugEnabled).toBe(true);
  });

  /**
   * TEST SET: v1.2 (Added fork origins)
   */
  it('should load v1.2 chat data (added fork origins)', () => {
    const v1_2Data = {
      id: '550e8400-e29b-41d4-a716-446655440003',
      title: 'Forked Chat',
      messages: [],
      modelId: 'gpt-4',
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
      originChatId: '550e8400-e29b-41d4-a716-446655440000',
      originMessageId: '660e8400-e29b-41d4-a716-446655440001',
    };

    const dto = ChatSchemaDto.parse(v1_2Data);
    const domain = chatToDomain(dto);

    expect(domain.originChatId).toBe(v1_2Data.originChatId);
    expect(domain.originMessageId).toBe(v1_2Data.originMessageId);
  });
});
