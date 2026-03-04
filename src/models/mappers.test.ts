import { generateId } from '../utils/id';
import { describe, it, expect } from 'vitest';
import { chatToDomain, buildSidebarItemsFromHierarchy, messageNodeToDomain, messageNodeToDto, lmParametersToDomain, lmParametersToDto } from './mappers';
import type { ChatMeta, ChatGroup, Hierarchy, UserMessageNode, AssistantMessageNode, SystemMessageNode } from './types';
import type { MessageNodeDto } from './dto';

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
        reasoning: { effort: 'low' }
      },
      replies: { items: [] }
    };

    const domain = messageNodeToDomain(dto) as UserMessageNode;
    expect(domain.role).toBe('user');
    expect(domain.thinking).toBeUndefined();
    expect(domain.modelId).toBeUndefined();
    expect(domain.lmParameters?.reasoning.effort).toBe('low');

    const backToDto = messageNodeToDto(domain) as Extract<MessageNodeDto, { role: 'user' }>;
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
        reasoning: { effort: 'high' }
      },
      replies: { items: [] }
    };

    const domain = messageNodeToDomain(dto) as AssistantMessageNode;
    expect(domain.role).toBe('assistant');
    expect(domain.thinking).toBe('Thinking...');
    expect(domain.modelId).toBe('gpt-4');
    expect(domain.lmParameters?.reasoning.effort).toBe('high');

    const backToDto = messageNodeToDto(domain) as Extract<MessageNodeDto, { role: 'assistant' }>;
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
      replies: { items: [] }
    };

    const domain = messageNodeToDomain(dto) as SystemMessageNode;
    expect(domain.role).toBe('system');
    expect(domain.attachments).toBeUndefined();
    expect(domain.thinking).toBeUndefined();
    expect(domain.modelId).toBeUndefined();
    expect(domain.lmParameters).toBeUndefined();

    const backToDto = messageNodeToDto(domain);
    expect(backToDto.role).toBe('system');
    expect(backToDto.thinking).toBeUndefined();
  });
});

describe('LmParameters Mapping', () => {
  it('should handle undefined reasoning in DTO by providing default reasoning object in domain', () => {
    const domain = lmParametersToDomain({
      temperature: 0.5,
      topP: undefined,
      maxCompletionTokens: undefined,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      stop: undefined,
      reasoning: undefined
    });
    expect(domain.temperature).toBe(0.5);
    expect(domain.reasoning).toBeDefined();
    expect(domain.reasoning.effort).toBeUndefined();
  });

  it('should preserve reasoning effort through bidirectional mapping', () => {
    const original = { effort: 'medium' as const };
    const dto = lmParametersToDto({
      temperature: 1.0,
      topP: undefined,
      maxCompletionTokens: undefined,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      stop: undefined,
      reasoning: original
    });
    expect(dto?.reasoning?.effort).toBe('medium');

    const backToDomain = lmParametersToDomain(dto);
    expect(backToDomain.reasoning.effort).toBe('medium');
  });
});

describe('Sidebar assembly', () => {
  it('should filter out orphan chat entries from hierarchy', () => {
    const hierarchy: Hierarchy = {
      items: [
        { type: 'chat', id: 'exists' },
        { type: 'chat', id: 'orphan' }
      ]
    };
    const metas: ChatMeta[] = [
      { id: 'exists', title: 'Exists', updatedAt: 100, createdAt: 100, debugEnabled: false }
    ];
    const groups: ChatGroup[] = [];

    const items = buildSidebarItemsFromHierarchy(hierarchy, metas, groups);
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe('chat:exists');
  });

  it('should filter out orphan groups from hierarchy', () => {
    const hierarchy: Hierarchy = {
      items: [
        { type: 'chat_group', id: 'orphan-group', chat_ids: [] }
      ]
    };
    const items = buildSidebarItemsFromHierarchy(hierarchy, [], []);
    expect(items).toHaveLength(0);
  });
});

describe('Legacy Migration (Flat to Tree)', () => {
  it('should migrate linear messages to a recursive tree structure', () => {
    const legacyId1 = generateId();
    const legacyId2 = generateId();
    const legacyChat: any = {
      id: generateId(),
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
