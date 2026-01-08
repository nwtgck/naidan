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
import type { MessageNode } from '../models/types';

// --- OpenAI API Schemas ---

const OpenAIChatChunkSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({
      content: z.string().optional(),
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
    content: z.string(),
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
    messages: MessageNode[],
    model: string,
    endpoint: string,
    onChunk: (chunk: string) => void
  ): Promise<void>;
  
  listModels(endpoint: string): Promise<string[]>;
}

export class OpenAIProvider implements LLMProvider {
  async chat(
    messages: MessageNode[],
    model: string,
    endpoint: string,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const url = `${endpoint.replace(/\/$/, '')}/chat/completions`;
    const body = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
        } catch (_e) {
          console.warn('Failed to parse or validate SSE line', line, _e);
        }
      }
    }
  }

  async listModels(endpoint: string): Promise<string[]> {
    const url = `${endpoint.replace(/\/$/, '')}/models`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch models: ${response.statusText}`);
    const rawJson = await response.json();
    // Validate with Zod
    const validated = OpenAIModelsSchema.parse(rawJson);
    return validated.data.map((m) => m.id);
  }
}

export class OllamaProvider implements LLMProvider {
  async chat(
    messages: MessageNode[],
    model: string,
    endpoint: string,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const url = `${endpoint.replace(/\/$/, '')}/api/chat`;
    const body = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) throw new Error(`Ollama API Error: ${response.statusText}`);
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
        if (!line.trim()) continue;
        try {
          const rawJson = JSON.parse(line);
          // Validate with Zod
          const validated = OllamaChatChunkSchema.parse(rawJson);
          const content = validated.message?.content || '';
          if (content) onChunk(content);
          if (validated.done) return;
        } catch (_e) {
           console.warn('Failed to parse or validate Ollama JSON', line, _e);
        }
      }
    }
  }

  async listModels(endpoint: string): Promise<string[]> {
    const url = `${endpoint.replace(/\/$/, '')}/api/tags`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch models: ${response.statusText}`);
    const rawJson = await response.json();
    // Validate with Zod
    const validated = OllamaTagsSchema.parse(rawJson);
    return validated.models.map((m) => m.name);
  }
}