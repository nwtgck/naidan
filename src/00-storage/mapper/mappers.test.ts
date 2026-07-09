import { describe, it, expect } from 'vitest';
import {
  buildSidebarItemsFromHierarchy,
  chatToDomain,
  chatToDto,
  lmParametersToDomain,
  lmParametersToDto,
  messageNodeToDomain,
  messageNodeToDto,
  settingsToDomain,
  settingsToDto,
} from './mappers';
import type {
  AssistantMessageNode,
  Chat,
  ChatGroup,
  ChatMeta,
  Hierarchy,
  Settings,
  SystemMessageNode,
  UserMessageNode,
} from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import {
  SettingsSchemaDto,
  type ChatDto,
  type MessageNodeDto,
  type SettingsDto,
} from '@/00-storage/00-dto/dto';
import {
  toAttachmentId,
  toBinaryObjectId,
  toChatGroupId,
  toChatId,
  toMessageId,
  toProviderProfileId,
  toToolCallId,
  toVolumeId,
} from '@/01-models/ids';

describe('MessageNode Mapping (Discriminated Union)', () => {
  it('should map user message with lmParameters and thinking: undefined', () => {
    const dto: MessageNodeDto = {
      id: 'm1',
      role: 'user',
      content: 'Hello',
      timestamp: 100,
      attachments: undefined,
      thinking: undefined,
      modelId: undefined,
      lmParameters: {
        temperature: 0.7,
        topP: undefined,
        maxCompletionTokens: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: { effort: 'low' },
      },
      replies: { items: [] },
      toolCalls: undefined,
      results: undefined,
    };

    const domain = messageNodeToDomain({ dto }) as UserMessageNode;
    expect(domain.role).toBe('user');
    expect(domain.thinking).toBeUndefined();
    expect(domain.modelId).toBeUndefined();
    expect(domain.lmParameters?.reasoning.effort).toBe('low');

    const backToDto = messageNodeToDto({ domain }) as Extract<MessageNodeDto, { role: 'user' }>;
    expect(backToDto.role).toBe('user');
    expect(backToDto.thinking).toBeUndefined();
    expect(backToDto.lmParameters?.reasoning?.effort).toBe('low');
  });

  it('should map assistant message with thinking and lmParameters', () => {
    const dto: MessageNodeDto = {
      id: 'm2',
      role: 'assistant',
      content: 'Response',
      timestamp: 200,
      attachments: undefined,
      thinking: 'Thinking...',
      modelId: 'gpt-4',
      lmParameters: {
        temperature: undefined,
        topP: undefined,
        maxCompletionTokens: undefined,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: { effort: 'high' },
      },
      replies: { items: [] },
      toolCalls: undefined,
      results: undefined,
    };

    const domain = messageNodeToDomain({ dto }) as AssistantMessageNode;
    expect(domain.role).toBe('assistant');
    expect(domain.thinking).toBe('Thinking...');
    expect(domain.modelId).toBe('gpt-4');
    expect(domain.lmParameters?.reasoning.effort).toBe('high');

    const backToDto = messageNodeToDto({ domain }) as Extract<MessageNodeDto, { role: 'assistant' }>;
    expect(backToDto.thinking).toBe('Thinking...');
    expect(backToDto.modelId).toBe('gpt-4');
    expect(backToDto.lmParameters?.reasoning?.effort).toBe('high');
  });

  it('should map system message with all role-specific fields as undefined', () => {
    const dto: MessageNodeDto = {
      id: 'm3',
      role: 'system',
      content: 'System Prompt',
      timestamp: 50,
      attachments: undefined,
      thinking: undefined,
      modelId: undefined,
      lmParameters: undefined,
      replies: { items: [] },
      toolCalls: undefined,
      results: undefined,
    };

    const domain = messageNodeToDomain({ dto }) as SystemMessageNode;
    expect(domain.role).toBe('system');
    expect(domain.attachments).toBeUndefined();
    expect(domain.thinking).toBeUndefined();
    expect(domain.modelId).toBeUndefined();
    expect(domain.lmParameters).toBeUndefined();

    const backToDto = messageNodeToDto({ domain });
    expect(backToDto.role).toBe('system');
    expect(backToDto.thinking).toBeUndefined();
  });
});

