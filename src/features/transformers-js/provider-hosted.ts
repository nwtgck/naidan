import { z } from 'zod';
import type { LmProvider } from '@/01-models/lm';
import type { ChatMessage, LmParameters, ToolCall } from '@/01-models/types';
import type { ToolCallId } from '@/01-models/ids';
import { transformersJsService } from './index';
import { formatToolExecutionOutcomeForLm, type Tool, type ToolExecutionOutcome } from '@/01-models/tool';
import type { ToolApprovalContext } from '@/features/tools/approval';
import type { WorkerToolDefinition, WorkerToolJsonObject } from './types';
import { zodToJsonSchema } from '@/utils/lm-tools';
import { cloneChatMessages, cloneLmParameters } from './inference-input-snapshot';

export type TransformersJsProviderService = Pick<typeof transformersJsService,
  'loadDownloadedModel' | 'generateText' | 'listCachedModels' | 'runInferenceOperation'> & {
    getState(): Pick<ReturnType<typeof transformersJsService.getState>, 'status' | 'activeModelId'>,
  };

class HostedTransformersJsProvider implements LmProvider {
  private readonly service: TransformersJsProviderService;

  constructor({ service }: { service: TransformersJsProviderService }) {
    this.service = service;
  }

  async chat({ messages, model, onChunk, parameters, tools, toolApprovalContext, onToolCall, onToolEvent, onToolResult, onAssistantMessageStart, signal }: {
    messages: ChatMessage[],
    model: string,
    onChunk: ({ chunk }: { chunk: string }) => void,
    parameters?: LmParameters,
    tools?: Tool[],
    toolApprovalContext?: ToolApprovalContext,
    onToolCall?: ({ id, toolName, modelVisibleArguments }: { id: ToolCallId, toolName: string, modelVisibleArguments: string }) => void,
    onToolEvent?: ({ id, event }: { id: ToolCallId, event: import('@/01-models/tool').ToolExecutionEvent }) => void,
    onToolResult?: ({ id, result }: {
      id: ToolCallId,
      result: ToolExecutionOutcome,
    }) => void,
    onAssistantMessageStart?: () => void,
    signal?: AbortSignal,
  }): Promise<void> {
    // Freeze the accepted model-visible input before it can wait in the lane.
    // Tool implementations and immutable schemas remain callable references;
    // declaration fields and the selected tool list belong to this request.
    const acceptedMessages = cloneChatMessages({ messages });
    const acceptedParameters = cloneLmParameters({ params: parameters });
    const acceptedTools = tools?.map(tool => ({ ...tool }));
    const workerTools: WorkerToolDefinition[] | undefined = acceptedTools && acceptedTools.length > 0
      ? acceptedTools.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: zodToJsonSchema({ schema: t.parametersSchema }) as WorkerToolJsonObject,
        },
      }))
      : undefined;
    return await this.service.runInferenceOperation({ signal, operation: async ({ scope }) => {
      const signal = scope.signal;

      // Auto-load if needed
      const state = scope.getState();
      if (state.activeModelId !== model || state.status !== 'ready') {
        const status = state.status;
        switch (status) {
        case 'loading':
          // FIFO admission has already waited for preceding operations. Seeing
          // loading inside the owned scope is an unexpected service state.
          throw new Error('Engine is busy. Please wait for the current operation to finish.');
        case 'idle':
        case 'ready':
        case 'error':
          break;
        default: {
          const _ex: never = status;
          throw new Error(`Unhandled status: ${_ex}`);
        }
        }

        console.log(`[TransformersJsProvider] Auto-loading model: ${model}`);
        await scope.loadDownloadedModel({ modelId: model });
      }

      const currentMessages: ChatMessage[] = acceptedMessages;
      // In-memory ownership of this public operation, including its tool loop.
      // It is not a conversation identifier and is never persisted or captured.
      const continuationOwner = crypto.randomUUID();

      while (true) {
        if (signal?.aborted) throw new Error('Generation aborted');

        onAssistantMessageStart?.();

        let receivedToolCalls: ToolCall[] = [];
        let fullContent = '';

        await scope.generateText({
          messages: currentMessages,
          onChunk: ({ chunk }) => {
            fullContent += chunk; return onChunk({ chunk });
          },
          onToolCalls: ({ toolCalls }) => {
            receivedToolCalls = toolCalls;
          },
          params: acceptedParameters,
          tools: workerTools,
          continuationOwner,
        });

        if (receivedToolCalls.length === 0) break;

        currentMessages.push({
          role: 'assistant',
          content: fullContent,
          tool_calls: receivedToolCalls,
        });

        for (const tc of receivedToolCalls) {
          if (signal?.aborted) throw new Error('Generation aborted');

          onToolCall?.({
            id: tc.id,
            toolName: tc.function.name,
            modelVisibleArguments: tc.function.arguments,
          });
          scope.assertActive();

          const tool = acceptedTools?.find(t => t.name === tc.function.name);
          let result: string;
          let parsedArgs: unknown;

          try {
            parsedArgs = JSON.parse(tc.function.arguments);
          } catch (e) {
            const errorResult: ToolExecutionOutcome = {
              status: 'error',
              code: 'invalid_arguments',
              message: `Failed to parse tool arguments: ${e instanceof Error ? e.message : String(e)}`,
            };
            onToolResult?.({ id: tc.id, result: errorResult });
            currentMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: formatToolExecutionOutcomeForLm({ outcome: errorResult }),
            });
            continue;
          }

          if (!tool) {
            const errorResult: ToolExecutionOutcome = {
              status: 'error',
              code: 'other',
              message: `Tool "${tc.function.name}" not found.`,
            };
            onToolResult?.({ id: tc.id, result: errorResult });
            result = formatToolExecutionOutcomeForLm({ outcome: errorResult });
          } else {
            try {
              const validatedArgs = tool.parametersSchema.strict().parse(parsedArgs);
              scope.assertActive();
              const executionResult = await tool.execute({
                args: validatedArgs,
                signal,
                onEvent: async ({ event }) => {
                  if (signal.aborted) return;
                  scope.assertActive();
                  onToolEvent?.({ id: tc.id, event });
                },
                approvalContext: toolApprovalContext,
              });
              if (signal?.aborted) throw new Error('Generation aborted');
              onToolResult?.({ id: tc.id, result: executionResult });
              result = formatToolExecutionOutcomeForLm({ outcome: executionResult });
            } catch (e) {
              if (signal.aborted) throw new Error('Generation aborted');
              scope.assertActive();
              if (e instanceof Error && e.message === 'Generation aborted') throw e;

              const errorResult: ToolExecutionOutcome = e instanceof z.ZodError
                ? { status: 'error', code: 'invalid_arguments', message: `Invalid arguments: ${e.message}` }
                : { status: 'error', code: 'other', message: e instanceof Error ? e.message : String(e) };

              onToolResult?.({ id: tc.id, result: errorResult });
              result = formatToolExecutionOutcomeForLm({ outcome: errorResult });
            }
          }

          currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
      }
    } });
  }

  async listModels({ signal: _signal }: { signal?: AbortSignal }): Promise<string[]> {
    try {
      const models = await this.service.listCachedModels();
      // Only return complete models to the general selector to ensure they are ready for use
      return models.filter(m => m.isComplete).map(m => m.id);
    } catch (err) {
      console.warn('Failed to list local models for provider:', err);
      return [];
    }
  }
}

/** The normal facade and isolated owners share this exact chat/tool-loop implementation. */
export function createTransformersJsProvider({ service }: { service: TransformersJsProviderService }): LmProvider {
  return new HostedTransformersJsProvider({ service });
}

// Preserve the ordinary facade (including its standalone replacement) without
// temporarily swapping module state or introducing an alternate chat path.
export class TransformersJsProvider extends HostedTransformersJsProvider {
  constructor() {
    super({ service: transformersJsService });
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
