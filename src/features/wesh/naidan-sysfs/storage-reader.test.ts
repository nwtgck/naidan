import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageService } from '@/00-storage/service';
import { STORAGE_KEY_PREFIX } from '@/constants';
import { toChatGroupId, toChatId } from '@/01-models/ids';
import {
  naidanSysfsRemoteChatContentPayloadSchema,
  naidanSysfsRemoteChatGroupPayloadSchema,
  naidanSysfsRemoteChatMetaPayloadSchema,
} from './remote-reader-schema';
import { NaidanSysfsProvider } from './provider';
import { createNaidanSysfsRemoteReader, createRemoteNaidanSysfsStorageReader } from './storage-reader';

const legacyMetadata = {
  id: 'chat-legacy', title: 'Legacy chat', createdAt: 1, updatedAt: 3,
  currentLeafId: 'tool', autoTitleEnabled: true, titleModelId: 'title-model',
};
const legacyGroup = {
  id: 'group-legacy', name: 'Legacy group', updatedAt: 3,
  isCollapsed: false, autoTitleEnabled: true, titleModelId: 'title-model',
};
const legacyTool = {
  id: 'tool', role: 'tool', timestamp: 3,
  results: [{ toolCallId: 'call', status: 'success', content: { type: 'text', text: '\uFEFFresult' } }],
  replies: { items: [] },
};
const legacyContent = {
  currentLeafId: 'tool',
  root: { items: [{
    id: 'user', role: 'user', timestamp: 1, content: '  question  ',
    replies: { items: [{
      id: 'assistant', role: 'assistant', timestamp: 2,
      thinking: '  reasoning  ', content: 'answer [Aborted]',
      toolCalls: [{ id: 'call', type: 'function', function: { name: 'weather', arguments: '{ "city": "Tokyo" }' } }],
      replies: { items: [legacyTool] },
    }] },
  }] },
};

