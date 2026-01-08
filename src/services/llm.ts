import type { Message } from '../models/types';

export interface LLMProvider {
  chat(
    messages: Message[],
    model: string,
    endpoint: string,
    onChunk: (chunk: string) => void
  ): Promise<void>;
  
  listModels(endpoint: string): Promise<string[]>;
}

export class OpenAIProvider implements LLMProvider {
  async chat(
    messages: Message[],
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
          const json = JSON.parse(line.slice(6));
          const content = json.choices[0]?.delta?.content || '';
          if (content) onChunk(content);
        } catch (e) {
          console.warn('Failed to parse SSE line', line);
        }
      }
    }
  }

  async listModels(endpoint: string): Promise<string[]> {
    const url = `${endpoint.replace(/\/$/, '')}/models`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch models: ${response.statusText}`);
    const json = await response.json();
    return json.data.map((m: any) => m.id);
  }
}

export class OllamaProvider implements LLMProvider {
  async chat(
    messages: Message[],
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
      // Ollama streams actual JSON objects, not "data: " lines, but sometimes multiple JSONs per chunk
      // Or newline separated JSONs
      // Try to split by newline
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          const content = json.message?.content || '';
          if (content) onChunk(content);
          if (json.done) return;
        } catch (e) {
           // Not a full JSON yet? Wait for more data?
           // If split by newline failed to give valid JSON, it might be valid JSON with newlines inside?
           // Ollama NDJSON output is usually one JSON per line.
           console.warn('Failed to parse Ollama JSON', line);
        }
      }
    }
  }

  async listModels(endpoint: string): Promise<string[]> {
    const url = `${endpoint.replace(/\/$/, '')}/api/tags`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch models: ${response.statusText}`);
    const json = await response.json();
    return json.models.map((m: any) => m.name);
  }
}
