import { describe, expect, it } from 'vitest';
import type { MessageNode } from '@/models/types';
import {
  buildCompactRequestMessages,
  createCompactBranchFromResponse,
  createCompactConversationMessageContent,
  createCompactInstruction,
  getHeaderCompactBoundary,
  splitCompactPath,
  toContextCompactDisplayProgress,
} from './context-compact';

function createMessage({
  id,
  role,
  content,
}: {
  id: string;
  role: MessageNode['role'];
  content: string | undefined;
}): MessageNode {
  switch (role) {
  case 'user':
    return {
      id,
      role,
      content: content ?? '',
      attachments: undefined,
      timestamp: 1,
      replies: { items: [] },
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: undefined,
    };
  case 'assistant':
    return {
      id,
      role,
      content: content ?? '',
      attachments: undefined,
      timestamp: 1,
      replies: { items: [] },
      thinking: undefined,
      error: undefined,
      modelId: 'model-1',
      lmParameters: undefined,
      toolCalls: undefined,
      results: undefined,
    };
  case 'system':
    return {
      id,
      role,
      content: content ?? '',
      attachments: undefined,
      timestamp: 1,
      replies: { items: [] },
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: undefined,
    };
  case 'tool':
    return {
      id,
      role,
      content: undefined,
      attachments: undefined,
      timestamp: 1,
      replies: { items: [] },
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: [],
    };
  default: {
    const _ex: never = role;
    throw new Error(`Unhandled message role: ${_ex}`);
  }
  }
}

describe('context-compact', () => {
  it('returns the header compact boundary before the preserved tail', () => {
    const path = Array.from({ length: 8 }, (_, index) =>
      createMessage({
        id: `msg-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message ${index + 1}`,
      }));

    expect(getHeaderCompactBoundary({ path, keepRecentMessages: 6 })).toBe('msg-2');
  });

  it('splits the path with the boundary included in the prefix', () => {
    const path = Array.from({ length: 5 }, (_, index) =>
      createMessage({
        id: `msg-${index + 1}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message ${index + 1}`,
      }));

    expect(splitCompactPath({ path, boundaryMessageId: 'msg-3' })).toEqual({
      prefix: path.slice(0, 3),
      suffix: path.slice(3),
      boundaryMessageId: 'msg-3',
    });
  });

  it('creates prefixed conversation content when message ids are enabled', () => {
    const node = createMessage({
      id: 'msg-4',
      role: 'assistant',
      content: 'Answer',
    });

    expect(createCompactConversationMessageContent({
      node,
      promptMode: 'with_message_ids',
    })).toBe(`messageId=msg-4\n\nAnswer`);
  });

  it('builds an English compact instruction and request messages', () => {
    const requestMessages = buildCompactRequestMessages({
      prefix: [
        { role: 'user', content: `\
messageId=msg-1

Question` },
      ],
      promptMode: 'with_message_ids',
      userLanguageHint: 'ja-JP',
    });

    expect(requestMessages).toEqual([
      { role: 'user', content: `\
messageId=msg-1

Question` },
      {
        role: 'user',
        content: createCompactInstruction({
          promptMode: 'with_message_ids',
          userLanguageHint: 'ja-JP',
        }),
      },
    ]);
  });

  it('creates a new compact branch with copied suffix ids', () => {
    const suffix = [
      createMessage({ id: 'msg-5', role: 'user', content: 'Follow-up' }),
      createMessage({ id: 'msg-6', role: 'assistant', content: 'Reply' }),
    ];
    const createdIds = ['msg-9', 'msg-10', 'msg-11'];

    const branch = createCompactBranchFromResponse({
      compactContent: '# Compact Context',
      suffix,
      compactModelId: 'model-1',
      createMessageId: () => createdIds.shift() ?? 'unexpected-id',
      now: () => 100,
    });

    expect(branch.compactNode.id).toBe('msg-9');
    expect(branch.compactNode.replies.items[0]?.id).toBe('msg-10');
    expect(branch.compactNode.replies.items[0]?.replies.items[0]?.id).toBe('msg-11');
    expect(branch.currentLeafId).toBe('msg-11');
  });

  it('keeps receiving progress below 100 before completion', () => {
    const display = toContextCompactDisplayProgress({
      progress: {
        phase: 'receiving_compact',
        compactedMessageCount: 4,
        suffixMessageCount: 6,
        outputChars: 100000,
        requestPreview: `\
[user]
Question`,
        outputPreview: '# Compact Context',
      },
      nowMs: Date.now(),
    });

    expect(display.percent).toBeLessThan(100);
    expect(display.isRunning).toBe(true);
  });
});
