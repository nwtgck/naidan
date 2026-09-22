import { z } from 'zod';
import type { LmProvider, ChatGenerationResult, ToolCallDraft } from '@/01-models/lm';
import type { AssistantMessageNode, ChatMessage, LmParameters, ToolMessageNode } from '@/01-models/types';
import type { Tool, ToolExecutionEvent, TextOrBinaryObject } from '@/01-models/tool';
import type { ToolApprovalContext } from '@/01-models/tool-approval';
import type { MessageId, ToolCallId } from '@/01-models/ids';
import { consumeChatGeneration } from './consume-chat-generation';
import { executeChatToolCalls } from './execute-chat-tool-calls';
import { zodToJsonSchema } from '@/utils/lm-tools';
import { cloneLmParameters } from '@/utils/lm-parameters';
import { copyChatMessage } from '@/01-models/chat-message';

/** Coordinates generation and tools against the caller's single owned history. */
export async function generateChatTurn({ provider, debug, model, parameters, tools, readBinaryObject, abortController, approvalContext, createAssistantMessage, createToolMessage, buildMessages, onChange, onToolEvent, onToolCallDraftsChange, persistToolContent, describeError }: {
  provider: LmProvider,
  debug: Parameters<LmProvider['chat']>[0]['debug'],
  model: string,
  parameters: LmParameters | undefined,
  tools: readonly Tool[],
  readBinaryObject: Parameters<LmProvider['chat']>[0]['readBinaryObject'],
  abortController: AbortController,
  approvalContext: ToolApprovalContext | undefined,
  createAssistantMessage: () => AssistantMessageNode | Promise<AssistantMessageNode>,
  createToolMessage: ({ assistant }: { assistant: AssistantMessageNode }) => ToolMessageNode | Promise<ToolMessageNode>,
  buildMessages: ({ excludedMessageId }: { excludedMessageId: MessageId }) => readonly ChatMessage[] | Promise<readonly ChatMessage[]>,
  onChange: () => void | Promise<void>,
  onToolCallDraftsChange: (({ messageId, drafts }: { messageId: MessageId, drafts: readonly ToolCallDraft[] }) => void) | undefined,
  onToolEvent: ({ toolCallId, event }: { toolCallId: ToolCallId, event: ToolExecutionEvent }) => void | Promise<void>,
  persistToolContent: ({ toolCallId, type, text }: { toolCallId: ToolCallId, type: 'result' | 'error', text: string }) => Promise<TextOrBinaryObject>,
  describeError: ({ error }: { error: Error }) => string,
}): Promise<ChatGenerationResult> {
  // Declaration values and execution references belong to this turn, including
  // time spent waiting for a stateful Provider's runtime lane.
  const acceptedParameters = cloneLmParameters({ lmParameters: parameters });
  const acceptedTools = tools.map(tool => ({ ...tool, execute: tool.execute.bind(tool) }));
  const definitions = acceptedTools.map(tool => ({
    name: tool.name, description: tool.description,
    parameters: z.record(z.string(), z.json()).parse(zodToJsonSchema({ schema: tool.parametersSchema })),
  }));
  if (abortController.signal.aborted) return { type: 'interrupted', reason: 'aborted' };
  const firstAssistant = await createAssistantMessage();
  const firstMessages = (await buildMessages({ excludedMessageId: firstAssistant.id })).map(message => copyChatMessage({ message }));

  async function generate({ chat, controller }: { chat: LmProvider['chat'], controller: AbortController }): Promise<ChatGenerationResult> {
    const signal = controller.signal;
    let assistant = firstAssistant;
    let messages = firstMessages;
    while (true) {
      if (signal.aborted) return { type: 'interrupted', reason: 'aborted' };
      const result = await consumeChatGeneration({
        node: assistant,
        items: chat({ messages, debug, model, parameters: acceptedParameters, tools: definitions.length ? definitions : undefined, readBinaryObject, signal }),
        abortController: controller, onChange,
        onToolCallDraftsChange: onToolCallDraftsChange === undefined ? undefined : ({ drafts }) => onToolCallDraftsChange({ messageId: assistant.id, drafts }),
      });
      switch (result.type) {
      case 'error':
        // This display text retains the language selected at recording time.
        assistant.interruption = { type: 'error', message: describeError({ error: result.error }) };
        await onChange();
        return result;
      case 'interrupted':
        if (result.reason === 'aborted' && abortController.signal.aborted) {
          assistant.interruption = { type: 'cancelled' };
          await onChange();
        }
        return result;
      case 'finished':
        switch (result.next) {
        case 'user': return result;
        case 'tool_results': break;
        default: { const _ex: never = result.next; throw new Error(`Unhandled generation step: ${_ex}`); }
        }
        break;
      default: { const _ex: never = result; throw new Error(`Unhandled generation result: ${_ex}`); }
      }
      // A stop after generation does not erase completed calls or execute them.
      if (signal.aborted) return { type: 'interrupted', reason: 'aborted' };
      const calls = assistant.parts.flatMap(part => {
        switch (part.type) {
        case 'tool_call': return [part.toolCall];
        case 'text':
        case 'reasoning': return [];
        default: { const _ex: never = part; throw new Error(`Unhandled assistant part: ${_ex}`); }
        }
      });
      const node = await createToolMessage({ assistant });
      await executeChatToolCalls({ calls, tools: acceptedTools, node, signal, approvalContext,
        onEvent: ({ toolCallId, event }) => {
          // A retired/canceled operation no longer publishes volatile output.
          // The observed execute() outcome is still recorded in its owned node.
          if (signal.aborted) return;
          return onToolEvent({ toolCallId, event });
        },
        onChange, persistContent: persistToolContent,
      });
      signal.throwIfAborted();
      assistant = await createAssistantMessage();
      messages = (await buildMessages({ excludedMessageId: assistant.id })).map(message => copyChatMessage({ message }));
    }
  }
  if (provider.runChatOperation === undefined) return generate({ chat: provider.chat.bind(provider), controller: abortController });

  let result: ChatGenerationResult | undefined;
  let entered = false;
  // The callback holds the runtime lane while the common layer owns tool waits
  // and persistence. No feature-specific tool loop or second history is needed.
  await provider.runChatOperation({ signal: abortController.signal, operation: async ({ chat, signal }) => {
    if (entered) throw new Error('A chat operation must be entered exactly once.');
    entered = true;
    const controller = new AbortController();
    const sources = [...new Set([signal, abortController.signal])];
    const removers = sources.map(source => {
      const abort = () => controller.abort(source.reason);
      source.addEventListener('abort', abort, { once: true });
      if (source.aborted) abort();
      return () => source.removeEventListener('abort', abort);
    });
    try {
      result = await generate({ chat, controller });
    } finally {
      for (const remove of removers) remove();
    }
  } });
  if (result === undefined) throw new Error('The Provider did not run the chat operation.');
  return result;
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
export const TEST_ONLY = {
};
