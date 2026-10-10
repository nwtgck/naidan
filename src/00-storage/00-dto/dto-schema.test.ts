import { describe, it, expect, vi } from 'vitest';
import {
  ChatGroupSchemaDtoV2,
  ChatMetaSchemaDtoV2,
  ChatSchemaDto,
  SettingsSchemaDtoV2,
} from './dto';

const endpoint = { type: 'openai' as const, url: 'https://example.test/v1' };

const emptyLmParametersDto = {
  temperature: undefined,
  topP: undefined,
  maxCompletionTokens: undefined,
  presencePenalty: undefined,
  frequencyPenalty: undefined,
  stop: undefined,
  reasoning: { effort: undefined },
};

const settingsDtoBase = {
  endpoint,
  defaultModelId: undefined,
  storageType: 'opfs' as const,
  providerProfiles: [],
  mounts: [],
  heavyContentAlertDismissed: undefined,
  systemPrompt: undefined,
  lmParameters: undefined,
  experimental: undefined,
};

describe('DTO module initialization', () => {
  it.each(['basic', 'experimental', 'image', 'rpc'] as const)(
    'loads image preferences and translation with %s imported first',
    async first => {
      vi.resetModules();
      switch (first) {
      case 'basic':
        await import('./dto');
        break;
      case 'experimental':
        await import('./experimental.dto');
        break;
      case 'image':
        await import('./experimental-image-generation.dto');
        break;
      case 'rpc':
        await import('./experimental-naidan-rpc.dto');
        break;
      default: {
        const _ex: never = first;
        throw new Error(`Unexpected DTO entry: ${_ex}`);
      }
      }

      const { SettingsSchemaDtoV2 } = await import('./dto');
      const { ExperimentalImageGenerationTranslationOverrideSchemaDto } = await import('./experimental-image-generation.dto');
      const registrationId = 'connection-1';
      const peerPublicKey = 'A'.repeat(43);
      const rpcEndpoint = {
        type: 'experimental_type',
        experimental: { endpoint: { type: 'naidan_rpc', registrationId } },
      };
      const inferenceLocation = { kind: 'naidan_rpc', registration: { registrationId, peerPublicKey } };
      const remoteModelEditors = [{
        registrationId,
        peerPublicKey,
        editor: { primary: undefined, components: [], loras: [] },
      }];
      const settings = SettingsSchemaDtoV2.parse({
        ...settingsDtoBase,
        endpoint: rpcEndpoint,
        titleGeneration: 'disabled',
        experimental: { browserImageGeneration: { inferenceLocation, remoteModelEditors } },
      });
      expect(settings.experimental?.browserImageGeneration?.inferenceLocation).toEqual(inferenceLocation);
      expect(settings.experimental?.browserImageGeneration?.remoteModelEditors).toEqual(remoteModelEditors);

      const translation = ExperimentalImageGenerationTranslationOverrideSchemaDto.parse({
        endpoint: rpcEndpoint,
        modelId: 'translation-model',
      });
      expect(translation.endpoint).toEqual(settings.endpoint);
      expect(translation.modelId).toBe('translation-model');
    },
  );
});

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
            lmParameters: emptyLmParametersDto,
            replies: { items: [] },
          },
        ],
      },
      modelId: 'gpt-4',
      titleGeneration: 'inherit',
      createdAt: 123,
      updatedAt: 123,
      debugEnabled: false,
    };

    expect(() => ChatSchemaDto.parse(chat)).not.toThrow();
  });

  it('requires inline titleGeneration in V2 settings DTO', () => {
    expect(SettingsSchemaDtoV2.safeParse(settingsDtoBase).success).toBe(false);
  });

  it('accepts same_scope and explicit title generation settings in V2 settings DTO', () => {
    expect(SettingsSchemaDtoV2.safeParse({
      ...settingsDtoBase,
      titleGeneration: {
        endpoint: 'same_scope',
        model: 'same_scope',
        lmParameters: emptyLmParametersDto,
      },
    }).success).toBe(true);

    expect(SettingsSchemaDtoV2.safeParse({
      ...settingsDtoBase,
      titleGeneration: {
        endpoint,
        model: { id: 'title-model' },
        lmParameters: emptyLmParametersDto,
      },
    }).success).toBe(true);
  });

  it('requires title generation lmParameters in V2 titleGeneration objects', () => {
    expect(SettingsSchemaDtoV2.safeParse({
      ...settingsDtoBase,
      titleGeneration: {
        endpoint: 'same_scope',
        model: 'same_scope',
      },
    }).success).toBe(false);

    expect(SettingsSchemaDtoV2.safeParse({
      ...settingsDtoBase,
      titleGeneration: {
        endpoint: 'same_scope',
        model: 'same_scope',
        lmParameters: emptyLmParametersDto,
      },
    }).success).toBe(true);

    expect(SettingsSchemaDtoV2.safeParse({
      ...settingsDtoBase,
      titleGeneration: {
        endpoint: 'same_scope',
        model: 'same_scope',
        lmParameters: 'same_scope',
      },
    }).success).toBe(true);

    expect(SettingsSchemaDtoV2.safeParse({
      ...settingsDtoBase,
      titleGeneration: {
        endpoint,
        model: { id: 'title-model' },
        lmParameters: { reasoning: { effort: 'low' } },
      },
    }).success).toBe(true);

    expect(SettingsSchemaDtoV2.safeParse({
      ...settingsDtoBase,
      titleGeneration: {
        endpoint,
        model: { id: 'title-model' },
        lmParameters: 'same_scope',
      },
    }).success).toBe(false);
  });

  it('does not allow inherit or explicit endpoint plus same_scope model in V2 settings DTO', () => {
    expect(SettingsSchemaDtoV2.safeParse({
      ...settingsDtoBase,
      titleGeneration: 'inherit',
    }).success).toBe(false);

    expect(SettingsSchemaDtoV2.safeParse({
      ...settingsDtoBase,
      titleGeneration: {
        endpoint,
        model: 'same_scope',
        lmParameters: emptyLmParametersDto,
      },
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
