import { describe, it, expect } from 'vitest';
import { resolveChatSettings, type ResolvableSettings } from './chat-settings-resolver';
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
});
