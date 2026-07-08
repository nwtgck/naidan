import { describe, it, expect } from 'vitest';
import {
  ChatGroupSchemaDtoV2,
  ChatMetaSchemaDtoV2,
  ChatSchemaDto,
  SettingsSchemaDtoV2,
} from './dto';

const endpoint = { type: 'openai' as const, url: 'https://example.test/v1' };

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

  it('requires inline titleGeneration in V2 settings DTO', () => {
    expect(SettingsSchemaDtoV2.safeParse({
      endpoint,
      defaultModelId: undefined,
      storageType: 'opfs',
      providerProfiles: [],
      mounts: [],
      heavyContentAlertDismissed: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
      experimental: undefined,
    }).success).toBe(false);
  });

  it('accepts same_scope and explicit title generation settings in V2 settings DTO', () => {
    expect(SettingsSchemaDtoV2.safeParse({
      endpoint,
      defaultModelId: undefined,
      titleGeneration: {
        endpoint: 'same_scope',
        model: 'same_scope',
      },
      storageType: 'opfs',
      providerProfiles: [],
      mounts: [],
      heavyContentAlertDismissed: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
      experimental: undefined,
    }).success).toBe(true);

    expect(SettingsSchemaDtoV2.safeParse({
      endpoint,
      defaultModelId: undefined,
      titleGeneration: {
        endpoint,
        model: { id: 'title-model' },
      },
      storageType: 'opfs',
      providerProfiles: [],
      mounts: [],
      heavyContentAlertDismissed: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
      experimental: undefined,
    }).success).toBe(true);
  });

  it('does not allow inherit or explicit endpoint plus same_scope model in V2 settings DTO', () => {
    expect(SettingsSchemaDtoV2.safeParse({
      endpoint,
      defaultModelId: undefined,
      titleGeneration: 'inherit',
      storageType: 'opfs',
      providerProfiles: [],
      mounts: [],
      heavyContentAlertDismissed: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
      experimental: undefined,
    }).success).toBe(false);

    expect(SettingsSchemaDtoV2.safeParse({
      endpoint,
      defaultModelId: undefined,
      titleGeneration: {
        endpoint,
        model: 'same_scope',
      },
      storageType: 'opfs',
      providerProfiles: [],
      mounts: [],
      heavyContentAlertDismissed: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
      experimental: undefined,
    }).success).toBe(false);
  });

  it('allows inherit only in scoped V2 title generation DTO fields', () => {
    expect(ChatGroupSchemaDtoV2.safeParse({
      id: 'group-id',
      experimental: undefined,
      name: 'Group',
      updatedAt: 123,
      isCollapsed: false,
      endpoint: undefined,
      modelId: undefined,
      titleGeneration: 'inherit',
      systemPrompt: undefined,
      lmParameters: undefined,
      mounts: undefined,
    }).success).toBe(true);

    expect(ChatMetaSchemaDtoV2.safeParse({
      id: 'chat-id',
      experimental: undefined,
      title: null,
      currentLeafId: undefined,
      updatedAt: 123,
      createdAt: 123,
      debugEnabled: false,
      endpoint: undefined,
      modelId: undefined,
      titleGeneration: 'inherit',
      originChatId: undefined,
      originMessageId: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
      mounts: undefined,
    }).success).toBe(true);
  });
});
