import { expect } from 'vitest';
import type { LmProvider } from '@/01-models/lm';
import type { AssistantMessageNode, Attachment, ToolMessageNode } from '@/01-models/types';
import type { Tool, ToolExecutionEvent } from '@/01-models/tool';
import { toAttachmentId, toBinaryObjectId, toMessageId, type ToolCallId } from '@/01-models/ids';
import { createChatMessageSnapshot } from '@/01-models/chat-message';
import { generateChatTurn } from '@/logic/generate-chat-turn';
import type { CapturedChatRequest, ProviderChatCapture } from './capture-provider-chat';

/** Caller-owned history and tools around the ordinary production turn runner. */
export async function runProviderReplayTurn({ provider, request, tools, abortController }: {
  provider: LmProvider;
  request: Omit<CapturedChatRequest, 'tools' | 'signal'>;
  tools: readonly Tool[];
  abortController: AbortController;
}) {
  const generated: (AssistantMessageNode | ToolMessageNode)[] = [];
  const toolEvents: { toolCallId: ToolCallId; event: ToolExecutionEvent }[] = [];
  const { model, parameters, messages, readBinaryObject, debug, ...unhandled } = request;
  unhandled satisfies Record<PropertyKey, never>;
  const result = await generateChatTurn({
    provider, model, parameters, tools, readBinaryObject, debug, abortController, approvalContext: undefined,
    createAssistantMessage: () => {
      const node: AssistantMessageNode = {
        id: toMessageId({ raw: `generated_${generated.length}` }), role: 'assistant', createdAt: 0,
        parts: [], interruption: undefined, modelId: undefined, lmParameters: undefined, replies: { items: [] },
      };
      generated.push(node);
      return node;
    },
    createToolMessage: () => {
      const node: ToolMessageNode = {
        id: toMessageId({ raw: `generated_${generated.length}` }), role: 'tool', createdAt: 0,
        parts: [], modelId: undefined, lmParameters: undefined, replies: { items: [] },
      };
      generated.push(node);
      return node;
    },
    buildMessages: ({ excludedMessageId }) => [
      ...messages,
      ...generated.filter(node => node.id !== excludedMessageId).map(node => createChatMessageSnapshot({ node })),
    ],
    onChange: () => {},
    onToolEvent: ({ toolCallId, event }) => {
      toolEvents.push({ toolCallId, event: structuredClone(event) });
    },
    persistToolContent: async ({ text }) => ({ type: 'text', text }),
    describeError: ({ error }) => error.message,
  });
  return { result, generated, toolEvents };
}

/** Preserve the exact locally embedded image bytes, without fetching or model logic. */
export function createReplayImageAttachment({ dataUrl }: { dataUrl: string }): Attachment {
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error('Expected an embedded PNG fixture');
  const bytes = Uint8Array.from(atob(dataUrl.slice(prefix.length)), character => character.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'image/png' });
  return { id: toAttachmentId({ raw: 'image' }), binaryObjectId: toBinaryObjectId({ raw: 'image' }),
    originalName: 'image.png', mimeType: 'image/png', size: bytes.byteLength, uploadedAt: 0, status: 'memory', blob };
}

/** Check actual observations before and after awaited Worker disposal. */
export async function closeProviderReplayCaptures({ captures, close }: {
  captures: readonly (ProviderChatCapture | undefined)[]; close: () => Promise<void>;
}): Promise<void> {
  const snapshots = captures.map(capture => capture?.snapshot());
  await close();
  expect(captures.map(capture => capture?.snapshot()), 'through awaited Worker disposal').toEqual(snapshots);
}

export const TEST_ONLY = {
};
