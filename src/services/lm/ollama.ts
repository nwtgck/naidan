/**
 * Ollama Service Provider
 *
 * This file handles communication with Ollama APIs.
 *
 * CRITICAL: All API responses MUST be validated using Zod schemas.
 * External APIs are unreliable and may change their response structure without notice.
 * Validation ensures that type errors do not leak into the application logic
 * and that we handle unexpected API behavior gracefully.
 */
import { z } from 'zod';
import { zodToJsonSchema } from '@/utils/llm-tools';
import type { LmParameters, ChatMessage, MultimodalContent } from '@/models/types';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import type { Tool } from '@/services/tools/types';
import { type LLMProvider, UNKNOWN_STEPS } from './types';

const { addErrorEvent } = useGlobalEvents();

const OllamaChatChunkSchema = z.object({
  message: z.object({
    role: z.string().optional(),
    content: z.string().nullable().optional(),
    thinking: z.string().nullable().optional(),
    tool_calls: z.array(z.object({
      id: z.string().optional(),
      function: z.object({
        name: z.string(),
        arguments: z.union([z.string(), z.record(z.string(), z.any())]),
      }),
    })).optional(),
  }).optional(),
  done: z.boolean().optional(),
});

const OllamaTagsSchema = z.object({
  models: z.array(z.object({
    name: z.string(),
  })),
});

