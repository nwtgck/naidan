import { describe, expect, it } from 'vitest'
import { renderMessageJson } from './message-json'
import type { ToolMessageNode } from '@/models/types'
import { toMessageId, toToolCallId } from '@/models/ids';

describe('renderMessageJson', () => {
  it('truncates long text tool results with an exact marker', () => {
    const longText = 'y'.repeat(4001)
    const node: ToolMessageNode = {
      id: toMessageId({ raw: 'tool-1' }),
      role: 'tool',
      content: undefined,
      timestamp: 2,
      replies: { items: [] },
      attachments: undefined,
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: [{
        toolCallId: toToolCallId({ raw: 'call-1' }),
        status: 'success',
        content: {
          type: 'text',
          text: longText,
        },
      }],
    }

    expect(renderMessageJson({ node })).toBe(`\
{
  "id": "tool-1",
  "role": "tool",
  "timestamp": 2,
  "results": [
    {
      "toolCallId": "call-1",
      "status": "success",
      "content": {
        "type": "text",
        "text": "${'y'.repeat(4000)}\\n[truncated]"
      }
    }
  ]
}`)
  })
})
