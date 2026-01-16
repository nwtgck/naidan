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
import type { LmParameters, ChatMessage } from '../models/types';
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

export interface LLMProvider {
  chat(
    messages: ChatMessage[],
    model: string,
    endpoint: string,
    onChunk: (chunk: string) => void,
    parameters?: LmParameters,
    headers?: [string, string][],
    signal?: AbortSignal,
  ): Promise<void>;
  
  listModels(endpoint: string, headers?: [string, string][], signal?: AbortSignal): Promise<string[]>;
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
  async chat(
    messages: ChatMessage[],
    model: string,
    endpoint: string,
    onChunk: (chunk: string) => void,
    parameters?: LmParameters,
    headers?: [string, string][],
    signal?: AbortSignal,
  ): Promise<void> {
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

    const response = await fetch(url, {
      method: 'POST',
      headers: [
        ['Content-Type', 'application/json'],
        ...(headers || []),
      ],
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) throw new Error(`OpenAI API Error: ${response.statusText}`);
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

  async listModels(endpoint: string, headers?: [string, string][], signal?: AbortSignal): Promise<string[]> {
    const url = `${endpoint.replace(/\/$/, '')}/models`;
    const response = await fetch(url, { signal, headers });
    if (!response.ok) throw new Error(`Failed to fetch models: ${response.statusText}`);
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
  async chat(
    messages: ChatMessage[],
    model: string,
    endpoint: string,
    onChunk: (chunk: string) => void,
    parameters?: LmParameters,
    headers?: [string, string][],
    signal?: AbortSignal,
  ): Promise<void> {
    const url = `${endpoint.replace(/\/$/, '')}/api/chat`;

    // Transform messages to Ollama format
    const ollamaMessages: OllamaMessage[] = messages.map(m => {
      if (typeof m.content === 'string') {
        return { role: m.role, content: m.content };
      } else {
        // Multimodal
        let content = '';
        const images: string[] = [];
        for (const part of m.content) {
          if (part.type === 'text') {
            content += part.text;
          } else if (part.type === 'image_url') {
            // Strip data URL prefix if present: data:image/png;base64,xxxx
            const b64 = part.image_url.url.split(',')[1] || part.image_url.url;
            images.push(b64);
          }
        }
        return { role: m.role, content, images };
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

    const response = await fetch(url, {
      method: 'POST',
      headers: [
        ['Content-Type', 'application/json'],
        ...(headers || []),
      ],
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) throw new Error(`Ollama API Error: ${response.statusText}`);
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

  async listModels(endpoint: string, headers?: [string, string][], signal?: AbortSignal): Promise<string[]> {
    const url = `${endpoint.replace(/\/$/, '')}/api/tags`;
    const response = await fetch(url, { signal, headers });
    if (!response.ok) throw new Error(`Failed to fetch models: ${response.statusText}`);
    const rawJson = await response.json();
    // Validate with Zod
    const validated = OllamaTagsSchema.parse(rawJson);
    return validated.models.map((m) => m.name);
  }
}