const OllamaImageStreamChunkSchema = z.discriminatedUnion('done', [
  z.object({
    done: z.literal(false),
    completed: z.number().optional(),
    total: z.number().optional(),
  }),
  z.object({
    done: z.literal(true),
    image: z.string().optional(),
    total_duration: z.number().optional(),
    load_duration: z.number().optional(),
    done_reason: z.string().optional(),
  }),
]);

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
  tool_calls?: unknown[];
  tool_call_id?: string;
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: Record<string, unknown>;
  think?: boolean | 'low' | 'medium' | 'high';
  tools?: {
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: unknown;
    };
  }[];
}

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64 || '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export class OllamaProvider implements LLMProvider {
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
    const url = `${endpoint.replace(/\/$/, '')}/api/chat`;

    const currentMessages = [...messages];

    while (true) {
      if (signal?.aborted) throw new Error('Generation aborted');

      onAssistantMessageStart?.();

      // Transform messages to Ollama format
      const ollamaMessages: OllamaMessage[] = currentMessages.map(m => {
        const contentType = typeof m.content;

        const tool_calls = m.tool_calls?.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: (() => {
              if (typeof tc.function.arguments === 'string') {
                try {
                  return JSON.parse(tc.function.arguments);
                } catch (e) {
                  return tc.function.arguments;
                }
              }
              return tc.function.arguments;
            })()
          }
        }));

        switch (contentType) {
        case 'string':
          return { role: m.role, content: m.content as string, tool_calls, tool_call_id: m.tool_call_id };
        case 'object': {
          // Multimodal
          let content = '';
          const images: string[] = [];
          if (m.content) {
            for (const part of (m.content as MultimodalContent[])) {
              switch (part.type) {
              case 'text':
                content += part.text;
                break;
              case 'image_url': {
                // Strip data URL prefix if present: data:image/png;base64,xxxx
                const b64 = part.image_url.url.split(',')[1] || part.image_url.url;
                images.push(b64);
                break;
              }
              default: {
                const _ex: never = part;
                throw new Error(`Unhandled multimodal content type: ${_ex}`);
              }
              }
            }
          }
          return { role: m.role, content, images, tool_calls, tool_call_id: m.tool_call_id };
        }
        case 'undefined': {
          if (m.role === 'assistant' && tool_calls) {
            return { role: m.role, content: '', tool_calls, tool_call_id: m.tool_call_id };
          }
          throw new Error(`Unexpected content type for role ${m.role}: ${contentType}`);
        }
        case 'boolean':
        case 'number':
        case 'function':
        case 'symbol':
        case 'bigint':
          throw new Error(`Unexpected content type: ${contentType}`);
        default: {
          const _ex: never = contentType;
          throw new Error(`Unhandled content type: ${_ex}`);
        }
        }
      });
      const body: OllamaChatRequest = {
        model,
        messages: ollamaMessages,
        stream: true,
      };

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

      if (parameters) {
        const options: Record<string, unknown> = {};
        if (parameters.temperature !== undefined) options.temperature = parameters.temperature;
        if (parameters.topP !== undefined) options.top_p = parameters.topP;
        if (parameters.maxCompletionTokens !== undefined) options.num_predict = parameters.maxCompletionTokens;
        if (parameters.presencePenalty !== undefined) options.presence_penalty = parameters.presencePenalty;
        if (parameters.frequencyPenalty !== undefined) options.frequency_penalty = parameters.frequencyPenalty;
        if (parameters.stop !== undefined) options.stop = parameters.stop;

        if (Object.keys(options).length > 0) {
          body.options = options;
        }

        if (parameters.reasoning?.effort !== undefined) {
          const effort = parameters.reasoning.effort;
          switch (effort) {
          case 'none':
            body.think = false;
            break;
          case 'low':
          case 'medium':
          case 'high':
            body.think = effort;
            break;
          default: {
            const _ex: never = effort;
            throw new Error(`Unhandled reasoning effort: ${_ex}`);
          }
          }
        }
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
          let message = `Network error or CORS issue: ${e instanceof Error ? e.message : String(e)}`;
          if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
            message += ". Since you are running from a file URL, ensure Ollama is started with OLLAMA_ORIGINS='*' (e.g., OLLAMA_ORIGINS='*' ollama serve).";
          }
          addErrorEvent({
            source: 'OllamaProvider',
            message,
            details: { error: e, url, method: 'POST' },
          });
          throw new Error(message);
        }
        throw e;
      }

      // Handle model not supporting specific effort levels
      if (!response.ok && typeof body.think === 'string') {
        let isRetryable = false;
        try {
          const errorJson = await response.clone().json();
          const errorMsg = errorJson.error || JSON.stringify(errorJson);
          if (errorMsg.includes('think value') && errorMsg.includes('is not supported')) {
            isRetryable = true;
          }
        } catch (e) { /* ignore */ }

        if (isRetryable) {
          body.think = true; // Fallback to basic thinking
          response = await fetch(url, {
            method: 'POST',
            headers: [
              ['Content-Type', 'application/json'],
              ...(headers || []),
            ],
            body: JSON.stringify(body),
            signal,
          });
        }
      }

      if (!response.ok) {
        let details = response.statusText;
        try {
          const errorJson = await response.json();
          details = errorJson.error || JSON.stringify(errorJson);
        } catch (e) { /* ignore */ }
        const errorMsg = `Ollama API Error (${response.status}): ${details}`;
        addErrorEvent({
          source: 'OllamaProvider',
          message: errorMsg,
          details: { status: response.status, statusText: response.statusText, url }
        });
        throw new Error(errorMsg);
      }
      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      let isThinking = false;
      const accumulatedToolCalls: import('../../models/types').ToolCall[] = [];
      let fullContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const rawJson = JSON.parse(line);
            // Validate with Zod
            const validated = OllamaChatChunkSchema.parse(rawJson);

            const thinking = validated.message?.thinking || '';
            if (thinking) {
              if (!isThinking) {
                onChunk('<think>');
                fullContent += '<think>';
                isThinking = true;
              }
              fullContent += thinking;
              onChunk(thinking);
            }

            const content = validated.message?.content || '';
            if (content) {
              if (isThinking) {
                onChunk('</think>');
                fullContent += '</think>';
                isThinking = false;
              }
              fullContent += content;
              onChunk(content);
            }

            if (validated.message?.tool_calls) {
              for (const tc of validated.message.tool_calls) {
                accumulatedToolCalls.push({
                  id: tc.id || '',
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)
                  }
                });
              }
            }

            if (validated.done) {
              if (isThinking) {
                onChunk('</think>');
                fullContent += '</think>';
                isThinking = false;
              }
              break;
            }
          } catch (e) {
            addErrorEvent({
              source: 'OllamaProvider',
              message: 'Failed to parse or validate Ollama JSON',
              details: { line, error: e instanceof Error ? e : String(e) },
            });
            console.warn('Failed to parse or validate Ollama JSON', line, e);
          }
        }
        // If we broke out of the for loop due to validated.done, we should break the reader loop too
        const lastLine = lines[lines.length - 1];
        if (lastLine) {
          try {
            if (JSON.parse(lastLine).done) break;
          } catch (e) { /* ignore */ }
        }
      }

      if (accumulatedToolCalls.length > 0) {
        currentMessages.push({
          role: 'assistant',
          content: fullContent,
          tool_calls: accumulatedToolCalls
        });

        for (const tc of accumulatedToolCalls) {
          if (signal?.aborted) throw new Error('Generation aborted');

          const tool = tools?.find(t => t.name === tc.function.name);
          let result: string;
          let args: unknown;

          if (typeof tc.function.arguments === 'string') {
            try {
              args = JSON.parse(tc.function.arguments);
            } catch (e) {
              result = `Error: Failed to parse tool arguments: ${e instanceof Error ? e.message : String(e)}`;
            }
          } else {
            args = tc.function.arguments;
          }

          if (tool && args !== undefined) {
            try {
              if (signal?.aborted) throw new Error('Generation aborted');

              // Perform common strict validation here to enforce strictness globally
              const validatedArgs = tool.parametersSchema.strict().parse(args);

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
            result = result! || 'Error: Unknown failure.';
          }
          currentMessages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: result
          });
        }
        continue;
      }
      break;
    }
  }

  async listModels(params: { signal?: AbortSignal }): Promise<string[]> {
    const { signal } = params;
    const { endpoint, headers } = this.config;
    const url = `${endpoint.replace(/\/$/, '')}/api/tags`;
    let response: Response;
    try {
      response = await fetch(url, { signal, headers });
    } catch (e) {
      const isAbort = e instanceof Error && e.name === 'AbortError';
      if (!isAbort) {
        let message = `Network error or CORS issue: ${e instanceof Error ? e.message : String(e)}`;
        if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
          message += ". Since you are running from a file URL, ensure Ollama is started with OLLAMA_ORIGINS='*' (e.g., OLLAMA_ORIGINS='*' ollama serve).";
        }
        addErrorEvent({
          source: 'OllamaProvider:listModels',
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
        details = errorJson.error || JSON.stringify(errorJson);
      } catch (e) { /* ignore */ }
      const errorMsg = `Failed to fetch models (${response.status}): ${details}`;
      addErrorEvent({
        source: 'OllamaProvider:listModels',
        message: errorMsg,
        details: { status: response.status, statusText: response.statusText, url }
      });
      throw new Error(errorMsg);
    }
    const rawJson = await response.json();
    // Validate with Zod
    const validated = OllamaTagsSchema.parse(rawJson);
    return validated.models.map((m) => m.name);
  }

  async generateImage({ prompt, model, width, height, steps, seed, images, onProgress, signal }: {
    prompt: string;
    model: string;
    width: number;
    height: number;
    steps: number | undefined;
    seed: number | undefined;
    images: { blob: Blob }[];
    onProgress: (params: { currentStep: number; totalSteps: number }) => void;
    signal: AbortSignal | undefined;
  }): Promise<{ image: Blob, totalSteps: number | typeof UNKNOWN_STEPS }> {
    const { endpoint, headers } = this.config;
    const url = `${endpoint.replace(/\/$/, '')}/api/generate`;

    const b64Images = images.length > 0
      ? await Promise.all(images.map(img => blobToBase64(img.blob)))
      : undefined;

    const body = {
      model,
      prompt,
      images: b64Images,
      stream: true,
      width,
      height,
      steps,
      options: seed !== undefined ? { seed } : undefined,
    };

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
        let message = `Network error or CORS issue: ${e instanceof Error ? e.message : String(e)}`;
        if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
          message += ". Since you are running from a file URL, ensure Ollama is started with OLLAMA_ORIGINS='*' (e.g., OLLAMA_ORIGINS='*' ollama serve).";
        }
        addErrorEvent({
          source: 'OllamaProvider:generateImage',
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
        details = (typeof errorJson.error === 'object' ? errorJson.error?.message : errorJson.error) || JSON.stringify(errorJson);
      } catch (e) { /* ignore */ }
      const errorMsg = `Ollama Image Generation Error (/api/generate, ${response.status}): ${details}`;
      addErrorEvent({
        source: 'OllamaProvider:generateImage',
        message: errorMsg,
        details: { status: response.status, statusText: response.statusText, url }
      });
      throw new Error(errorMsg);
    }
    if (!response.body) throw new Error('No response body');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let b64Data = '';
    let totalSteps: number | typeof UNKNOWN_STEPS = UNKNOWN_STEPS;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const rawJson = JSON.parse(line);
          const validated = OllamaImageStreamChunkSchema.parse(rawJson);

          if (validated.done) {
            if (validated.image) {
              b64Data = validated.image;
            }
          } else {
            if (validated.completed !== undefined && validated.total !== undefined) {
              totalSteps = validated.total;
              onProgress({ currentStep: validated.completed, totalSteps: validated.total });
            }
          }
        } catch (e) {
          addErrorEvent({
            source: 'OllamaProvider:generateImage',
            message: 'Failed to parse or validate Ollama Image Generation JSON',
            details: { line, error: e instanceof Error ? e : String(e) },
          });
          console.warn('Failed to parse or validate Ollama Image Generation JSON', line, e);
        }
      }
    }

    if (buffer.trim()) {
      try {
        const rawJson = JSON.parse(buffer);
        const validated = OllamaImageStreamChunkSchema.parse(rawJson);
        if (validated.done && validated.image) {
          b64Data = validated.image;
        }
      } catch (e) {
        addErrorEvent({
          source: 'OllamaProvider:generateImage',
          message: 'Failed to parse trailing Ollama Image Generation JSON buffer',
          details: { buffer, error: e instanceof Error ? e : String(e) },
        });
        console.warn('Failed to parse trailing Ollama Image Generation JSON buffer', buffer, e);
      }
    }

    if (!b64Data) {
      throw new Error('Could not find image data in Ollama response.');
    }

    // Avoid fetching data URLs due to Content Security Policy restrictions.
    // Convert base64 string to Blob (browser-compatible)
    const byteCharacters = atob(b64Data);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return {
      image: new Blob([byteArray], { type: 'image/png' }),
      totalSteps
    };
  }
}
