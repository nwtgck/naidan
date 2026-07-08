import { describe, it, expect } from 'vitest';
import { resolveChatSettings, hasChatOverrides, hasGroupOverrides, type ResolvableSettings } from './chat-settings-resolver';
import type { Chat, ChatGroup } from '@/01-models/types';
import { EMPTY_LM_PARAMETERS } from '@/01-models/types';
import { toChatGroupId, toChatId } from '@/01-models/ids';

describe('resolveChatSettings - System Prompt Edge Cases', () => {
  const globalSettings: ResolvableSettings = {
    endpoint: { type: 'openai', url: '' },
    systemPrompt: 'Global Prompt',
  };

  const baseChat: Chat = {
    id: toChatId({ raw: 'chat-1' }),
    title: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    debugEnabled: false,
    root: { items: [] },
  };

  it('resolves the entire endpoint from exactly one scope', () => {
    const globalEndpoint = {
      type: 'openai' as const,
      url: 'https://global.example/v1',
      httpHeaders: [['X-Scope', 'global']] as [string, string][],
    };
    const groupEndpoint = {
      type: 'ollama' as const,
      url: 'https://group.example',
      httpHeaders: [['X-Scope', 'group']] as [string, string][],
    };
    const chatEndpoint = {
      type: 'openai' as const,
      url: 'https://chat.example/v1',
      httpHeaders: [['X-Scope', 'chat']] as [string, string][],
    };
    const group: ChatGroup = {
      id: toChatGroupId({ raw: 'group-endpoint' }),
      name: 'Endpoint Group',
      isCollapsed: false,
      updatedAt: 0,
      items: [],
      endpoint: groupEndpoint,
    };
    const settings: ResolvableSettings = { endpoint: globalEndpoint };

    const chatResult = resolveChatSettings({
      chat: { ...baseChat, groupId: group.id, endpoint: chatEndpoint },
      groups: [group],
      globalSettings: settings,
    });
    expect(chatResult.endpoint).toEqual(chatEndpoint);
    expect(chatResult.sources.endpoint).toBe('chat');

    const groupResult = resolveChatSettings({
      chat: { ...baseChat, groupId: group.id },
      groups: [group],
      globalSettings: settings,
    });
    expect(groupResult.endpoint).toEqual(groupEndpoint);
    expect(groupResult.sources.endpoint).toBe('chat_group');

    const globalResult = resolveChatSettings({
      chat: baseChat,
      groups: [group],
      globalSettings: settings,
    });
    expect(globalResult.endpoint).toEqual(globalEndpoint);
    expect(globalResult.sources.endpoint).toBe('global');
  });

  describe('Override Behavior', () => {
    it('should clear global prompt when override content is null (Explicit Clear)', () => {
      const chat: Chat = {
        ...baseChat,
        systemPrompt: { behavior: 'override', content: null },
      };
      const result = resolveChatSettings({ chat, groups: [], globalSettings });
      expect(result.systemPromptMessages).toEqual([]);
    });

    it('should clear global prompt when override content is empty string ("")', () => {
      const chat: Chat = {
        ...baseChat,
        systemPrompt: { behavior: 'override', content: '' },
      };
      const result = resolveChatSettings({ chat, groups: [], globalSettings });
      expect(result.systemPromptMessages).toEqual([]);
    });

    it('should replace global prompt when override content is non-empty', () => {
      const chat: Chat = {
        ...baseChat,
        systemPrompt: { behavior: 'override', content: 'Chat Prompt' },
      };
      const result = resolveChatSettings({ chat, groups: [], globalSettings });
      expect(result.systemPromptMessages).toEqual(['Chat Prompt']);
    });
  });

  describe('Append Behavior', () => {
    it('should NOT add anything when append content is empty string ("")', () => {
      const chat: Chat = {
        ...baseChat,
        systemPrompt: { behavior: 'append', content: '' },
      };
      const result = resolveChatSettings({ chat, groups: [], globalSettings });
      // Global remains, but nothing added
      expect(result.systemPromptMessages).toEqual(['Global Prompt']);
    });

    it('should append to global prompt when append content is non-empty', () => {
      const chat: Chat = {
        ...baseChat,
        systemPrompt: { behavior: 'append', content: 'Extra' },
      };
      const result = resolveChatSettings({ chat, groups: [], globalSettings });
      expect(result.systemPromptMessages).toEqual(['Global Prompt', 'Extra']);
    });
  });

  describe('Hierarchical Resolution (Global -> Group -> Chat)', () => {
    const group: ChatGroup = {
      id: toChatGroupId({ raw: 'group-1' }),
      name: 'Group',
      isCollapsed: false,
      updatedAt: Date.now(),
      items: [],
      systemPrompt: { behavior: 'override', content: 'Group Prompt' },
    };

    it('Chat override:null should clear both Group and Global prompts', () => {
      const chat: Chat = {
        ...baseChat,
        groupId: toChatGroupId({ raw: 'group-1' }),
        systemPrompt: { behavior: 'override', content: null },
      };
      const result = resolveChatSettings({ chat, groups: [group], globalSettings });
      expect(result.systemPromptMessages).toEqual([]);
    });

    it('Chat append should build upon Group override', () => {
      const chat: Chat = {
        ...baseChat,
        groupId: toChatGroupId({ raw: 'group-1' }),
        systemPrompt: { behavior: 'append', content: 'Chat Append' },
      };
      const result = resolveChatSettings({ chat, groups: [group], globalSettings });
      // Group overrides Global, then Chat appends to Group
      expect(result.systemPromptMessages).toEqual(['Group Prompt', 'Chat Append']);
    });

    it('Group override:null should clear Global, allowing Chat append to start from empty', () => {
      const clearGroup: ChatGroup = {
        ...group,
        systemPrompt: { behavior: 'override', content: null },
      };
      const chat: Chat = {
        ...baseChat,
        groupId: toChatGroupId({ raw: 'group-1' }),
        systemPrompt: { behavior: 'append', content: 'Chat Append' },
      };
      const result = resolveChatSettings({ chat, groups: [clearGroup], globalSettings });
      // Global is cleared by Group, result contains only Chat's contribution
      expect(result.systemPromptMessages).toEqual(['Chat Append']);
    });

    it('Group override:"" should also clear Global', () => {
      const emptyGroup: ChatGroup = {
        ...group,
        systemPrompt: { behavior: 'override', content: '' },
      };
      const chat: Chat = {
        ...baseChat,
        groupId: toChatGroupId({ raw: 'group-1' }),
        systemPrompt: { behavior: 'append', content: 'Chat Append' },
      };
      const result = resolveChatSettings({ chat, groups: [emptyGroup], globalSettings });
      expect(result.systemPromptMessages).toEqual(['Chat Append']);
    });
  });

  describe('Automatic Title Settings Resolution', () => {
    const globalSettings: ResolvableSettings = {
      endpoint: { type: 'openai', url: '' },
      autoTitleEnabled: true,
      titleModelId: 'global-title-model',
    };

    it('should resolve global title settings when not overridden', () => {
      const result = resolveChatSettings({ chat: baseChat, groups: [], globalSettings });
      expect(result.autoTitleEnabled).toBe(true);
      expect(result.titleModelId).toBe('global-title-model');
      expect(result.sources.autoTitleEnabled).toBe('global');
      expect(result.sources.titleModelId).toBe('global');
    });

    it('should allow group to override title settings', () => {
      const group: ChatGroup = {
        id: toChatGroupId({ raw: 'group-1' }),
        name: 'Group',
        isCollapsed: false,
        updatedAt: Date.now(),
        items: [],
        autoTitleEnabled: false,
        titleModelId: 'group-title-model',
      };
      const chat: Chat = { ...baseChat, groupId: toChatGroupId({ raw: 'group-1' }) };
      const result = resolveChatSettings({ chat, groups: [group], globalSettings });
      expect(result.autoTitleEnabled).toBe(false);
      expect(result.titleModelId).toBe('');
      expect(result.titleGeneration).toBe('disabled');
      expect(result.sources.autoTitleEnabled).toBe('chat_group');
      expect(result.sources.titleModelId).toBe('chat_group');
    });

    it('should allow chat to override title settings', () => {
      const chat: Chat = {
        ...baseChat,
        autoTitleEnabled: false,
        titleModelId: 'chat-title-model',
      };
      const result = resolveChatSettings({ chat, groups: [], globalSettings });
      expect(result.autoTitleEnabled).toBe(false);
      expect(result.titleModelId).toBe('');
      expect(result.titleGeneration).toBe('disabled');
      expect(result.sources.autoTitleEnabled).toBe('chat');
      expect(result.sources.titleModelId).toBe('chat');
    });

    it('resolves same_scope title generation against the same normal generation scope', () => {
      const globalEndpoint = { type: 'openai' as const, url: 'https://global.example/v1' };
      const groupEndpoint = { type: 'ollama' as const, url: 'https://group.example' };
      const group: ChatGroup = {
        id: toChatGroupId({ raw: 'same-scope-group' }),
        name: 'Same Scope Group',
        isCollapsed: false,
        updatedAt: 0,
        items: [],
        endpoint: groupEndpoint,
        modelId: 'group-chat-model',
        titleGeneration: { endpoint: 'same_scope', model: 'same_scope' },
      };
      const result = resolveChatSettings({
        chat: { ...baseChat, groupId: group.id },
        groups: [group],
        globalSettings: {
          endpoint: globalEndpoint,
          defaultModelId: 'global-chat-model',
          titleGeneration: { endpoint: 'same_scope', model: 'same_scope' },
        },
      });

      expect(result.titleGeneration).toEqual({ endpoint: groupEndpoint, modelId: 'group-chat-model' });
      expect(result.titleModelId).toBe('group-chat-model');
      expect(result.sources.titleGeneration).toBe('chat_group');
    });

    it('inherits the parent resolved title generation instead of re-evaluating parent same_scope in the child scope', () => {
      const globalEndpoint = { type: 'openai' as const, url: 'https://global.example/v1' };
      const groupEndpoint = { type: 'ollama' as const, url: 'https://group.example' };
      const group: ChatGroup = {
        id: toChatGroupId({ raw: 'inherit-resolved-group' }),
        name: 'Inherit Resolved Group',
        isCollapsed: false,
        updatedAt: 0,
        items: [],
        endpoint: groupEndpoint,
        modelId: 'group-chat-model',
        titleGeneration: 'inherit',
      };
      const result = resolveChatSettings({
        chat: { ...baseChat, groupId: group.id },
        groups: [group],
        globalSettings: {
          endpoint: globalEndpoint,
          defaultModelId: 'global-chat-model',
          titleGeneration: { endpoint: 'same_scope', model: 'same_scope' },
        },
      });

      expect(result.titleGeneration).toEqual({ endpoint: globalEndpoint, modelId: 'global-chat-model' });
      expect(result.titleModelId).toBe('global-chat-model');
      expect(result.sources.titleGeneration).toBe('chat_group');
    });

    it('resolves explicit title endpoint and model independently from normal generation', () => {
      const normalEndpoint = { type: 'openai' as const, url: 'https://normal.example/v1' };
      const titleEndpoint = { type: 'ollama' as const, url: 'https://title.example' };
      const result = resolveChatSettings({
        chat: baseChat,
        groups: [],
        globalSettings: {
          endpoint: normalEndpoint,
          defaultModelId: 'normal-model',
          titleGeneration: { endpoint: titleEndpoint, model: { id: 'title-only-model' } },
        },
      });

      expect(result.endpoint).toEqual(normalEndpoint);
      expect(result.modelId).toBe('normal-model');
      expect(result.titleGeneration).toEqual({ endpoint: titleEndpoint, modelId: 'title-only-model' });
      expect(result.titleModelId).toBe('title-only-model');
    });

  });

  describe('Override Detection Helpers', () => {
    it('hasChatOverrides should detect various overrides', () => {
      expect(hasChatOverrides({ chat: baseChat })).toBe(false);
      expect(hasChatOverrides({ chat: { ...baseChat, modelId: 'm1' } })).toBe(true);
      expect(hasChatOverrides({ chat: { ...baseChat, autoTitleEnabled: false } })).toBe(true);
      expect(hasChatOverrides({ chat: { ...baseChat, titleModelId: 'tm1' } })).toBe(true);
      expect(hasChatOverrides({ chat: { ...baseChat, endpoint: { type: 'ollama', url: '' } } })).toBe(true);
    });

    it('hasGroupOverrides should detect various overrides', () => {
      const group: ChatGroup = { id: toChatGroupId({ raw: 'g1' }), name: 'G', isCollapsed: false, updatedAt: 0, items: [] };
      expect(hasGroupOverrides({ group })).toBe(false);
      expect(hasGroupOverrides({ group: { ...group, modelId: 'm1' } })).toBe(true);
      expect(hasGroupOverrides({ group: { ...group, autoTitleEnabled: true } })).toBe(true);
      expect(hasGroupOverrides({ group: { ...group, titleModelId: 'tm1' } })).toBe(true);
    });
  });

  describe('LM Parameters Resolution & Reasoning Effort Inheritance', () => {
    const globalSettings: ResolvableSettings = {
      endpoint: { type: 'openai', url: '' },
      lmParameters: {
        ...EMPTY_LM_PARAMETERS,
        temperature: 0.7,
        reasoning: { effort: undefined },
      },
    };

    const group: ChatGroup = {
      id: toChatGroupId({ raw: 'group-1' }),
      name: 'Group',
      isCollapsed: false,
      updatedAt: Date.now(),
      items: [],
      lmParameters: {
        ...EMPTY_LM_PARAMETERS,
        reasoning: { effort: 'high' },
      },
    };

    it('should inherit reasoning effort from group when not specified in chat', () => {
      const chat: Chat = { ...baseChat, groupId: toChatGroupId({ raw: 'group-1' }) };
      const result = resolveChatSettings({ chat, groups: [group], globalSettings });
      expect(result.lmParameters.reasoning.effort).toBe('high');
    });

    it('should inherit reasoning effort from group even if other lmParameters are set in chat', () => {
      const chat: Chat = {
        ...baseChat,
        groupId: toChatGroupId({ raw: 'group-1' }),
        lmParameters: {
          ...EMPTY_LM_PARAMETERS,
          temperature: 0.5,
          reasoning: { effort: undefined }, // Inherit from parent
        },
      };
      const result = resolveChatSettings({ chat, groups: [group], globalSettings });
      // BUG: Currently this fails because reasoning object in chat overwrites group's reasoning
      expect(result.lmParameters.reasoning.effort).toBe('high');
      expect(result.lmParameters.temperature).toBe(0.5);
    });

    it('should override group reasoning effort when explicitly set in chat', () => {
      const chat: Chat = {
        ...baseChat,
        groupId: toChatGroupId({ raw: 'group-1' }),
        lmParameters: {
          ...EMPTY_LM_PARAMETERS,
          reasoning: { effort: 'low' },
        },
      };
      const result = resolveChatSettings({ chat, groups: [group], globalSettings });
      expect(result.lmParameters.reasoning.effort).toBe('low');
    });
  });
});
