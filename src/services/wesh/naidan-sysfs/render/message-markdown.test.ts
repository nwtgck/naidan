import { describe, expect, it } from 'vitest'
import { renderMessageMarkdown } from './message-markdown'
import type { ToolMessageNode, UserMessageNode } from '@/models/types'

describe('renderMessageMarkdown', () => {
  it('renders attachments as hidden binary placeholders with exact output', () => {
    const node: UserMessageNode = {
      id: 'user-1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
      replies: { items: [] },
      attachments: [{
        id: 'attachment-1',
        binaryObjectId: 'binary-1',
        originalName: 'note.pdf',
        mimeType: 'application/pdf',
        size: 1234,
        uploadedAt: 99,
        status: 'persisted',
      }],
      thinking: undefined,
      error: undefined,
      modelId: undefined,
      lmParameters: undefined,
      toolCalls: undefined,
      results: undefined,
    }

    expect(renderMessageMarkdown({ node })).toBe(`\
# Message user-1

role: user
timestamp: 1
content: hello
thinking: undefined
error: undefined
modelId: undefined
lmParameters: undefined
attachments:
- note.pdf (application/pdf, 1234 bytes, binary hidden)
toolCalls: undefined
results: []

`)
  })

  it('truncates long text tool results with an exact marker', () => {
    const longText = 'x'.repeat(4001)
    const node: ToolMessageNode = {
      id: 'tool-1',
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
        toolCallId: 'call-1',
        status: 'success',
        content: {
          type: 'text',
          text: longText,
        },
      }],
    }

    expect(renderMessageMarkdown({ node })).toBe(`\
# Message tool-1

role: tool
timestamp: 2
content: undefined
thinking: undefined
error: undefined
modelId: undefined
lmParameters: undefined
attachments: []
toolCalls: undefined
results:
- call-1: success ${'x'.repeat(4000)} [truncated]

`)
  })
})
