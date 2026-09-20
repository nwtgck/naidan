import { z } from 'zod';
import { customAlphabet } from 'nanoid';
import type { LmProvider } from '@/01-models/lm';
import { idToRaw, toToolCallId } from '@/01-models/ids';
import { formatToolExecutionOutcomeForLm, type ToolExecutionOutcome } from '@/01-models/tool';
import { zodToJsonSchema } from '@/utils/lm-tools';
import { llamaCppBrowserService } from '@/features/llama-cpp-browser';
import { LlamaCppBrowserError, type GenerateInput } from './types';

// Short alphanumeric IDs also fit templates that enforce nine-character IDs.
const createCallId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 9);

export class LlamaCppBrowserProvider implements LmProvider {
  async listModels({ signal }: Parameters<LmProvider['listModels']>[0]): Promise<string[]> {
    return (await llamaCppBrowserService.listModels({ signal })).map(model => model.name);
  }
  async chat({ messages, model, onChunk, parameters, tools, toolApprovalContext, onToolCall, onToolEvent, onToolResult, onAssistantMessageStart, signal }: Parameters<LmProvider['chat']>[0]): Promise<void> {
    const callNames = new Map<string, string>();
    const usedIds = new Set<string>();
    const accepted: GenerateInput['messages'] = messages.map(message => {
      const { role, content: sourceContent, tool_calls, tool_call_id, ...unhandled } = message;
      unhandled satisfies Record<PropertyKey, never>;
      if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') throw new LlamaCppBrowserError({ code: 'unsupported-input' });
      const content = typeof sourceContent === 'string' ? sourceContent : sourceContent.map(part => {
        switch (part.type) {
        case 'text': return part.text;
        case 'image_url': throw new LlamaCppBrowserError({ code: 'unsupported-input' });
        default: { const exhaustive: never = part; throw new Error(String(exhaustive)); }
        }
      }).join('');
      const calls = tool_calls?.map(({ id, type, function: fn, ...rest }) => {
        rest satisfies Record<PropertyKey, never>;
        const raw = idToRaw({ id }); usedIds.add(raw); callNames.set(raw, fn.name);
        return { id: raw, type, function: { ...fn } };
      });
      const id = tool_call_id === undefined ? undefined : idToRaw({ id: tool_call_id });
      if (role === 'tool' && !id) throw new LlamaCppBrowserError({ code: 'unsupported-input' });
      return { role, content, ...(calls?.length ? { tool_calls: calls } : {}), ...(id ? { tool_call_id: id, name: callNames.get(id) } : {}) };
    });
    const definitions: GenerateInput['tools'] = tools?.map(tool => ({ type: 'function', function: {
      name: tool.name, description: tool.description,
      parameters: z.record(z.string(), z.json()).parse(zodToJsonSchema({ schema: tool.parametersSchema })),
    } }));
    const input = (): Omit<GenerateInput, 'options'> => ({ model, messages: accepted, tools: definitions,
      reasoningEffort: parameters?.reasoning.effort,
      temperature: parameters?.temperature ?? 0.7, topP: parameters?.topP ?? 0.95,
      maxTokens: parameters?.maxCompletionTokens ?? 1024, presencePenalty: parameters?.presencePenalty ?? 0,
      frequencyPenalty: parameters?.frequencyPenalty ?? 0, stop: parameters?.stop ? [...parameters.stop] : [] });
    if (signal?.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
    onAssistantMessageStart?.();
    await llamaCppBrowserService.generate({ input: input(), onChunk, signal,
      onResult: async ({ result, signal: turnSignal }) => {
        const checkCancelled = (): void => {
          if (turnSignal.aborted) throw new LlamaCppBrowserError({ code: 'aborted' });
        };
        checkCancelled();
        // A token limit may leave syntactically plausible but incomplete arguments.
        // Only a completed native turn is allowed to execute tools.
        if (result.finishReason !== 'stop' || !result.toolCalls.length) return undefined;
        const calls = result.toolCalls.map(call => {
          let id = call.id;
          if (!id || usedIds.has(id)) {
            do {
              id = createCallId();
            } while (usedIds.has(id));
          }
          usedIds.add(id); return { ...call, id };
        });
        accepted.push({ role: 'assistant', content: result.content, reasoning_content: result.reasoningContent, tool_calls: calls });
        for (const call of calls) {
          checkCancelled();
          const id = toToolCallId({ raw: call.id });
          onToolCall?.({ id, toolName: call.function.name, modelVisibleArguments: call.function.arguments });
          checkCancelled();
          const tool = tools?.find(tool => tool.name === call.function.name);
          let outcome: ToolExecutionOutcome;
          if (!tool) outcome = { status: 'error', code: 'other', message: `Tool "${call.function.name}" not found.` };
          else {
            try {
              let args: unknown;
              try {
                args = JSON.parse(call.function.arguments);
              } catch (error) {
                throw new ToolArgumentsError({ message: `Failed to parse tool arguments: ${error instanceof Error ? error.message : String(error)}` });
              }
              const validatedArgs = tool.parametersSchema.strict().parse(args);
              checkCancelled();
              let acceptingEvents = true;
              try {
                outcome = await tool.execute({ args: validatedArgs, signal: turnSignal, approvalContext: toolApprovalContext,
                  onEvent: async ({ event }) => {
                    if (!acceptingEvents || turnSignal.aborted) return;
                    onToolEvent?.({ id, event });
                  },
                });
              } finally {
                acceptingEvents = false;
              }
              checkCancelled();
            } catch (error) {
              checkCancelled();
              outcome = { status: 'error', code: error instanceof z.ZodError || error instanceof ToolArgumentsError ? 'invalid_arguments' : 'other',
                message: error instanceof Error ? error.message : String(error) };
            }
          }
          checkCancelled();
          onToolResult?.({ id, result: outcome });
          checkCancelled();
          accepted.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: formatToolExecutionOutcomeForLm({ outcome }) });
        }
        checkCancelled();
        onAssistantMessageStart?.();
        checkCancelled();
        return input();
      },
    });
  }
}
class ToolArgumentsError extends Error {
  constructor({ message }: { message: string }) {
    super(message);
  }
}
export const TEST_ONLY = {
};
