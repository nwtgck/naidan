import { describe, expect, it } from 'vitest';
import { renderMessageMarkdown } from './message-markdown';
import type { ToolMessageNode, UserMessageNode } from '@/01-models/types';
import { toAttachmentId, toBinaryObjectId, toMessageId, toToolCallId } from '@/01-models/ids';

describe('renderMessageMarkdown', () => {
  it('renders attachments as hidden binary placeholders with exact output', () => {
    const node: UserMessageNode = {
      id: toMessageId({ raw: 'user-1' }),
      role: 'user',
      createdAt: 1,
      modelId: undefined,
      lmParameters: undefined,
      parts: [
        {
          type: 'text',
          text: 'hello',
          completeness: 'complete'
        },
        {
          type: 'attachment',
          attachment: {
            id: toAttachmentId({ raw: 'attachment-1' }),
            binaryObjectId: toBinaryObjectId({ raw: 'binary-1' }),
            originalName: 'note.pdf',
            mimeType: 'application/pdf',
            size: 1234,
            uploadedAt: 99,
            status: 'persisted',
          }
        }
      ],
      replies: { items: [] }
    };

    expect(renderMessageMarkdown({ node })).toBe(`\
# Message user-1

role: user
createdAt: 1
modelId: undefined
lmParameters: undefined

## Part 1 (text)
completeness: complete

hello

## Part 2 (attachment)
note.pdf (application/pdf, 1234 bytes, binary hidden)

`);
  });

  it('truncates long text tool results with an exact marker', () => {
    const longText = 'x'.repeat(4001);
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

    expect(renderMessageMarkdown({ node })).toBe(`\
# Message tool-1

role: tool
createdAt: 2
modelId: undefined
lmParameters: undefined

## Part 1 (tool_result)
call-1: success ${'x'.repeat(4000)} [truncated]

`);
  });
});
