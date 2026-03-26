import { describe, it, expect, beforeEach } from 'vitest';
import { useChatTools } from './useChatTools';

describe('useChatTools', () => {
  beforeEach(() => {
    const { setCurrentChatId, __testOnly } = useChatTools();
    setCurrentChatId({ chatId: null });
    __testOnly._toolEnabledByChat.value = new Map();
  });

  describe('isToolEnabled', () => {
    it('returns false when no current chat is set', () => {
      const { isToolEnabled } = useChatTools();
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
      expect(isToolEnabled({ name: 'shell_execute' })).toBe(false);
    });

    it('returns false for a tool that has not been enabled in the current chat', () => {
      const { setCurrentChatId, isToolEnabled } = useChatTools();
      setCurrentChatId({ chatId: 'chat-1' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
    });

    it('returns true after enabling a tool in the current chat', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();
      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });
      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
    });
  });

  describe('per-chat isolation', () => {
    it('enabling a tool in one chat does not affect another chat', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();

      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });
      setToolEnabled({ name: 'shell_execute', enabled: true });

      setCurrentChatId({ chatId: 'chat-2' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
      expect(isToolEnabled({ name: 'shell_execute' })).toBe(false);
    });

    it('each chat independently retains its own tool state', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();

      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });

      setCurrentChatId({ chatId: 'chat-2' });
      setToolEnabled({ name: 'shell_execute', enabled: true });

      setCurrentChatId({ chatId: 'chat-1' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(true);
      expect(isToolEnabled({ name: 'shell_execute' })).toBe(false);

      setCurrentChatId({ chatId: 'chat-2' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
      expect(isToolEnabled({ name: 'shell_execute' })).toBe(true);
    });
  });

  describe('setToolEnabled', () => {
    it('does nothing when no current chat is set', () => {
      const { setToolEnabled, isToolEnabled } = useChatTools();
      setToolEnabled({ name: 'calculator', enabled: true });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
    });

    it('can disable a previously enabled tool', () => {
      const { setCurrentChatId, setToolEnabled, isToolEnabled } = useChatTools();
      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });
      setToolEnabled({ name: 'calculator', enabled: false });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
    });
  });

  describe('toggleTool', () => {
    it('toggles a tool on and off within the current chat', () => {
      const { setCurrentChatId, toggleTool, isToolEnabled } = useChatTools();
      setCurrentChatId({ chatId: 'chat-1' });

      toggleTool({ name: 'calculator' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(true);

      toggleTool({ name: 'calculator' });
      expect(isToolEnabled({ name: 'calculator' })).toBe(false);
    });
  });

  describe('enabledToolNames', () => {
    it('returns empty array when no current chat is set', () => {
      const { enabledToolNames } = useChatTools();
      expect(enabledToolNames.value).toEqual([]);
    });

    it('returns enabled tool names for the current chat', () => {
      const { setCurrentChatId, setToolEnabled, enabledToolNames } = useChatTools();
      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });
      setToolEnabled({ name: 'shell_execute', enabled: true });
      expect(enabledToolNames.value).toContain('calculator');
      expect(enabledToolNames.value).toContain('shell_execute');
    });

    it('reflects only the current chat tools after switching', () => {
      const { setCurrentChatId, setToolEnabled, enabledToolNames } = useChatTools();

      setCurrentChatId({ chatId: 'chat-1' });
      setToolEnabled({ name: 'calculator', enabled: true });

      setCurrentChatId({ chatId: 'chat-2' });
      expect(enabledToolNames.value).toEqual([]);
    });
  });
});
