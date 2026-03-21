/**
 * OpenAI Service Provider
 *
 * This file handles communication with OpenAI compatible APIs.
 *
 * CRITICAL: All API responses MUST be validated using Zod schemas.
 * External APIs are unreliable and may change their response structure without notice.
 * Validation ensures that type errors do not leak into the application logic
 * and that we handle unexpected API behavior gracefully.
 */
import { z } from 'zod';
import { zodToJsonSchema } from '@/utils/llm-tools';
import type { LmParameters, ChatMessage } from '@/models/types';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import type { Tool } from '@/services/tools/types';
import { type LLMProvider } from './types';

const { addErrorEvent } = useGlobalEvents();

const OpenAIChatChunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      content: z.string().nullable().optional(),
      reasoning: z.string().nullable().optional(),
      reasoning_content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({
        index: z.number(),
        id: z.string().optional(),
        type: z.literal('function').optional(),
        function: z.object({
          name: z.string().optional(),
          arguments: z.string().optional(),
        }).optional(),
      })).optional(),
    }).optional(),
  })),
});

const OpenAIModelsSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
  })),
});

interface OpenAICompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  temperature?: number;
  top_p?: number;
  max_completion_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stop?: string[];
  reasoning_effort?: 'none' | 'low' | 'medium' | 'high';
  tools?: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: unknown;
    };
  }[];
}

export class OpenAIProvider implements LLMProvider {
  private config: {
    endpoint: string;
    headers?: [string, string][];
  };

  constructor(config: { endpoint: string; headers?: [string, string][] }) {
    this.config = config;
  }

