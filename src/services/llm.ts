/**
 * LLM Service Providers
 * 
 * This file handles communication with various LLM APIs (OpenAI compatible and Ollama).
 * 
 * CRITICAL: All API responses MUST be validated using Zod schemas. 
 * External APIs are unreliable and may change their response structure without notice. 
 * Validation ensures that type errors do not leak into the application logic 
 * and that we handle unexpected API behavior gracefully.
 */
import { z } from 'zod';
import type { LmParameters, ChatMessage, MultimodalContent } from '../models/types';
import { useGlobalEvents } from '../composables/useGlobalEvents';

const { addErrorEvent } = useGlobalEvents();

// --- OpenAI API Schemas ---

const OpenAIChatChunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      content: z.string().nullable().optional(),
    }),
  })),
});

const OpenAIModelsSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
  })),
});

// --- Ollama API Schemas ---

const OllamaChatChunkSchema = z.object({
  message: z.object({
    content: z.string().nullable().optional(),
    thinking: z.string().nullable().optional(),
  }).optional(),
  done: z.boolean().optional(),
});

const OllamaTagsSchema = z.object({
  models: z.array(z.object({
    name: z.string(),
  })),
});

const OllamaImageGenerationSchema = z.object({
  data: z.array(z.object({
    b64_json: z.string(),
  })),
});

export interface LLMProvider {
  chat(params: {
    messages: ChatMessage[];
    model: string;
    onChunk: (chunk: string) => void;
    parameters?: LmParameters;
    signal?: AbortSignal;
  }): Promise<void>;
  
  listModels(params: { signal?: AbortSignal }): Promise<string[]>;
}

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
    signal?: AbortSignal;
  }): Promise<void> {
    const { messages, model, onChunk, parameters, signal } = params;
    const { endpoint, headers } = this.config;
    const url = `${endpoint.replace(/\/$/, '')}/chat/completions`;
    const body: OpenAICompletionRequest = {
      model,
      messages,
      stream: true,
    };

    if (parameters) {
      if (parameters.temperature !== undefined) body.temperature = parameters.temperature;
      if (parameters.topP !== undefined) body.top_p = parameters.topP;
      if (parameters.maxCompletionTokens !== undefined) body.max_completion_tokens = parameters.maxCompletionTokens;
      if (parameters.presencePenalty !== undefined) body.presence_penalty = parameters.presencePenalty;
      if (parameters.frequencyPenalty !== undefined) body.frequency_penalty = parameters.frequencyPenalty;
      if (parameters.stop !== undefined) body.stop = parameters.stop;
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
      } catch (e) {
        // Fallback to status text
      }
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.trim() === '') continue;
        if (line.trim() === 'data: [DONE]') continue;
        if (!line.startsWith('data: ')) continue;

        try {
          const rawJson = JSON.parse(line.slice(6));
          // Validate with Zod
          const validated = OpenAIChatChunkSchema.parse(rawJson);
          const content = validated.choices[0]?.delta?.content || '';
          if (content) onChunk(content);
        } catch (e) {
          addErrorEvent({
            source: 'OpenAIProvider',
            message: 'Failed to parse or validate SSE line',
            details: { line, error: e instanceof Error ? e : String(e) },
          });
          console.warn('Failed to parse or validate SSE line', line, e);
        }
      }
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

interface OllamaMessage {
  role: string;
  content: string;
  images?: string[];
}

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  options?: Record<string, unknown>;
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
    signal?: AbortSignal;
  }): Promise<void> {
    const { messages, model, onChunk, parameters, signal } = params;
    const { endpoint, headers } = this.config;
    const url = `${endpoint.replace(/\/$/, '')}/api/chat`;

    // Transform messages to Ollama format
    const ollamaMessages: OllamaMessage[] = messages.map(m => {
      const contentType = typeof m.content;
      switch (contentType) {
      case 'string':
        return { role: m.role, content: m.content as string };
      case 'object': {
        // Multimodal
        let content = '';
        const images: string[] = [];
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
        return { role: m.role, content, images };
      }
      case 'undefined':
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
              isThinking = true;
            }
            onChunk(thinking);
          }

          const content = validated.message?.content || '';
          if (content) {
            if (isThinking) {
              onChunk('</think>');
              isThinking = false;
            }
            onChunk(content);
          }
          
          if (validated.done) {
            if (isThinking) {
              onChunk('</think>');
              isThinking = false;
            }
            return;
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

  async generateImage({ prompt, model, width, height, signal }: {
    prompt: string;
    model: string;
    width: number;
    height: number;
    signal: AbortSignal | undefined;
  }): Promise<Blob> {
    const { endpoint, headers } = this.config;
    // OpenAI compatible endpoint on Ollama: often at /v1/images/generations
    // We remove trailing slashes and /api if present to get the base
    const baseUrl = endpoint.replace(/\/$/, '').replace(/\/api$/, '');
    const url = `${baseUrl}/v1/images/generations`;

    const body = {
      model,
      prompt,
      size: `${width}x${height}`,
      response_format: 'b64_json',
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: [
          ['Content-Type', 'application/json'],
          ['Authorization', 'Bearer ollama'],
          ...(headers || []),
        ],
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      const isAbort = e instanceof Error && e.name === 'AbortError';
      if (!isAbort) {
        const message = `Network error or CORS issue: ${e instanceof Error ? e.message : String(e)}`;
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
        details = errorJson.error?.message || errorJson.error || JSON.stringify(errorJson);
      } catch (e) { /* ignore */ }
      const errorMsg = `Ollama Image Generation Error (${response.status}): ${details}`;
      addErrorEvent({
        source: 'OllamaProvider:generateImage',
        message: errorMsg,
        details: { status: response.status, statusText: response.statusText, url }
      });
      throw new Error(errorMsg);
    }

    const rawJson = await response.json();
    const validated = OllamaImageGenerationSchema.parse(rawJson);
    const first = validated.data[0];
    if (!first) {
      throw new Error('Invalid response format from Ollama: data[0] is missing');
    }
    const b64Data = first.b64_json;
    
    // Convert base64 to Blob using fetch
    const dataUrl = `data:image/png;base64,${b64Data}`;
    const blobResponse = await fetch(dataUrl, { signal });
    return await blobResponse.blob();
  }
}