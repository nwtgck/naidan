import type { MessageNode } from '../models/types';

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
          const json = JSON.parse(line.slice(6));
          const content = json.choices[0]?.delta?.content || '';
          if (content) onChunk(content);
        } catch (_e) {
          console.warn('Failed to parse SSE line', line);
        }
      }
    }
  }

    async listModels(endpoint: string): Promise<string[]> {
      const url = `${endpoint.replace(/\/$/, '')}/models`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch models: ${response.statusText}`);
      const json = await response.json() as { data: { id: string }[] };
      return json.data.map((m) => m.id);
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
            const json = JSON.parse(line) as { message?: { content: string }, done?: boolean };
            const content = json.message?.content || '';
            if (content) onChunk(content);
            if (json.done) return;
          } catch (_e) {
             console.warn('Failed to parse Ollama JSON', line);
          }
        }
      }
    }
  
    async listModels(endpoint: string): Promise<string[]> {
      const url = `${endpoint.replace(/\/$/, '')}/api/tags`;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch models: ${response.statusText}`);
      const json = await response.json() as { models: { name: string }[] };
      return json.models.map((m) => m.name);
    }
  }
