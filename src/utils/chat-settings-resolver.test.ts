import { describe, it, expect } from 'vitest';
import { resolveChatSettings, hasChatOverrides, hasGroupOverrides, type ResolvableSettings } from './chat-settings-resolver';
import type { Chat, ChatGroup } from '../models/types';

describe('resolveChatSettings - System Prompt Edge Cases', () => {
  const globalSettings: ResolvableSettings = {
    endpointType: 'openai',
    systemPrompt: 'Global Prompt',
  };

  const baseChat: Chat = {
    id: 'chat-1',
    title: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    debugEnabled: false,
    root: { items: [] },
  };

  describe('Override Behavior', () => {
    it('should clear global prompt when override content is null (Explicit Clear)', () => {
      const chat: Chat = {
        ...baseChat,
        systemPrompt: { behavior: 'override', content: null }
      };
      const result = resolveChatSettings(chat, [], globalSettings);
      expect(result.systemPromptMessages).toEqual([]);
    });

    it('should clear global prompt when override content is empty string ("")', () => {
      const chat: Chat = {
        ...baseChat,
        systemPrompt: { behavior: 'override', content: '' }
      };
      const result = resolveChatSettings(chat, [], globalSettings);
      expect(result.systemPromptMessages).toEqual([]);
    });

    it('should replace global prompt when override content is non-empty', () => {
      const chat: Chat = {
        ...baseChat,
        systemPrompt: { behavior: 'override', content: 'Chat Prompt' }
      };
      const result = resolveChatSettings(chat, [], globalSettings);
      expect(result.systemPromptMessages).toEqual(['Chat Prompt']);
    });
  });

  describe('Append Behavior', () => {
    it('should NOT add anything when append content is empty string ("")', () => {
      const chat: Chat = {
        ...baseChat,
        systemPrompt: { behavior: 'append', content: '' }
      };
      const result = resolveChatSettings(chat, [], globalSettings);
      // Global remains, but nothing added
      expect(result.systemPromptMessages).toEqual(['Global Prompt']);
    });

    it('should append to global prompt when append content is non-empty', () => {
      const chat: Chat = {
        ...baseChat,
        systemPrompt: { behavior: 'append', content: 'Extra' }
      };
      const result = resolveChatSettings(chat, [], globalSettings);
      expect(result.systemPromptMessages).toEqual(['Global Prompt', 'Extra']);
    });
  });

  describe('Hierarchical Resolution (Global -> Group -> Chat)', () => {
    const group: ChatGroup = {
      id: 'group-1',
      name: 'Group',
      isCollapsed: false,
      updatedAt: Date.now(),
      items: [],
      systemPrompt: { behavior: 'override', content: 'Group Prompt' }
    };

    it('Chat override:null should clear both Group and Global prompts', () => {
      const chat: Chat = {
        ...baseChat,
        groupId: 'group-1',
        systemPrompt: { behavior: 'override', content: null }
      };
      const result = resolveChatSettings(chat, [group], globalSettings);
      expect(result.systemPromptMessages).toEqual([]);
    });

    it('Chat append should build upon Group override', () => {
      const chat: Chat = {
        ...baseChat,
        groupId: 'group-1',
        systemPrompt: { behavior: 'append', content: 'Chat Append' }
      };
      const result = resolveChatSettings(chat, [group], globalSettings);
      // Group overrides Global, then Chat appends to Group
      expect(result.systemPromptMessages).toEqual(['Group Prompt', 'Chat Append']);
    });

    it('Group override:null should clear Global, allowing Chat append to start from empty', () => {
      const clearGroup: ChatGroup = {
        ...group,
        systemPrompt: { behavior: 'override', content: null }
      };
      const chat: Chat = {
        ...baseChat,
        groupId: 'group-1',
        systemPrompt: { behavior: 'append', content: 'Chat Append' }
      };
      const result = resolveChatSettings(chat, [clearGroup], globalSettings);
      // Global is cleared by Group, result contains only Chat's contribution
      expect(result.systemPromptMessages).toEqual(['Chat Append']);
    });

    it('Group override:"" should also clear Global', () => {
      const emptyGroup: ChatGroup = {
        ...group,
        systemPrompt: { behavior: 'override', content: '' }
      };
      const chat: Chat = {
        ...baseChat,
        groupId: 'group-1',
        systemPrompt: { behavior: 'append', content: 'Chat Append' }
      };
      const result = resolveChatSettings(chat, [emptyGroup], globalSettings);
      expect(result.systemPromptMessages).toEqual(['Chat Append']);
    });
  });

  describe('Automatic Title Settings Resolution', () => {
    const globalSettings: ResolvableSettings = {
      endpointType: 'openai',
      autoTitleEnabled: true,
      titleModelId: 'global-title-model',
    };

    it('should resolve global title settings when not overridden', () => {
      const result = resolveChatSettings(baseChat, [], globalSettings);
      expect(result.autoTitleEnabled).toBe(true);
      expect(result.titleModelId).toBe('global-title-model');
      expect(result.sources.autoTitleEnabled).toBe('global');
      expect(result.sources.titleModelId).toBe('global');
    });

    it('should allow group to override title settings', () => {
      const group: ChatGroup = {
        id: 'group-1',
        name: 'Group',
        isCollapsed: false,
        updatedAt: Date.now(),
        items: [],
        autoTitleEnabled: false,
        titleModelId: 'group-title-model',
      };
      const chat: Chat = { ...baseChat, groupId: 'group-1' };
      const result = resolveChatSettings(chat, [group], globalSettings);
      expect(result.autoTitleEnabled).toBe(false);
      expect(result.titleModelId).toBe('group-title-model');
      expect(result.sources.autoTitleEnabled).toBe('chat_group');
      expect(result.sources.titleModelId).toBe('chat_group');
    });

    it('should allow chat to override title settings', () => {
      const chat: Chat = {
        ...baseChat,
        autoTitleEnabled: false,
        titleModelId: 'chat-title-model',
      };
      const result = resolveChatSettings(chat, [], globalSettings);
      expect(result.autoTitleEnabled).toBe(false);
      expect(result.titleModelId).toBe('chat-title-model');
      expect(result.sources.autoTitleEnabled).toBe('chat');
      expect(result.sources.titleModelId).toBe('chat');
    });
  });

  describe('Override Detection Helpers', () => {
    it('hasChatOverrides should detect various overrides', () => {
      expect(hasChatOverrides({ chat: baseChat })).toBe(false);
      expect(hasChatOverrides({ chat: { ...baseChat, modelId: 'm1' } })).toBe(true);
      expect(hasChatOverrides({ chat: { ...baseChat, autoTitleEnabled: false } })).toBe(true);
      expect(hasChatOverrides({ chat: { ...baseChat, titleModelId: 'tm1' } })).toBe(true);
      expect(hasChatOverrides({ chat: { ...baseChat, endpointType: 'ollama' } })).toBe(true);
    });

    it('hasGroupOverrides should detect various overrides', () => {
      const group: ChatGroup = { id: 'g1', name: 'G', isCollapsed: false, updatedAt: 0, items: [] };
      expect(hasGroupOverrides({ group })).toBe(false);
      expect(hasGroupOverrides({ group: { ...group, modelId: 'm1' } })).toBe(true);
      expect(hasGroupOverrides({ group: { ...group, autoTitleEnabled: true } })).toBe(true);
      expect(hasGroupOverrides({ group: { ...group, titleModelId: 'tm1' } })).toBe(true);
    });
  });
});
