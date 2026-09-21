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
import { nanoid } from 'nanoid';
import { toToolCallId, type BinaryObjectId } from '@/01-models/ids';
import type { LmParameters, ChatMessage } from '@/01-models/types';
import { useGlobalEvents } from '@/composables/useGlobalEvents';
import { getDefaultLmFetch, type LmFetch } from '@/features/lm/fetch';
import { type LmProvider, type ChatGenerationItem, UNKNOWN_STEPS } from '@/01-models/lm';
import { createChatGenerationStream } from '@/logic/create-chat-generation-stream';
import { buildApiChatMessages, snapshotChatRequest } from './chat-request';
import { readApiErrorDetails } from './response-stream';
import { readStreamLines } from '@/utils/read-stream-lines';

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
        arguments: z.union([z.string(), z.record(z.string(), z.json())]),
      }),
    })).optional(),
  }).optional(),
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  error: z.string().optional(),
});

const OllamaTagsSchema = z.object({
  models: z.array(z.object({
    name: z.string(),
  })),
});

const OllamaRunningModelSchema = z.object({
  name: z.string(),
  model: z.string().optional(),
  size: z.number().nonnegative().optional(),
  digest: z.string().optional(),
  details: z.object({
    parent_model: z.string().optional(),
    format: z.string().optional(),
    family: z.string().optional(),
    families: z.array(z.string()).nullable().optional(),
    parameter_size: z.string().optional(),
    quantization_level: z.string().optional(),
  }).optional(),
  expires_at: z.string().optional(),
  size_vram: z.number().nonnegative().optional(),
  context_length: z.number().int().nonnegative().optional(),
});

const OllamaPsSchema = z.object({
  models: z.array(OllamaRunningModelSchema),
});

const OllamaUnloadResponseSchema = z.object({
  done: z.literal(true),
  done_reason: z.literal('unload'),
});

export interface OllamaRunningModel {
  readonly name: string,
  readonly model: string | undefined,
  readonly size: number | undefined,
  readonly digest: string | undefined,
  readonly expiresAt: string | undefined,
  readonly sizeVram: number | undefined,
  readonly contextLength: number | undefined,
  readonly details: {
    readonly parentModel: string | undefined,
    readonly format: string | undefined,
    readonly family: string | undefined,
    readonly families: readonly string[] | undefined,
    readonly parameterSize: string | undefined,
    readonly quantizationLevel: string | undefined,
  },
}

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
  role: string,
  content: string,
  images?: string[],
  thinking?: string,
  tool_name?: string,
  tool_calls?: unknown[],
  tool_call_id?: string,
}

interface OllamaChatRequest {
  model: string,
  messages: OllamaMessage[],
  stream: boolean,
  options?: Record<string, unknown>,
  think?: boolean | 'low' | 'medium' | 'high',
  tools?: {
    type: 'function',
    function: {
      name: string,
      description: string,
      parameters: unknown,
    },
  }[],
}

function createOllamaNetworkErrorMessage({ error }: {
  error: unknown,
}): string {
  let message = `Network error or CORS issue: ${error instanceof Error ? error.message : String(error)}`;
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    message += ". Since you are running from a file URL, ensure Ollama is started with OLLAMA_ORIGINS='*' (e.g., OLLAMA_ORIGINS='*' ollama serve).";
  }
  return message;
}

async function readOllamaErrorDetails({ response }: {
  response: Response,
}): Promise<string> {
  try {
    const rawError: unknown = await response.json();
    const parsed = z.object({ error: z.unknown().optional() }).safeParse(rawError);
    if (parsed.success && parsed.data.error !== undefined) {
      return typeof parsed.data.error === 'string'
        ? parsed.data.error
        : JSON.stringify(parsed.data.error);
    }
    return JSON.stringify(rawError);
  } catch {
    return response.statusText;
  }
}

