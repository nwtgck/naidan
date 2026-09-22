import { describe, expect, it } from 'vitest';
import { renderMessageJson } from './message-json';
import type { ToolMessageNode } from '@/01-models/types';
import { toMessageId, toToolCallId } from '@/01-models/ids';

describe('renderMessageJson', () => {
  it('truncates long text tool results with an exact marker', () => {
    const longText = 'y'.repeat(4001);
    const node: ToolMessageNode = {
      id: toMessageId({ raw: 'tool-1' }),
      role: 'tool',
      createdAt: 2,
      modelId: undefined,
      lmParameters: undefined,
      parts: [
        {
          type: 'tool_result',
          result: {
            toolCallId: toToolCallId({ raw: 'call-1' }),
            status: 'success',
            content: {
              type: 'text',
              text: longText,
            },
          }
        }
      ],
      replies: { items: [] }
    };

    expect(renderMessageJson({ node })).toBe(JSON.stringify({
      id: 'tool-1', role: 'tool', createdAt: 2,
      parts: [{ type: 'tool_result', result: {
        toolCallId: 'call-1', status: 'success', content: { type: 'text', text: `${'y'.repeat(4000)}\n[truncated]` },
      } }],
    }, null, 2));
  });
});