describe('Chat Mapping', () => {
  it('preserves all currently persisted chat fields through bidirectional mapping', () => {
    const chatId = toChatId({ raw: 'chat-complete' });
    const groupId = toChatGroupId({ raw: 'group-complete' });
    const currentLeafId = toMessageId({ raw: 'message-tool' });
    const originChatId = toChatId({ raw: 'chat-origin' });
    const originMessageId = toMessageId({ raw: 'message-origin' });
    const binaryObjectId = toBinaryObjectId({ raw: 'binary-result' });
    const toolCallId = toToolCallId({ raw: 'tool-call-primary' });
    const secondToolCallId = toToolCallId({ raw: 'tool-call-secondary' });
    const volumeId = toVolumeId({ raw: 'volume-chat' });
    const lmParameters = {
      temperature: 0.4,
      topP: 0.8,
      maxCompletionTokens: 321,
      presencePenalty: 0.2,
      frequencyPenalty: 0.3,
      stop: ['DONE'],
      reasoning: { effort: 'high' as const },
    };
    const toolConfigs = [
      { key: 'builtin.calculator' as const, status: 'enabled' as const },
      { key: 'builtin.choices' as const, status: 'disabled' as const },
      { key: 'builtin.wikipedia' as const, status: 'enabled' as const },
      {
        key: 'builtin.wesh' as const,
        status: 'enabled' as const,
        naidanSysfs: { accessScope: 'current_chat_with_chat_group' as const },
      },
    ];
    const chat: Chat = {
      id: chatId,
      title: 'Complete Chat',
      groupId,
      root: {
        items: [
          {
            id: toMessageId({ raw: 'message-user' }),
            role: 'user',
            content: 'Hello',
            timestamp: 100,
            attachments: [{
              id: toAttachmentId({ raw: 'attachment-1' }),
              binaryObjectId,
              originalName: 'attachment.txt',
              mimeType: 'text/plain',
              size: 123,
              uploadedAt: 456,
              status: 'persisted',
            }],
            lmParameters,
            replies: {
              items: [{
                id: toMessageId({ raw: 'message-assistant' }),
                role: 'assistant',
                content: 'Assistant response',
                timestamp: 200,
                thinking: 'Thinking trace',
                modelId: 'assistant-model',
                lmParameters,
                toolCalls: [{
                  id: toolCallId,
                  type: 'function',
                  function: {
                    name: 'calculator',
                    arguments: '{"expression":"1+1"}',
                  },
                }],
                replies: { items: [] },
              }],
            },
          },
          {
            id: toMessageId({ raw: 'message-system' }),
            role: 'system',
            content: 'System message',
            timestamp: 150,
            attachments: undefined,
            thinking: undefined,
            error: undefined,
            modelId: undefined,
            lmParameters: undefined,
            toolCalls: undefined,
            results: undefined,
            replies: { items: [] },
          },
          {
            id: currentLeafId,
            role: 'tool',
            content: undefined,
            timestamp: 300,
            attachments: undefined,
            thinking: undefined,
            error: undefined,
            modelId: undefined,
            lmParameters: undefined,
            toolCalls: undefined,
            results: [
              { toolCallId, status: 'executing' },
              { toolCallId, status: 'success', content: { type: 'text', text: '2' } },
              { toolCallId: secondToolCallId, status: 'success', content: { type: 'binary_object', id: binaryObjectId } },
              {
                toolCallId: secondToolCallId,
                status: 'error',
                error: {
                  code: 'execution_failed',
                  message: { type: 'binary_object', id: binaryObjectId },
                },
              },
            ],
            replies: { items: [] },
          },
        ],
      },
      currentLeafId,
      createdAt: 10,
      updatedAt: 20,
      debugEnabled: true,
      endpoint: {
        type: 'ollama',
        url: 'http://localhost:11434',
        httpHeaders: [['X-Chat', 'true']],
      },
      modelId: 'chat-model',
      titleGeneration: 'disabled',
      originChatId,
      originMessageId,
      systemPrompt: { behavior: 'override', content: null },
      lmParameters,
      mounts: [{ type: 'volume', volumeId, mountPath: '/mnt/chat', readOnly: true }],
      toolConfigs,
    };

    const dto = chatToDto({ domain: chat });
    const expectedDto: ChatDto = {
      id: 'chat-complete',
      experimental: { toolConfigs },
      title: 'Complete Chat',
      currentLeafId: 'message-tool',
      updatedAt: 20,
      createdAt: 10,
      debugEnabled: true,
      endpoint: {
        type: 'ollama',
        experimental: undefined,
        url: 'http://localhost:11434',
        httpHeaders: [['X-Chat', 'true']],
      },
      modelId: 'chat-model',
      titleGeneration: 'disabled',
      originChatId: 'chat-origin',
      originMessageId: 'message-origin',
      systemPrompt: { behavior: 'override', content: null },
      lmParameters,
      mounts: [{
        type: 'volume',
        experimental: undefined,
        volumeId: 'volume-chat',
        mountPath: '/mnt/chat',
        readOnly: true,
      }],
      root: {
        items: [
          {
            id: 'message-user',
            role: 'user',
            content: 'Hello',
            timestamp: 100,
            attachments: [{
              id: 'attachment-1',
              binaryObjectId: 'binary-result',
              name: 'attachment.txt',
              status: 'persisted',
            }],
            thinking: undefined,
            modelId: undefined,
            lmParameters,
            toolCalls: undefined,
            results: undefined,
            replies: {
              items: [{
                id: 'message-assistant',
                role: 'assistant',
                content: 'Assistant response',
                timestamp: 200,
                attachments: undefined,
                thinking: 'Thinking trace',
                modelId: 'assistant-model',
                lmParameters,
                toolCalls: [{
                  id: 'tool-call-primary',
                  type: 'function',
                  function: {
                    name: 'calculator',
                    arguments: '{"expression":"1+1"}',
                  },
                }],
                results: undefined,
                replies: { items: [] },
              }],
            },
          },
          {
            id: 'message-system',
            role: 'system',
            content: 'System message',
            timestamp: 150,
            attachments: undefined,
            thinking: undefined,
            modelId: undefined,
            lmParameters: undefined,
            toolCalls: undefined,
            results: undefined,
            replies: { items: [] },
          },
          {
            id: 'message-tool',
            role: 'tool',
            content: undefined,
            timestamp: 300,
            attachments: undefined,
            thinking: undefined,
            modelId: undefined,
            lmParameters: undefined,
            toolCalls: undefined,
            results: [
              { toolCallId: 'tool-call-primary', status: 'executing' },
              { toolCallId: 'tool-call-primary', status: 'success', content: { type: 'text', text: '2' } },
              { toolCallId: 'tool-call-secondary', status: 'success', content: { type: 'binary_object', id: 'binary-result' } },
              {
                toolCallId: 'tool-call-secondary',
                status: 'error',
                error: {
                  code: 'execution_failed',
                  message: { type: 'binary_object', id: 'binary-result' },
                },
              },
            ],
            replies: { items: [] },
          },
        ],
        experimental: undefined,
      },
      messages: undefined,
    };

    expect(dto).toMatchObject(expectedDto);
    expect(dto).not.toHaveProperty('autoTitleEnabled');
    expect(dto).not.toHaveProperty('titleModelId');
    expect(chatToDto({ domain: chatToDomain({ dto }) })).toEqual(dto);
  });
});

