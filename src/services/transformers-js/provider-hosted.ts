import { z } from 'zod';
import type { LLMProvider } from '@/services/lm/types';
import type { ChatMessage, LmParameters, ToolCall } from '@/models/types';
import { transformersJsService } from './index';
import type { Tool } from '@/services/tools/types';
import type { ToolApprovalContext } from '@/services/approval';
import type { WorkerToolDefinition } from './types';
import { zodToJsonSchema } from '@/utils/llm-tools';

export class TransformersJsProvider implements LLMProvider {
  async chat({ messages, model, onChunk, parameters, tools, toolApprovalContext, onToolCall, onToolEvent, onToolResult, onAssistantMessageStart, signal }: {
    messages: ChatMessage[];
    model: string;
    onChunk: ({ chunk }: { chunk: string }) => void;
    parameters?: LmParameters;
    tools?: Tool[];
    toolApprovalContext?: ToolApprovalContext;
    onToolCall?: ({ id, toolName, args }: { id: string; toolName: string; args: unknown }) => void;
    onToolEvent?: ({ id, event }: { id: string; event: import('@/services/tools/types').ToolExecutionEvent }) => void;
    onToolResult?: ({ id, result }: {
      id: string;
      result: | { status: 'success'; content: string } | { status: 'error'; code: import('@/services/tools/types').ToolExecutionErrorCode; message: string };
    }) => void;
    onAssistantMessageStart?: () => void;
    signal?: AbortSignal;
  }): Promise<void> {

    // Auto-load if needed
    const state = transformersJsService.getState();
    if (state.activeModelId !== model || state.status !== 'ready') {
      const status = state.status;
      switch (status) {
      case 'loading':
        // Wait for the existing loading process to finish if it's the same model,
        // otherwise throw or wait for it to fail. For now, keep it simple.
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
      await transformersJsService.loadModel({ modelId: model });
    }

    const workerTools: WorkerToolDefinition[] | undefined = tools && tools.length > 0
      ? tools.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: zodToJsonSchema({ schema: t.parametersSchema }) as Record<string, unknown>,
        },
      }))
      : undefined;

    const currentMessages: ChatMessage[] = [...messages];

    while (true) {
      if (signal?.aborted) throw new Error('Generation aborted');

      onAssistantMessageStart?.();

      let receivedToolCalls: ToolCall[] = [];
      let fullContent = '';

      await transformersJsService.generateText({
        messages: currentMessages,
        onChunk: ({ chunk }) => {
          fullContent += chunk; onChunk({ chunk });
        },
        onToolCalls: ({ toolCalls }) => {
          receivedToolCalls = toolCalls;
        },
        params: parameters,
        tools: workerTools,
        signal,
      });

      if (receivedToolCalls.length === 0) break;

      currentMessages.push({
        role: 'assistant',
        content: fullContent,
        tool_calls: receivedToolCalls,
      });

      for (const tc of receivedToolCalls) {
        if (signal?.aborted) throw new Error('Generation aborted');

        const tool = tools?.find(t => t.name === tc.function.name);
        let result: string;
        let parsedArgs: unknown;

        try {
          parsedArgs = JSON.parse(tc.function.arguments);
        } catch (e) {
          const errorResult: { status: 'error'; code: import('@/services/tools/types').ToolExecutionErrorCode; message: string } = {
            status: 'error',
            code: 'invalid_arguments',
            message: `Error: Failed to parse tool arguments: ${e instanceof Error ? e.message : String(e)}`,
          };
          onToolResult?.({ id: tc.id, result: errorResult });
          currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: errorResult.message });
          continue;
        }

        if (!tool) {
          const errorResult: { status: 'error'; code: import('@/services/tools/types').ToolExecutionErrorCode; message: string } = {
            status: 'error',
            code: 'other',
            message: `Tool "${tc.function.name}" not found.`,
          };
          onToolResult?.({ id: tc.id, result: errorResult });
          result = errorResult.message;
        } else {
          try {
            const validatedArgs = tool.parametersSchema.strict().parse(parsedArgs);
            onToolCall?.({ id: tc.id, toolName: tool.name, args: validatedArgs });
            const executionResult = await tool.execute({
              args: validatedArgs,
              signal,
              onEvent: async ({ event }) => {
                onToolEvent?.({ id: tc.id, event });
              },
              approvalContext: toolApprovalContext,
            });
            if (signal?.aborted) throw new Error('Generation aborted');
            onToolResult?.({ id: tc.id, result: executionResult });

            switch (executionResult.status) {
            case 'success':
              result = executionResult.content;
              break;
            case 'error':
              result = `Error [${executionResult.code}]: ${executionResult.message}`;
              break;
            default: {
              const _ex: never = executionResult;
              result = `Error: Unhandled tool execution status: ${(_ex as { status: string }).status}`;
            }
            }
          } catch (e) {
            if (e instanceof Error && e.message === 'Generation aborted') throw e;

            const errorResult: { status: 'error'; code: import('@/services/tools/types').ToolExecutionErrorCode; message: string } = e instanceof z.ZodError
              ? { status: 'error', code: 'invalid_arguments', message: `Invalid arguments: ${e.message}` }
              : { status: 'error', code: 'other', message: e instanceof Error ? e.message : String(e) };

            onToolResult?.({ id: tc.id, result: errorResult });
            result = `Error: ${errorResult.message}`;
          }
        }

        currentMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }
  }

  async listModels({ signal: _signal }: { signal?: AbortSignal }): Promise<string[]> {
    try {
      const models = await transformersJsService.listCachedModels();
      // Only return complete models to the general selector to ensure they are ready for use
      return models.filter(m => m.isComplete).map(m => m.id);
    } catch (err) {
      console.warn('Failed to list local models for provider:', err);
      return [];
    }
  }
}