async function blobToBase64({ blob }: { blob: Blob }): Promise<string> {
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

export class OllamaProvider implements LmProvider {
  private config: {
    endpoint: string,
    headers?: [string, string][],
    fetcher: LmFetch,
  };

  constructor({ endpoint, headers, fetcher }: { endpoint: string, headers?: [string, string][], fetcher?: LmFetch }) {
    this.config = { endpoint, headers, fetcher: fetcher ?? getDefaultLmFetch() };
  }

  chat({ messages, model, parameters, tools, readBinaryObject, signal }: {
    messages: readonly ChatMessage[],
    model: string,
    parameters: LmParameters | undefined,
    tools: Parameters<LmProvider['chat']>[0]['tools'],
    readBinaryObject: (({ binaryObjectId, signal }: { binaryObjectId: BinaryObjectId, signal: AbortSignal | undefined }) => Promise<Blob>) | undefined,
    signal: AbortSignal | undefined,
  }): AsyncIterable<ChatGenerationItem> {
    const snapshot = snapshotChatRequest({ messages, parameters, tools });
    const { endpoint, headers, fetcher } = this.config;
    const requestHeaders = headers?.map(([name, value]): [string, string] => [name, value]);
    return createChatGenerationStream({ signal, run: async ({ writer, signal }) => {
      const url = `${endpoint.replace(/\/$/, '')}/api/chat`;
      const projected = await buildApiChatMessages({ messages: snapshot.messages, readBinaryObject, signal });
      const callNames = new Map<string, string>();
      const body: OllamaChatRequest = {
        model, stream: true,
        messages: projected.map(message => {
          const { role, content, reasoning_content, tool_calls, tool_call_id, ...unhandled } = message;
          unhandled satisfies Record<PropertyKey, never>;
          const images: string[] = [];
          let text = '';
          if (typeof content === 'string') text = content;
          else if (content) {
            for (const part of content) {
              switch (part.type) {
              case 'text': text += part.text; break;
              case 'image_url': images.push(part.image_url.url.split(',')[1]!); break;
              default: { const _ex: never = part; throw new Error(`Unhandled API content: ${_ex}`); }
              }
            }
          }
          const calls = tool_calls?.map(call => {
            callNames.set(call.id, call.function.name);
            let args: unknown;
            try {
              args = JSON.parse(call.function.arguments);
            } catch {
              args = call.function.arguments;
            }
            // Ollama expects object arguments, unlike the string form kept in history.
            // This API projection never changes the persisted call text.
            return { id: call.id, type: call.type, function: { name: call.function.name, arguments: args } };
          });
          return {
            role, content: text, images: images.length ? images : undefined,
            thinking: reasoning_content, tool_calls: calls, tool_call_id,
            tool_name: tool_call_id === undefined ? undefined : callNames.get(tool_call_id),
          };
        }),
      };
      if (snapshot.tools?.length) body.tools = snapshot.tools.map(tool => ({ type: 'function', function: tool }));
      if (snapshot.parameters) {
        const { temperature, topP, maxCompletionTokens, presencePenalty, frequencyPenalty, stop, reasoning, ...unhandled } = snapshot.parameters;
        unhandled satisfies Record<PropertyKey, never>;
        body.options = { temperature, top_p: topP, num_predict: maxCompletionTokens, presence_penalty: presencePenalty, frequency_penalty: frequencyPenalty, stop };
        switch (reasoning.effort) {
        case undefined: break;
        case 'none': body.think = false; break;
        case 'low':
        case 'medium':
        case 'high': body.think = reasoning.effort; break;
        default: { const _ex: never = reasoning.effort; throw new Error(`Unhandled effort: ${_ex}`); }
        }
      }
      async function request(): Promise<Response> {
        signal.throwIfAborted();
        try {
          return await fetcher(url, { method: 'POST', headers: [['Content-Type', 'application/json'], ...(requestHeaders ?? [])], body: JSON.stringify(body), signal });
        } catch (error) {
          if (signal.aborted) throw error;
          const message = createOllamaNetworkErrorMessage({ error });
          addErrorEvent({ source: 'OllamaProvider', message, details: { error, url, method: 'POST' } });
          throw new Error(message);
        }
      }
      let response = await request();
      if (!response.ok && typeof body.think === 'string') {
        const details = await readApiErrorDetails({ response: response.clone() });
        if (details.includes('think value') && details.includes('is not supported')) {
          await response.body?.cancel();
          body.think = true;
          response = await request();
        }
      }
      if (!response.ok) {
        const message = `Ollama API Error (${response.status}): ${await readApiErrorDetails({ response })}`;
        addErrorEvent({ source: 'OllamaProvider', message, details: { status: response.status, url } });
        throw new Error(message);
      }
      if (!response.body) throw new Error('No response body');
      let calls = 0;
      const ids = new Set<string>();
      try {
        for await (const line of readStreamLines({ stream: response.body, signal, maxLineLength: 8 * 1024 * 1024 })) {
          if (!line.trim()) continue;
          const chunk = OllamaChatChunkSchema.parse(JSON.parse(line));
          if (chunk.message === undefined && chunk.done === undefined && chunk.error === undefined) {
            throw new Error('Ollama returned neither generation content nor a completion state.');
          }
          if (chunk.error !== undefined) throw new Error(chunk.error);
          if (chunk.message?.thinking) await writer.text({ type: 'reasoning', text: chunk.message.thinking });
          if (chunk.message?.content) await writer.text({ type: 'text', text: chunk.message.content });
          for (const call of chunk.message?.tool_calls ?? []) {
            if (!call.function.name) throw new Error('The tool call has no function name.');
            const id = call.id || nanoid();
            if (ids.has(id)) throw new Error('Duplicate completed tool call ID.');
            ids.add(id);
            // An Ollama tool_calls item carries the complete call, not token deltas.
            await writer.call({ key: calls++, toolCall: { id: toToolCallId({ raw: id }), type: 'function', function: {
              name: call.function.name,
              arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments),
            } } });
          }
          if (chunk.done) {
            switch (chunk.done_reason) {
            case undefined:
            case 'stop': return { type: 'finished', next: calls ? 'tool_results' : 'user' };
            case 'length': return { type: 'interrupted', reason: 'limit' };
            default: return { type: 'interrupted', reason: 'unknown' };
            }
          }
        }
        return { type: 'interrupted', reason: 'unknown' };
      } catch (error) {
        if (!signal.aborted) addErrorEvent({ source: 'OllamaProvider', message: 'Failed to read or validate Ollama JSON', details: { error: error instanceof Error ? error : String(error) } });
        throw error;
      }
    } });
  }

  async listModels({ signal }: { signal: AbortSignal | undefined }): Promise<string[]> {
    const { endpoint, headers, fetcher } = this.config;
    const url = `${endpoint.replace(/\/$/, '')}/api/tags`;
    let response: Response;
    try {
      response = await fetcher(url, { signal, headers });
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
          details: { error: e, url },
        });
        throw new Error(message);
      }
      throw e;
    }

    if (!response.ok) {
      const details = await readApiErrorDetails({ response });
      const errorMsg = `Failed to fetch models (${response.status}): ${details}`;
      addErrorEvent({
        source: 'OllamaProvider:listModels',
        message: errorMsg,
        details: { status: response.status, statusText: response.statusText, url },
      });
      throw new Error(errorMsg);
    }
    const rawJson = await response.json();
    // Validate with Zod
    const validated = OllamaTagsSchema.parse(rawJson);
    return validated.models.map((m) => m.name);
  }

  async listRunningModels({ signal }: {
    signal?: AbortSignal,
  }): Promise<readonly OllamaRunningModel[]> {
    const { endpoint, headers, fetcher } = this.config;
    const url = `${endpoint.replace(/\/$/, '')}/api/ps`;
    let response: Response;

    try {
      response = await fetcher(url, { signal, headers });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }

      const message = createOllamaNetworkErrorMessage({ error });
      addErrorEvent({
        source: 'OllamaProvider:listRunningModels',
        message,
        details: { error, url, method: 'GET' },
      });
      throw new Error(message);
    }

    if (!response.ok) {
      const details = await readOllamaErrorDetails({ response });
      const message = `Failed to fetch running models (${response.status}): ${details}`;
      addErrorEvent({
        source: 'OllamaProvider:listRunningModels',
        message,
        details: { status: response.status, statusText: response.statusText, url },
      });
      throw new Error(message);
    }

    const validated = OllamaPsSchema.parse(await response.json());
    return validated.models.map((model) => ({
      name: model.name,
      model: model.model,
      size: model.size,
      digest: model.digest,
      expiresAt: model.expires_at,
      sizeVram: model.size_vram,
      contextLength: model.context_length,
      details: {
        parentModel: model.details?.parent_model,
        format: model.details?.format,
        family: model.details?.family,
        families: model.details?.families ?? undefined,
        parameterSize: model.details?.parameter_size,
        quantizationLevel: model.details?.quantization_level,
      },
    }));
  }

  async unloadModel({ model, signal }: {
    model: string,
    signal?: AbortSignal,
  }): Promise<void> {
    const { endpoint, headers, fetcher } = this.config;
    const url = `${endpoint.replace(/\/$/, '')}/api/generate`;
    let response: Response;

    try {
      response = await fetcher(url, {
        method: 'POST',
        headers: [
          ['Content-Type', 'application/json'],
          ...(headers ?? []),
        ],
        body: JSON.stringify({
          model,
          stream: false,
          keep_alive: 0,
        }),
        signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error;
      }

      const message = createOllamaNetworkErrorMessage({ error });
      addErrorEvent({
        source: 'OllamaProvider:unloadModel',
        message,
        details: { error, url, method: 'POST', model },
      });
      throw new Error(message);
    }

    if (!response.ok) {
      const details = await readOllamaErrorDetails({ response });
      const message = `Failed to unload model (${response.status}): ${details}`;
      addErrorEvent({
        source: 'OllamaProvider:unloadModel',
        message,
        details: { status: response.status, statusText: response.statusText, url, model },
      });
      throw new Error(message);
    }

    OllamaUnloadResponseSchema.parse(await response.json());
  }

  async generateImage({ prompt, model, width, height, steps, seed, images, onProgress, signal }: {
    prompt: string,
    model: string,
    width: number,
    height: number,
    steps: number | undefined,
    seed: number | undefined,
    images: { blob: Blob }[],
    onProgress: ({ currentStep, totalSteps }: { currentStep: number, totalSteps: number }) => void,
    signal: AbortSignal | undefined,
  }): Promise<{ image: Blob, totalSteps: number | typeof UNKNOWN_STEPS }> {
    const { endpoint, headers, fetcher } = this.config;
    const url = `${endpoint.replace(/\/$/, '')}/api/generate`;

    const b64Images = images.length > 0
      ? await Promise.all(images.map(img => blobToBase64({ blob: img.blob })))
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
      response = await fetcher(url, {
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
        details: { status: response.status, statusText: response.statusText, url },
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
      totalSteps,
    };
  }
}

// Export internal state and logic used only for testing here. Do not reference these in production logic.
// ESLint-required for TypeScript modules.
export const TEST_ONLY = {
};