describe('LmParameters Mapping', () => {
  it('should handle undefined reasoning in DTO by providing default reasoning object in domain', () => {
    const domain = lmParametersToDomain({ dto: {
      temperature: 0.5,
      topP: undefined,
      maxCompletionTokens: undefined,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      stop: undefined,
      reasoning: undefined,
    } });
    expect(domain).toBeDefined();
    if (domain === undefined) throw new Error('Expected LM parameters');
    expect(domain.temperature).toBe(0.5);
    expect(domain.reasoning).toBeDefined();
    expect(domain.reasoning.effort).toBeUndefined();
  });

  it('preserves_all_LM_parameters_through_bidirectional_mapping', () => {
    const domain = {
      temperature: 0.4,
      topP: 0.8,
      maxCompletionTokens: 321,
      presencePenalty: 0.2,
      frequencyPenalty: 0.3,
      stop: ['DONE'],
      reasoning: { effort: 'high' as const },
    };

    const dto = lmParametersToDto({ domain });
    expect(dto).toEqual(domain);
    expect(lmParametersToDomain({ dto })).toEqual(domain);
  });

  it('should preserve reasoning effort through bidirectional mapping', () => {
    const original = { effort: 'medium' as const };
    const dto = lmParametersToDto({ domain: {
      temperature: 1.0,
      topP: undefined,
      maxCompletionTokens: undefined,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      stop: undefined,
      reasoning: original,
    } });
    expect(dto?.reasoning?.effort).toBe('medium');

    const backToDomain = lmParametersToDomain({ dto });
    expect(backToDomain).toBeDefined();
    if (backToDomain === undefined) throw new Error('Expected LM parameters');
    expect(backToDomain.reasoning.effort).toBe('medium');
  });
});

