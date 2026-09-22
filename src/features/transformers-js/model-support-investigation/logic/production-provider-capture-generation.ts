import type { ChatGenerationResult, LmProvider } from '@/01-models/lm';
import type { AssistantMessageNode, ToolMessageNode } from '@/01-models/types';
import { toMessageId } from '@/01-models/ids';
import { createChatMessageSnapshot } from '@/01-models/chat-message';
import { generateChatTurn } from '@/logic/generate-chat-turn';
import { createModelSupportWeatherTool } from './tool-protocol-fixture';
import { captureProviderMessages, type CaptureRequestInput } from './production-provider-capture-plan';
import type { createProductionProviderPartsTrace } from './production-provider-trace';

/** Runs the same parts consumer and owned tool operation as ordinary chat.
 * Only the fixed synthetic input/tool is materialized. There is no storage,
 * raw native-token repair, model downloading, or capture-dependent production behavior. */
export async function generateProductionProviderCapture({ provider, modelId, input, abortController, trace }: {
  provider: LmProvider;
  modelId: string;
  input: CaptureRequestInput;
  abortController: AbortController;
  trace: ReturnType<typeof createProductionProviderPartsTrace>;
}): Promise<ChatGenerationResult> {
  const history = captureProviderMessages({ input });
  const generated: (AssistantMessageNode | ToolMessageNode)[] = [];
  const settledTools = new Set<ToolMessageNode['parts'][number]>();
  let assistant: AssistantMessageNode | undefined;
  let tool: ToolMessageNode | undefined;
  function recordAppliedContent(): void {
    if (assistant !== undefined) trace.observeAssistant({ message: assistant });
    for (const part of tool?.parts ?? []) {
      if (part.result.status === 'executing' || settledTools.has(part)) continue;
      const result = part.result;
      switch (result.status) {
      case 'success':
        switch (result.content.type) {
        case 'text': trace.callbacks.onToolResult({ id: result.toolCallId, result: { status: 'success', content: result.content.text } }); break;
        case 'binary_object': throw new Error('Capture tool content must be inline');
        default: { const exhaustive: never = result.content; throw new Error('Unhandled tool content: ' + exhaustive); }
        }
        break;
      case 'error':
        // The ordinary history keeps the real result. The observation deliberately
        // omits error messages; it must not make those strings replay authority.
        trace.callbacks.onToolResult({ id: result.toolCallId, result: { status: 'error', code: result.error.code, message: '' } });
        break;
      default: { const exhaustive: never = result; throw new Error('Unhandled captured tool result: ' + exhaustive); }
      }
      settledTools.add(part);
    }
  }
  try {
    const result = await generateChatTurn({
      provider, model: modelId, debug: undefined, parameters: input.parameters,
      tools: input.tools.length === 0 ? [] : [createModelSupportWeatherTool()],
      readBinaryObject: undefined, abortController, approvalContext: undefined,
      createAssistantMessage: () => {
        assistant = { id: toMessageId({ raw: `capture_assistant_${generated.length}` }), role: 'assistant', createdAt: 0,
          parts: [], replies: { items: [] }, modelId, lmParameters: undefined, interruption: undefined };
        generated.push(assistant);
        trace.observeAssistant({ message: assistant });
        return assistant;
      },
      createToolMessage: () => {
        tool = { id: toMessageId({ raw: `capture_tool_${generated.length}` }), role: 'tool', createdAt: 0,
          parts: [], replies: { items: [] }, modelId: undefined, lmParameters: undefined };
        generated.push(tool); settledTools.clear();
        return tool;
      },
      buildMessages: ({ excludedMessageId }) => [
        ...history,
        ...generated.filter(message => message.id !== excludedMessageId).map(node => createChatMessageSnapshot({ node })),
      ],
      onChange: recordAppliedContent,
      onToolEvent: ({ toolCallId, event }) => trace.callbacks.onToolEvent({ id: toolCallId, event }),
      persistToolContent: async ({ text }) => ({ type: 'text', text }),
      // Synthetic capture diagnostics do not include arbitrary exception messages.
      describeError: () => 'Generation failed.',
    });
    trace.observeResult({ result });
    return result;
  } catch (error) {
    recordAppliedContent();
    trace.observeResult({ result: { type: 'error', error: error instanceof Error ? error : new Error('Generation failed.') } });
    throw error;
  }
}

export const TEST_ONLY = {
};
