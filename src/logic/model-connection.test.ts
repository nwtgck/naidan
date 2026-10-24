import { describe, expect, it } from 'vitest';
import { isLoopbackModelConnectionUrl, modelConnectionApiKey, modelConnectionHttpEndpoint, normalizeModelConnectionUrl, withModelConnectionApiKey } from './model-connection';

describe('model connection drafts', () => {
  it.each([
    [' localhost:11434 ', 'http://localhost:11434'],
    ['https://example.invalid/v1/', 'https://example.invalid/v1'],
    ['http://[::1]:8080/v1', 'http://[::1]:8080/v1'],
    ['', undefined],
    ['http://', undefined],
    ['file:///model', undefined],
    ['javascript://example.invalid', undefined],
  ])('normalizes an API URL without using it: %s', (input, expected) => {
    expect(normalizeModelConnectionUrl({ input })).toBe(expected);
  });

  it.each([
    ['localhost:11434', true],
    ['http://127.0.0.1:1234/v1', true],
    ['http://[::1]:8080', true],
    ['https://localhost/v1', true],
    ['https://localhost.example.invalid/v1', false],
    ['https://example.invalid/?localhost', false],
    ['http://localhost@example.invalid', false],
    ['https://example.invalid/127.0.0.1', false],
    ['file://localhost/model', false],
    ['http://', false],
  ])('authorizes automatic discovery by parsed host only: %s', (url, expected) => {
    expect(isLoopbackModelConnectionUrl({ url })).toBe(expected);
  });

  it('uses one immutable header draft for case-insensitive API-key editing', () => {
    const source: [string, string][] = [['X-Tenant', 'tenant'], ['authorization', 'bearer old'], ['Authorization', 'Bearer duplicate']];
    expect(modelConnectionApiKey({ headers: source })).toBe('old');
    const changed = withModelConnectionApiKey({ headers: source, apiKey: ' next ' });
    expect(changed).toEqual([['X-Tenant', 'tenant'], ['Authorization', 'Bearer next']]);
    expect(source).toEqual([['X-Tenant', 'tenant'], ['authorization', 'bearer old'], ['Authorization', 'Bearer duplicate']]);
    expect(withModelConnectionApiKey({ headers: changed, apiKey: '' })).toEqual([['X-Tenant', 'tenant']]);
  });

  it('preserves a custom authorization scheme until the API-key control explicitly replaces it', () => {
    const headers: [string, string][] = [['Authorization', 'Basic custom'], ['X-Key', 'other']];
    expect(modelConnectionApiKey({ headers })).toBe('');
    expect(withModelConnectionApiKey({ headers, apiKey: '' })).toEqual(headers);
    expect(withModelConnectionApiKey({ headers, apiKey: 'new-token' })).toEqual([['X-Key', 'other'], ['Authorization', 'Bearer new-token']]);
  });

  it('creates an HTTP endpoint without adding an API-key persistence field', () => {
    const headers: [string, string][] = [['', 'draft'], [' X-Key ', 'secret']];
    const endpoint = modelConnectionHttpEndpoint({ type: 'openai', url: 'localhost:1234/v1/', headers });
    expect(endpoint).toEqual({ type: 'openai', url: 'http://localhost:1234/v1', httpHeaders: [['X-Key', 'secret']] });
    expect(headers).toEqual([['', 'draft'], [' X-Key ', 'secret']]);
    expect(modelConnectionHttpEndpoint({ type: 'ollama', url: 'localhost:11434', headers: [] })).toEqual({ type: 'ollama', url: 'http://localhost:11434', httpHeaders: undefined });
    expect(modelConnectionHttpEndpoint({ type: 'openai', url: '', headers })).toBeUndefined();
  });
});