describe('Sidebar assembly', () => {
  it('should filter out orphan chat entries from hierarchy', () => {
    const hierarchy: Hierarchy = {
      items: [
        { type: 'chat', id: toChatId({ raw: 'exists' }) },
        { type: 'chat', id: toChatId({ raw: 'orphan' }) },
      ],
    };
    const metas: ChatMeta[] = [
      { id: toChatId({ raw: 'exists' }), title: 'Exists', updatedAt: 100, createdAt: 100, debugEnabled: false },
    ];
    const groups: ChatGroup[] = [];

    const items = buildSidebarItemsFromHierarchy({ hierarchy, chatMetas: metas, chatGroups: groups });
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('chat:exists');
  });

  it('should filter out orphan groups from hierarchy', () => {
    const hierarchy: Hierarchy = {
      items: [
        { type: 'chat_group', id: toChatGroupId({ raw: 'orphan-group' }), chat_ids: [] },
      ],
    };
    const items = buildSidebarItemsFromHierarchy({ hierarchy, chatMetas: [], chatGroups: [] });
    expect(items).toHaveLength(0);
  });
});

describe('Settings Mapping', () => {
  it('defaults experimental setting modes to disabled when experimental settings are missing', () => {
    const dto: SettingsDto = {
      endpoint: { type: 'openai', url: 'http://localhost', httpHeaders: undefined },
      defaultModelId: 'gpt-4',
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      storageType: 'local',
      providerProfiles: [],
      mounts: [],
      heavyContentAlertDismissed: undefined,
      systemPrompt: undefined,
      lmParameters: undefined,
      experimental: undefined,
    };

    const domain = settingsToDomain({ dto });

    expect(domain.experimental?.toolConfigPersistence).toBe('disabled');
    expect(domain.experimental?.fakeLm).toBe('disabled');
    expect(domain.experimental?.sidebarSendMessageReorder).toBe('disabled');
    expect(domain.experimental?.locale).toBeUndefined();
  });

  it('roundtrips title generation reasoning parameters through settings DTO', () => {
    const domain: Settings = {
      endpoint: { type: 'openai', url: 'http://localhost' },
      defaultModelId: 'gpt-4',
      titleGeneration: {
        endpoint: 'same_scope',
        model: 'same_scope',
        lmParameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: 'low' },
        },
      },
      storageType: 'local',
      providerProfiles: [],
      mounts: [],
    };

    const dto = settingsToDto({ domain });
    const dtoTitleGeneration = (dto as { titleGeneration: Settings['titleGeneration'] }).titleGeneration;
    expect(dtoTitleGeneration).not.toBe('disabled');
    if (dtoTitleGeneration !== 'disabled') {
      expect(dtoTitleGeneration.lmParameters).not.toBe('same_scope');
      if (dtoTitleGeneration.lmParameters !== 'same_scope') {
        expect(dtoTitleGeneration.lmParameters?.reasoning.effort).toBe('low');
      }
    }

    const remapped = settingsToDomain({ dto });
    expect(remapped.titleGeneration).not.toBe('disabled');
    if (remapped.titleGeneration !== 'disabled') {
      expect(remapped.titleGeneration.lmParameters).not.toBe('same_scope');
      if (remapped.titleGeneration.lmParameters !== 'same_scope') {
        expect(remapped.titleGeneration.lmParameters?.reasoning.effort).toBe('low');
      }
    }
  });

  it('keeps settings readable when only an experimental endpoint identifier is unsupported', () => {
    const dto = {
      endpoint: {
        type: 'experimental_type',
        experimental: {
          type: 'future_browser_ai',
          futureMode: 'local_only',
        },
      },
      defaultModelId: 'future-model',
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      storageType: 'local',
      providerProfiles: [],
      mounts: [],
      heavyContentAlertDismissed: false,
      systemPrompt: 'Keep the rest of settings readable.',
      lmParameters: undefined,
      experimental: undefined,
    };

    const parsed = SettingsSchemaDto.parse(dto);
    const domain = settingsToDomain({ dto: parsed });

    expect(domain.endpoint).toEqual({
      type: 'unsupported_experimental_endpoint',
      persistedType: 'future_browser_ai',
    });
    expect(domain.defaultModelId).toBe('future-model');
    expect(domain.systemPrompt).toBe('Keep the rest of settings readable.');
    expect(domain.storageType).toBe('local');
  });

  it('keeps a non-string experimental endpoint identifier local to that endpoint', () => {
    const dto = {
      endpoint: {
        type: 'experimental_type',
        experimental: {
          type: 42,
          futureMode: 'local_only',
        },
      },
      defaultModelId: 'future-model',
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      storageType: 'local',
      providerProfiles: [],
      mounts: [],
      heavyContentAlertDismissed: false,
      systemPrompt: 'Keep the rest of settings readable.',
      lmParameters: undefined,
      experimental: undefined,
    };

    const parsed = SettingsSchemaDto.parse(dto);
    const domain = settingsToDomain({ dto: parsed });

    expect(domain.endpoint).toEqual({
      type: 'unsupported_experimental_endpoint',
      persistedType: undefined,
    });
    expect(domain.defaultModelId).toBe('future-model');
    expect(domain.systemPrompt).toBe('Keep the rest of settings readable.');
  });

  it('maps the browser-provided LM domain endpoint through the experimental DTO envelope', () => {
    const domain: Settings = {
      endpoint: { type: 'browser_provided_lm' },
      defaultModelId: 'browser-provided-language-model',
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      storageType: 'local',
      providerProfiles: [],
      mounts: [],
    };

    const dto = settingsToDto({ domain });
    expect(dto.endpoint).toEqual({
      type: 'experimental_type',
      experimental: { type: 'browser_provided_lm' },
    });
    const remapped = settingsToDomain({ dto });
    expect(remapped.endpoint).toEqual(domain.endpoint);
    expect(remapped.defaultModelId).toBe(domain.defaultModelId);
    expect(remapped.titleGeneration).toEqual(domain.titleGeneration);
    expect(remapped.storageType).toBe(domain.storageType);
  });

  it('keeps the browser-provided LM readable when future experimental fields are present', () => {
    const dto = {
      endpoint: {
        type: 'experimental_type',
        experimental: {
          type: 'browser_provided_lm',
          futureSessionMode: 'persistent',
        },
      },
      defaultModelId: 'browser-provided-language-model',
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      storageType: 'local',
      providerProfiles: [],
      mounts: [],
      heavyContentAlertDismissed: false,
      systemPrompt: undefined,
      lmParameters: undefined,
      experimental: undefined,
    };

    const parsed = SettingsSchemaDto.parse(dto);
    const domain = settingsToDomain({ dto: parsed });

    expect(domain.endpoint).toEqual({ type: 'browser_provided_lm' });
    expect(domain.defaultModelId).toBe('browser-provided-language-model');
  });

  it('preserves an empty HTTP URL through settings mapping', () => {
    const domain: Settings = {
      endpoint: { type: 'openai', url: '' },
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      storageType: 'local',
      providerProfiles: [],
      mounts: [],
    };

    const dto = settingsToDto({ domain });
    const mapped = settingsToDomain({ dto });

    expect(dto.endpoint).toEqual({ type: 'openai', url: '' });
    expect(mapped.endpoint).toEqual({ type: 'openai', url: '' });
  });

  it('omits disabled fake LM mode from the settings DTO', () => {
    const domain: Settings = {
      endpoint: { type: 'openai', url: 'http://localhost' },
      defaultModelId: 'gpt-4',
      titleGeneration: { endpoint: 'same_scope', model: 'same_scope', lmParameters: { temperature: undefined, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
      storageType: 'local',
      providerProfiles: [],
      mounts: [],
      heavyContentAlertDismissed: false,
      systemPrompt: undefined,
      lmParameters: undefined,
      experimental: {
        fakeLm: 'disabled',
      },
    };

    expect(settingsToDto({ domain }).experimental?.fakeLm).toBeUndefined();
  });

  it('preserves all currently persisted settings fields through settings mapping', () => {
    const lmParameters = {
      temperature: 0.4,
      topP: 0.8,
      maxCompletionTokens: 321,
      presencePenalty: 0.2,
      frequencyPenalty: 0.3,
      stop: ['DONE'],
      reasoning: { effort: 'medium' as const },
    };
    const toolConfigs = [
      { key: 'builtin.calculator' as const, status: 'enabled' as const },
      { key: 'builtin.choices' as const, status: 'disabled' as const },
      { key: 'builtin.wikipedia' as const, status: 'enabled' as const },
      {
        key: 'builtin.wesh' as const,
        status: 'enabled' as const,
        naidanSysfs: { accessScope: 'main_chats' as const },
      },
    ];
    const domain: Settings = {
      endpoint: {
        type: 'openai',
        url: 'https://api.example.test/v1',
        httpHeaders: [['Authorization', 'Bearer token']],
      },
      defaultModelId: 'gpt-4.1',
      titleGeneration: 'disabled',
      storageType: 'opfs',
      providerProfiles: [{
        id: toProviderProfileId({ raw: 'provider-profile-1' }),
        name: 'Profile 1',
        endpoint: {
          type: 'ollama',
          url: 'http://localhost:11434',
          httpHeaders: [['X-Profile', 'yes']],
        },
        defaultModelId: 'llama3',
        titleModelId: 'llama3-title',
        systemPrompt: 'Profile prompt',
        lmParameters,
      }],
      mounts: [{
        type: 'volume',
        volumeId: toVolumeId({ raw: 'volume-settings' }),
        mountPath: '/mnt/settings',
        readOnly: true,
      }],
      heavyContentAlertDismissed: true,
      systemPrompt: 'Global prompt',
      lmParameters,
      experimental: {
        locale: 'ja',
        markdownRendering: 'monolithic_html',
        toolConfigPersistence: 'enabled',
        toolConfigs,
        fakeLm: 'enabled',
        sidebarSendMessageReorder: 'move_sent_chat',
        globalSearch: {
          scope: 'title_only',
          roleFilter: 'user',
          previewMode: 'always',
          previewContextSize: 'full',
        },
      },
    };

    const dto = settingsToDto({ domain });
    const expectedDto: SettingsDto = {
      endpoint: {
        type: 'openai',
        experimental: undefined,
        url: 'https://api.example.test/v1',
        httpHeaders: [['Authorization', 'Bearer token']],
      },
      defaultModelId: 'gpt-4.1',
      titleGeneration: 'disabled',
      storageType: 'opfs',
      providerProfiles: [{
        id: 'provider-profile-1',
        experimental: undefined,
        name: 'Profile 1',
        endpoint: {
          type: 'ollama',
          experimental: undefined,
          url: 'http://localhost:11434',
          httpHeaders: [['X-Profile', 'yes']],
        },
        defaultModelId: 'llama3',
        titleModelId: 'llama3-title',
        systemPrompt: 'Profile prompt',
        lmParameters,
      }],
      mounts: [{
        type: 'volume',
        experimental: undefined,
        volumeId: 'volume-settings',
        mountPath: '/mnt/settings',
        readOnly: true,
      }],
      heavyContentAlertDismissed: true,
      systemPrompt: 'Global prompt',
      lmParameters,
      experimental: {
        locale: 'ja',
        markdownRendering: 'monolithic_html',
        toolConfigPersistence: 'enabled',
        toolConfigs,
        fakeLm: 'enabled',
        sidebarSendMessageReorder: 'move_sent_chat',
        globalSearch: {
          scope: 'title_only',
          roleFilter: 'user',
          previewMode: 'always',
          previewContextSize: 'full',
        },
        unreadable: undefined,
      },
    };

    expect(dto).toMatchObject(expectedDto);
    expect(dto).not.toHaveProperty('autoTitleEnabled');
    expect(dto).not.toHaveProperty('titleModelId');
    expect(settingsToDto({ domain: settingsToDomain({ dto }) })).toEqual(dto);
  });
});

describe('Legacy Migration (Flat to Tree)', () => {
  it('should migrate linear messages to a recursive tree structure', () => {
    const legacyId1 = 'legacy-message-1';
    const legacyId2 = 'legacy-message-2';
    const legacyChat: any = {
      id: 'legacy-chat-1',
      title: 'Legacy',
      messages: [
        { id: legacyId1, role: 'user', content: 'Hi', timestamp: 1 },
        { id: legacyId2, role: 'assistant', content: 'Hello', timestamp: 2 },
      ],
      modelId: 'gpt-4',
      createdAt: 1,
      updatedAt: 2,
    };

    const domain = chatToDomain({ dto: legacyChat });

    expect(domain.root.items).toHaveLength(1);
    expect(domain.root.items[0]?.id).toBe(legacyId1);
    expect(domain.root.items[0]?.replies.items).toHaveLength(1);
    expect(domain.root.items[0]?.replies.items[0]?.id).toBe(legacyId2);
    expect(domain.root.items[0]?.replies.items[0]?.replies.items).toHaveLength(0);
  });
});
