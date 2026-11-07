import { installSecretEqualityTester } from '@/utils/secret.test-support';
import { Secret } from '@/utils/secret';
import { toNaidanRpcRegistrationId } from '@/01-models/ids';
import { describe, expect, it } from 'vitest';
import { ensureAllStringsForTest } from '@/strings/utils.test-support';
import type { Endpoint } from '@/01-models/types';
import { areImagePromptTranslationOverridesEqual, cloneImagePromptTranslationOverride, imagePromptTranslationEndpointLabel, resolveImagePromptTranslation } from './settings';
installSecretEqualityTester();
const global = { endpoint: { type: 'ollama', url: 'http://localhost:11434', httpHeaders: undefined } satisfies Endpoint, modelId: 'global-model', lmParameters: undefined };

describe('image prompt translation inheritance', () => {
  it('defaults both fields to global and resolves session over workspace independently', () => {
    expect(resolveImagePromptTranslation({ session: undefined, workspace: undefined, global })).toEqual({ ...global, endpointSource: 'global', modelSource: 'global' });
    const endpoint: Endpoint = { type: 'openai', url: 'https://example.test', httpHeaders: [['Authorization', Secret.from({ value: 'secret' })]] };
    expect(resolveImagePromptTranslation({ session: { endpoint, modelId: undefined, lmParameters: undefined }, workspace: { endpoint: { type: 'llama_cpp_browser' }, modelId: 'workspace-model', lmParameters: undefined }, global }))
      .toEqual({ endpoint, modelId: 'workspace-model', endpointSource: 'session', modelSource: 'workspace' });
    expect(resolveImagePromptTranslation({ session: { endpoint: undefined, modelId: 'session-model', lmParameters: undefined }, workspace: { endpoint, modelId: 'workspace-model', lmParameters: undefined }, global }))
      .toEqual({ endpoint, modelId: 'session-model', endpointSource: 'workspace', modelSource: 'session' });
  });

  it('does not silently fall back for an explicit but unconfigured destination', () => {
    const target = resolveImagePromptTranslation({ session: { endpoint: { type: 'openai', url: '', httpHeaders: undefined }, modelId: '', lmParameters: undefined }, workspace: undefined, global });
    expect(target.modelId).toBe('');
    expect(target.endpoint.type).toBe('openai');
    expect(target.endpointSource).toBe('session');
    expect(target.modelSource).toBe('session');
  });

  it('clones all headers rather than mutating inherited profiles or borrowing authentication across endpoints', () => {
    const endpoint: Endpoint = { type: 'openai', url: 'https://example.test', httpHeaders: [['Authorization', Secret.from({ value: 'old' })]] };
    const override = { endpoint, modelId: 'chosen', lmParameters: undefined };
    const value = cloneImagePromptTranslationOverride({ value: override });
    if (value?.endpoint?.type !== 'openai') {
      throw new Error('Expected HTTP endpoint.');
    }
    value.endpoint.httpHeaders![0]![1] = Secret.from({ value: 'new' });
    expect(endpoint.httpHeaders![0]![1].reveal()).toBe('old');
    const target = resolveImagePromptTranslation({ session: { endpoint: { type: 'openai', url: 'https://other.test', httpHeaders: undefined }, modelId: undefined, lmParameters: undefined }, workspace: override, global });
    expect(target.endpoint).toEqual({ type: 'openai', url: 'https://other.test', httpHeaders: undefined });
  });

  it('does not display URL credentials, query tokens, paths or HTTP headers', () => {
    const label = imagePromptTranslationEndpointLabel({ endpoint: { type: 'openai', url: 'https://user:password@example.test/private?key=secret', httpHeaders: [['Authorization', Secret.from({ value: 'token' })]] } });
    expect(label).toBe('openai · example.test');
  });
});

it('merges LM fields independently through all three layers without turning inherit into a reset', () => {
  const target = resolveImagePromptTranslation({
    global: { ...global, lmParameters: { temperature: 0.8, topP: 0.7, maxCompletionTokens: 500, presencePenalty: undefined, frequencyPenalty: undefined, stop: ['end'], reasoning: { effort: 'high' } } },
    workspace: { endpoint: undefined, modelId: undefined, lmParameters: { temperature: 0.2, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } } },
    session: { endpoint: undefined, modelId: undefined, lmParameters: { temperature: 0, topP: undefined, maxCompletionTokens: undefined, presencePenalty: undefined, frequencyPenalty: undefined, stop: [], reasoning: { effort: 'none' } } },
  });
  expect(target.lmParameters).toMatchObject({ temperature: 0, topP: 0.7, maxCompletionTokens: 500, stop: [], reasoning: { effort: 'none' } });
});

it('clones an unavailable session RPC value without inheriting another peer', () => {
  const endpoint: Endpoint = { type: 'unsupported_experimental_endpoint', persistedType: 'naidan_rpc' };
  const session = { endpoint, modelId: 'explicit-model', lmParameters: undefined };
  const workspace = { endpoint: { type: 'naidan_rpc' as const, registrationId: toNaidanRpcRegistrationId({ raw: 'peer-B' }) }, modelId: 'other-model', lmParameters: undefined };
  const cloned = cloneImagePromptTranslationOverride({ value: session });
  const target = resolveImagePromptTranslation({ session: cloned, workspace, global });
  expect(target.endpointSource).toBe('session');
  expect(target.modelId).toBe('explicit-model');
  if (target.endpoint.type !== 'unsupported_experimental_endpoint') {
    throw new Error('Unavailable endpoint was replaced');
  }
  expect(target.endpoint.persistedType).toBe('naidan_rpc');
  expect(target.endpoint).not.toBe(endpoint);
});

it('uses the localized in-browser llama.cpp name in translation summaries', async () => {
  await ensureAllStringsForTest({ locale: 'en' });
  expect(imagePromptTranslationEndpointLabel({ endpoint: { type: 'llama_cpp_browser' } })).toBe('llama.cpp in the browser');
});

it('detects a credential-only change rather than comparing masked JSON', () => {
  const left = { endpoint: { type: 'openai' as const, url: 'https://example.invalid', httpHeaders: [['X-Custom', Secret.from({ value: 'before' })]] as [name: string, value: Secret<string>][] }, modelId: 'model', lmParameters: undefined };
  const right = { ...left, endpoint: { ...left.endpoint, httpHeaders: [['X-Custom', Secret.from({ value: 'after' })]] as [name: string, value: Secret<string>][] } };
  expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  expect(areImagePromptTranslationOverridesEqual({ left, right })).toBe(false);
  expect(areImagePromptTranslationOverridesEqual({ left, right: cloneImagePromptTranslationOverride({ value: left }) })).toBe(true);
});