  async chat(params: {
    messages: ChatMessage[];
    model: string;
    onChunk: (chunk: string) => void;
    parameters?: LmParameters;
    tools?: Tool[];
    onToolCall?: (params: { id: string; toolName: string; args: unknown }) => void;
    onToolResult?: (params: {
      id: string;
      result: | { status: 'success'; content: string } | { status: 'error'; code: import('../tools/types').ToolExecutionErrorCode; message: string };
    }) => void;
    onAssistantMessageStart?: () => void;
    signal?: AbortSignal;
  }): Promise<void> {
    const { messages, model, onChunk, parameters, tools, onToolCall, onToolResult, onAssistantMessageStart, signal } = params;
    const { endpoint, headers } = this.config;
    const url = `${endpoint.replace(/\/$/, '')}/chat/completions`;

    // Local copy to manage the conversation loop (tool calls/results)
    const currentMessages: ChatMessage[] = [...messages];

    while (true) {
      if (signal?.aborted) throw new Error('Generation aborted');

      onAssistantMessageStart?.();

      const body: OpenAICompletionRequest = {
        model,
        messages: currentMessages,
        stream: true,
      };

      if (parameters) {
        if (parameters.temperature !== undefined) body.temperature = parameters.temperature;
        if (parameters.topP !== undefined) body.top_p = parameters.topP;
        if (parameters.maxCompletionTokens !== undefined) body.max_completion_tokens = parameters.maxCompletionTokens;
        if (parameters.presencePenalty !== undefined) body.presence_penalty = parameters.presencePenalty;
        if (parameters.frequencyPenalty !== undefined) body.frequency_penalty = parameters.frequencyPenalty;
        if (parameters.stop !== undefined) body.stop = parameters.stop;
        if (parameters.reasoning?.effort !== undefined) body.reasoning_effort = parameters.reasoning.effort;
      }

      if (tools && tools.length > 0) {
        body.tools = tools.map(t => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: zodToJsonSchema({ schema: t.parametersSchema }),
          }
        }));
      }

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: [
            ['Content-Type', 'application/json'],
            ...(headers || []),
          ],
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        const isAbort = e instanceof Error && e.name === 'AbortError';
        if (!isAbort) {
          const message = `Network error or CORS issue: ${e instanceof Error ? e.message : String(e)}. Please check if the server is running and your endpoint URL is correct.`;
          addErrorEvent({
            source: 'OpenAIProvider',
            message,
            details: { error: e, url, method: 'POST' },
          });
          throw new Error(message);
        }
        throw e;
      }

      if (!response.ok) {
        let details = response.statusText;
        try {
          const errorJson = await response.json();
          details = errorJson.error?.message || errorJson.error || JSON.stringify(errorJson);
        } catch (e) { /* ignore */ }
        const errorMsg = `OpenAI API Error (${response.status}): ${details}`;
        addErrorEvent({
          source: 'OpenAIProvider',
          message: errorMsg,
          details: { status: response.status, statusText: response.statusText, url }
        });
        throw new Error(errorMsg);
      }
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const accumulatedToolCalls: Map<string, import('../../models/types').ToolCall> = new Map();
      // Track the current active ID for each index to detect sequential calls on the same index
      const indexToCurrentIdMap: Map<number, string> = new Map();
      let fullContent = '';
      let isThinking = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (isThinking) {
            onChunk('</think>');
            fullContent += '</think>';
            isThinking = false;
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim() === '') continue;
          if (line.trim() === 'data: [DONE]') continue;
          if (!line.startsWith('data: ')) continue;

          try {
            const rawJson = JSON.parse(line.slice(6));
            const validated = OpenAIChatChunkSchema.parse(rawJson);
            const delta = validated.choices[0]?.delta;
            if (!delta) continue;

            const reasoning = delta.reasoning || delta.reasoning_content;
            if (reasoning) {
              if (!isThinking) {
                onChunk('<think>');
                fullContent += '<think>';
                isThinking = true;
              }
              fullContent += reasoning;
              onChunk(reasoning);
            }

            if (delta.content) {
              if (isThinking) {
                onChunk('</think>');
                fullContent += '</think>';
                isThinking = false;
              }
              fullContent += delta.content;
              onChunk(delta.content);
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  indexToCurrentIdMap.set(tc.index, tc.id);
                }
                const currentId = indexToCurrentIdMap.get(tc.index) || `index_${tc.index}`;
                // Using composite key ensures different IDs at the same index are handled separately
                const key = `${tc.index}_${currentId}`;

                if (!accumulatedToolCalls.has(key)) {
                  accumulatedToolCalls.set(key, {
                    id: tc.id || currentId,
                    type: 'function',
                    function: { name: '', arguments: '' }
                  });
                }
                const record = accumulatedToolCalls.get(key)!;
                if (tc.function?.name) {
                  if (record.function.name !== tc.function.name) {
                    record.function.name += tc.function.name;
                  }
                }
                if (tc.function?.arguments) {
                  if (record.function.arguments !== tc.function.arguments) {
                    record.function.arguments += tc.function.arguments;
                  }
                }
                if (tc.id) record.id = tc.id;
              }
            }
          } catch (e) {
            addErrorEvent({
              source: 'OpenAIProvider',
              message: 'Failed to parse or validate SSE line',
              details: { line, error: e instanceof Error ? e : String(e) },
            });
          }
        }
      }

      const toolCalls = Array.from(accumulatedToolCalls.values()).filter(tc => !!tc.function.name);

      if (toolCalls.length > 0) {
        // Execute tools and loop
        currentMessages.push({
          role: 'assistant',
          content: fullContent,
          tool_calls: toolCalls
        });

        for (const tc of toolCalls) {
          if (signal?.aborted) throw new Error('Generation aborted');

          const tool = tools?.find(t => t.name === tc.function.name);
          let result: string;
          let parsedArgs: unknown;

          if (typeof tc.function.arguments === 'string') {
            try {
              parsedArgs = JSON.parse(tc.function.arguments);
            } catch (e) {
              result = `Error: Failed to parse tool arguments: ${e instanceof Error ? e.message : String(e)}`;
            }
          } else {
            parsedArgs = tc.function.arguments;
          }

          if (tool && parsedArgs !== undefined) {
            try {
              if (signal?.aborted) throw new Error('Generation aborted');

              // Perform common strict validation here to enforce strictness globally
              const validatedArgs = tool.parametersSchema.strict().parse(parsedArgs);

              onToolCall?.({ id: tc.id, toolName: tool.name, args: validatedArgs });
              const executionResult = await tool.execute({ args: validatedArgs, signal });

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

              const errorResult: { status: 'error'; code: import('../tools/types').ToolExecutionErrorCode; message: string } = e instanceof z.ZodError
                ? { status: 'error', code: 'invalid_arguments', message: `Invalid arguments: ${e.message}` }
                : { status: 'error', code: 'other', message: e instanceof Error ? e.message : String(e) };

              onToolResult?.({ id: tc.id, result: errorResult });
              result = `Error: ${errorResult.message}`;
            }

          } else if (!tool) {
            const errorResult: { status: 'error'; code: import('../tools/types').ToolExecutionErrorCode; message: string } = { status: 'error', code: 'other', message: `Tool "${tc.function.name}" not found.` };
            onToolResult?.({ id: tc.id, result: errorResult });
            result = errorResult.message;
          } else {
            // result already set by parse catch block if parsedArgs is undefined
            result = result! || 'Error: Unknown failure.';
          }

          currentMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result
          });
        }
        continue; // Loop for next response from LLM
      }

      break; // No more tool calls or we already sent content
    }
  }

  async listModels(params: { signal?: AbortSignal }): Promise<string[]> {
    const { signal } = params;
    const { endpoint, headers } = this.config;
    const url = `${endpoint.replace(/\/$/, '')}/models`;
    let response: Response;
    try {
      response = await fetch(url, { signal, headers });
    } catch (e) {
      const isAbort = e instanceof Error && e.name === 'AbortError';
      if (!isAbort) {
        const message = `Network error or CORS issue: ${e instanceof Error ? e.message : String(e)}. Please check if the server is running and your endpoint URL is correct.`;
        addErrorEvent({
          source: 'OpenAIProvider:listModels',
          message,
          details: { error: e, url }
        });
        throw new Error(message);
      }
      throw e;
    }

    if (!response.ok) {
      let details = response.statusText;
      try {
        const errorJson = await response.json();
        details = errorJson.error?.message || errorJson.error || JSON.stringify(errorJson);
      } catch (e) { /* ignore */ }
      const errorMsg = `Failed to fetch models (${response.status}): ${details}`;
      addErrorEvent({
        source: 'OpenAIProvider:listModels',
        message: errorMsg,
        details: { status: response.status, statusText: response.statusText, url }
      });
      throw new Error(errorMsg);
    }
    const rawJson = await response.json();
    // Validate with Zod
    const validated = OpenAIModelsSchema.parse(rawJson);
    return validated.data.map((m) => m.id);
  }
}
