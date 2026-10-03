import { describe, expect, it } from 'vitest';
import type { Endpoint } from '@/01-models/types';
import { cloneImagePromptTranslationOverride, imagePromptTranslationEndpointLabel, resolveImagePromptTranslation } from './settings';
const global = { endpoint: { type: 'ollama', url: 'http://localhost:11434', httpHeaders: undefined } satisfies Endpoint, modelId: 'global-model' };
describe('image prompt translation inheritance', () => {
  it('defaults both fields to global and resolves session over workspace independently', () => {
    expect(resolveImagePromptTranslation({ session: undefined, workspace: undefined, global })).toEqual({ ...global, endpointSource: 'global', modelSource: 'global' });
    const endpoint: Endpoint = { type: 'openai', url: 'https://example.test', httpHeaders: [['Authorization', 'secret']] };
    expect(resolveImagePromptTranslation({ session: { endpoint, modelId: undefined }, workspace: { endpoint: { type: 'llama_cpp_browser' }, modelId: 'workspace-model' }, global }))
      .toEqual({ endpoint, modelId: 'workspace-model', endpointSource: 'session', modelSource: 'workspace' });
    expect(resolveImagePromptTranslation({ session: { endpoint: undefined, modelId: 'session-model' }, workspace: { endpoint, modelId: 'workspace-model' }, global }))
      .toEqual({ endpoint, modelId: 'session-model', endpointSource: 'workspace', modelSource: 'session' });
  });
  it('does not silently fall back for an explicit but unconfigured destination', () => {
    const target = resolveImagePromptTranslation({ session: { endpoint: { type: 'openai', url: '', httpHeaders: undefined }, modelId: '' }, workspace: undefined, global });
    expect(target.modelId).toBe(''); expect(target.endpoint.type).toBe('openai');
    expect(target.endpointSource).toBe('session'); expect(target.modelSource).toBe('session');
  });
  it('clones all headers rather than mutating inherited profiles or borrowing authentication across endpoints', () => {
    const endpoint: Endpoint = { type: 'openai', url: 'https://example.test', httpHeaders: [['Authorization', 'old']] };
    const override = { endpoint, modelId: 'chosen' };
    const value = cloneImagePromptTranslationOverride({ value: override });
    if (value?.endpoint?.type !== 'openai') throw new Error('Expected HTTP endpoint.');
    value.endpoint.httpHeaders![0]![1] = 'new';
    expect(endpoint.httpHeaders![0]![1]).toBe('old');
    const target = resolveImagePromptTranslation({ session: { endpoint: { type: 'openai', url: 'https://other.test', httpHeaders: undefined }, modelId: undefined }, workspace: override, global });
    expect(target.endpoint).toEqual({ type: 'openai', url: 'https://other.test', httpHeaders: undefined });
  });
  it('does not display URL credentials, query tokens, paths or HTTP headers', () => {
    const label = imagePromptTranslationEndpointLabel({ endpoint: { type: 'openai', url: 'https://user:password@example.test/private?key=secret', httpHeaders: [['Authorization', 'token']] } });
    expect(label).toBe('openai · example.test');
  });
});