describe('Naidan sysfs current-format transfer boundary', () => {
  beforeEach(async () => {
    localStorage.clear();
    await storageService.init({ type: 'local' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('reads legacy storage through V2 remote payloads and sysfs without rewriting the source', async () => {
    const saved = new Map([
      [`${STORAGE_KEY_PREFIX}lsp:chat_meta:chat-legacy`, JSON.stringify(legacyMetadata)],
      [`${STORAGE_KEY_PREFIX}lsp:chat_group:group-legacy`, JSON.stringify(legacyGroup)],
      [`${STORAGE_KEY_PREFIX}lsp:chat_content:chat-legacy`, JSON.stringify(legacyContent)],
      [`${STORAGE_KEY_PREFIX}lsp:hierarchy`, JSON.stringify({ items: [{ type: 'chat_group', id: 'group-legacy', chat_ids: ['chat-legacy'] }] })],
    ]);
    for (const [key, text] of saved) localStorage.setItem(key, text);
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const remote = createNaidanSysfsRemoteReader({ storageType: 'local' });

    const payload = await remote.loadChat({ chatId: 'chat-legacy' });
    expect(payload).toBeDefined();
    if (payload === undefined) throw new Error('Expected the legacy chat to remain readable');
    const transferred = naidanSysfsRemoteChatContentPayloadSchema.parse(structuredClone(payload.content));
    const user = transferred.root.items[0];
    const assistant = user?.replies.items[0];
    const tool = assistant?.replies.items[0];
    expect(user).toMatchObject({ role: 'user', createdAt: 1, parts: [{ type: 'text', text: '  question  ' }] });
    expect(assistant).toMatchObject({
      role: 'assistant', createdAt: 2, interruption: undefined,
      parts: [
        { type: 'reasoning', text: '  reasoning  ', completeness: undefined },
        { type: 'text', text: 'answer [Aborted]', completeness: undefined },
        { type: 'tool_call', toolCall: legacyContent.root.items[0]?.replies.items[0]?.toolCalls[0] },
      ],
    });
    expect(tool).toMatchObject({ role: 'tool', createdAt: 3, parts: [{ type: 'tool_result', result: legacyTool.results[0] }] });
    for (const node of [user, assistant, tool]) {
      expect(node).not.toHaveProperty('timestamp');
      expect(node).not.toHaveProperty('content');
      for (const part of node?.parts ?? []) expect(part).not.toHaveProperty('id');
    }
    expect(await remote.loadChatContent({ chatId: 'chat-legacy' })).toEqual(payload.content);
    expect(await remote.loadChatMeta({ chatId: 'chat-legacy' })).toEqual(payload.metadata);
    expect(payload.metadata.dto).toHaveProperty('titleGeneration');
    expect(payload.metadata.dto).not.toHaveProperty('autoTitleEnabled');
    expect(payload.metadata.groupId).toBe('group-legacy');
    const group = await remote.loadChatGroup({ chatGroupId: 'group-legacy' });
    expect(group?.dto).toHaveProperty('titleGeneration');
    expect(group?.dto).not.toHaveProperty('titleModelId');
    expect(await remote.listChatGroups()).toEqual([group]);
    expect(await remote.getSidebarStructure()).toEqual([expect.objectContaining({ type: 'chat_group', chatGroup: group })]);

    const reader = createRemoteNaidanSysfsStorageReader({ remoteReader: remote });
    const restored = await reader.loadChat({ chatId: toChatId({ raw: 'chat-legacy' }) });
    expect(restored?.root.items[0]?.replies.items[0]?.parts).toEqual([
      expect.objectContaining({ type: 'reasoning', text: '  reasoning  ', completeness: 'complete' }),
      expect.objectContaining({ type: 'text', text: 'answer [Aborted]', completeness: 'complete' }),
      expect.objectContaining({ type: 'tool_call' }),
    ]);
    expect((await reader.loadChatGroup({ chatGroupId: toChatGroupId({ raw: 'group-legacy' }) }))?.titleGeneration).toEqual(restored?.titleGeneration);

    const provider = new NaidanSysfsProvider({
      reader, visibility: 'current_chat_only', binaryObjectAccess: 'data',
      currentChatId: 'chat-legacy', currentChatGroupId: 'group-legacy',
    });
    const handle = await provider.open({
      path: '/sys/fs/naidan/chats/chat-legacy/content-json/2-assistant-assistant.json',
      flags: { access: 'read', creation: 'never', truncate: 'preserve', append: 'preserve' },
      mode: undefined,
    });
    const buffer = new Uint8Array(4096);
    const { bytesRead } = await handle.read({ buffer });
    await handle.close();
    const rendered: unknown = JSON.parse(new TextDecoder().decode(buffer.subarray(0, bytesRead)));
    expect(rendered).toMatchObject({
      role: 'assistant', createdAt: 2,
      parts: [
        { type: 'reasoning', text: '  reasoning  ' },
        { type: 'text', text: 'answer [Aborted]' },
        { type: 'tool_call' },
      ],
    });
    expect(rendered).not.toHaveProperty('content');
    expect(rendered).not.toHaveProperty('interruption');
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    for (const [key, text] of saved) expect(localStorage.getItem(key)).toBe(text);
  });

  it('rejects legacy wire payloads even though the persistence reader accepts them', () => {
    expect(naidanSysfsRemoteChatMetaPayloadSchema.safeParse({ dto: legacyMetadata, groupId: 'group-legacy' }).success).toBe(false);
    expect(naidanSysfsRemoteChatGroupPayloadSchema.safeParse({ dto: legacyGroup, items: [] }).success).toBe(false);
    expect(naidanSysfsRemoteChatContentPayloadSchema.safeParse(legacyContent).success).toBe(false);
  });

  it('requires V2 in nested replies as well as the root message', () => {
    const content = {
      root: { items: [{
        id: 'parent', role: 'user', createdAt: 1,
        parts: [{ type: 'text', text: 'question' }],
        replies: { items: [legacyTool] },
      }] },
    };
    expect(naidanSysfsRemoteChatContentPayloadSchema.safeParse(content).success).toBe(false);
  });
});
