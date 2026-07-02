import { describe, expect, it } from 'vitest';
import { fakeLmFetch } from '@/features/fake-lm/api/fakeLmFetch';
import { createLmFetch } from '@/features/lm/fetchFactory';
import { createOllamaProvider } from '@/features/lm/ollamaProviderFactory';

describe('createLmFetch', () => {
  it('uses fake LM only when debug mode is enabled for the fake endpoint', async () => {
    expect(createLmFetch({
      endpointUrl: 'https://fake-lm.invalid',
      fakeLmDebugModeStatus: 'disabled',
    })).not.toBe(fakeLmFetch);

    const fakeFetch = createLmFetch({
      endpointUrl: 'https://fake-lm.invalid',
      fakeLmDebugModeStatus: 'enabled',
    });
    expect(fakeFetch).not.toBe(fakeLmFetch);
    const response = await fakeFetch('https://fake-lm.invalid/v1/models');
    expect(response.ok).toBe(true);

    const normalFetch = createLmFetch({
      endpointUrl: 'https://example.com',
      fakeLmDebugModeStatus: 'enabled',
    });
    expect(normalFetch).not.toBe(fakeFetch);
  });
});

describe('createOllamaProvider', () => {
  it('creates an Ollama management client using the fake LM fetch path', async () => {
    const provider = createOllamaProvider({
      endpointUrl: 'https://fake-lm.invalid',
      endpointHttpHeaders: [['X-Test', 'value']],
      fakeLmDebugModeStatus: 'enabled',
    });

    await expect(provider.listRunningModels({ signal: undefined })).resolves.toEqual([]);
  });
});
