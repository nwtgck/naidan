import { describe, expect, it } from 'vitest';
import { fakeLmFetch } from '@/services/fake-lm/api/fakeLmFetch';

describe('fakeLmFetch', () => {
  it('returns OpenAI-compatible models', async () => {
    const response = await fakeLmFetch('https://fake-lm.invalid/v1/models');

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({
      data: [
        { id: 'fake-lm-ja' },
        { id: 'fake-lm-en' },
        { id: 'fake-lm-random' },
      ],
    });
  });

  it('returns Ollama-compatible tags', async () => {
    const response = await fakeLmFetch('https://fake-lm.invalid/api/tags');

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({
      models: [
        { name: 'fake-lm:ja' },
        { name: 'fake-lm:en' },
        { name: 'fake-lm:random' },
      ],
    });
  });

  it('streams OpenAI-compatible chat chunks', async () => {
    const response = await fakeLmFetch('https://fake-lm.invalid/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'fake-lm-ja',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    expect(response.ok).toBe(true);
    expect(await response.text()).toContain('data: [DONE]');
  });

  it('streams Ollama-compatible chat chunks', async () => {
    const response = await fakeLmFetch('https://fake-lm.invalid/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: 'fake-lm:en',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
      }),
    });

    expect(response.ok).toBe(true);
    expect(await response.text()).toContain('"done":true');
  });

  it('streams OpenAI-compatible thinking chunks when requested', async () => {
    const response = await fakeLmFetch('https://fake-lm.invalid/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: 'fake-lm-ja',
        messages: [{ role: 'user', content: 'hello' }],
        thinking: 'low',
        stream: true,
      }),
    });

    expect(response.ok).toBe(true);
    const text = await response.text();
    expect(text).toContain('reasoning_content');
    expect(text).toContain('content');
    expect(text).toContain('data: [DONE]');
  });

  it('streams Ollama-compatible thinking chunks when requested', async () => {
    const response = await fakeLmFetch('https://fake-lm.invalid/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: 'fake-lm:ja',
        messages: [{ role: 'user', content: 'hello' }],
        think: 'low',
        stream: true,
      }),
    });

    expect(response.ok).toBe(true);
    const text = await response.text();
    expect(text).toContain('"thinking"');
    expect(text).toContain('"content"');
    expect(text).toContain('"done":true');
  });


  it('supports native Request inputs with request body and lowercase method override', async () => {
    const request = new Request('https://fake-lm.invalid/v1/chat/completions', {
      method: 'post',
      body: JSON.stringify({
        model: 'fake-lm-ja',
        messages: [{ role: 'user', content: 'こんにちは' }],
        stream: true,
      }),
    });

    const response = await fakeLmFetch(request);

    expect(response.ok).toBe(true);
    expect(await response.text()).toContain('data: [DONE]');
  });

});
