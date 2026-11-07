import type { HttpEndpoint } from './types';
import { installSecretEqualityTester } from '@/utils/secret.test-support';
import { Secret } from '@/utils/secret';
import { describe, expect, it } from 'vitest';

import {
  areEndpointModelNamespacesEqual,
  areEndpointsEqual,
  cloneEndpoint,
  isConfiguredEndpoint,
  isHttpEndpoint,
  isSupportedEndpoint,
} from '@/01-models/endpoint';

installSecretEqualityTester();

describe('endpoint helpers', () => {
  it('treats the browser-provided LM as a configured non-HTTP endpoint', () => {
    const endpoint = { type: 'browser_provided_lm' } as const;

    expect(isHttpEndpoint(endpoint)).toBe(false);
    expect(isSupportedEndpoint(endpoint)).toBe(true);
    expect(isConfiguredEndpoint({ endpoint })).toBe(true);
    const clone = cloneEndpoint({ endpoint });
    expect(clone).toEqual(endpoint);
    expect(clone).not.toBe(endpoint);
    expect(areEndpointsEqual({ left: endpoint, right: clone })).toBe(true);
  });

  it('keeps an unsupported experimental endpoint non-configured', () => {
    const endpoint = {
      type: 'unsupported_experimental_endpoint',
      persistedType: 'future_browser_ai',
    } as const;

    expect(isHttpEndpoint(endpoint)).toBe(false);
    expect(isSupportedEndpoint(endpoint)).toBe(false);
    expect(isConfiguredEndpoint({ endpoint })).toBe(false);
    const clone = cloneEndpoint({ endpoint });
    expect(clone).toEqual(endpoint);
    expect(clone).not.toBe(endpoint);
    expect(areEndpointsEqual({ left: endpoint, right: clone })).toBe(true);
  });

  it('compares model namespaces without treating auth headers as a model reset boundary', () => {
    expect(areEndpointModelNamespacesEqual({
      left: { type: 'openai', url: 'https://api.example/v1', httpHeaders: [['Authorization', Secret.from({ value: 'old' })]] },
      right: { type: 'openai', url: 'https://api.example/v1', httpHeaders: [['Authorization', Secret.from({ value: 'new' })]] },
    })).toBe(true);

    expect(areEndpointModelNamespacesEqual({
      left: { type: 'openai', url: 'https://api.example/v1' },
      right: { type: 'openai', url: 'https://other.example/v1' },
    })).toBe(false);

    expect(areEndpointModelNamespacesEqual({
      left: { type: 'browser_provided_lm' },
      right: { type: 'browser_provided_lm' },
    })).toBe(true);
  });

  it('compares credential values even when JSON observations are identical', () => {
    const endpoint: HttpEndpoint = { type: 'openai', url: 'https://api.example/v1', httpHeaders: [['X-Custom', Secret.from({ value: 'original' })]] };
    const same: HttpEndpoint = { ...endpoint, httpHeaders: [['X-Custom', Secret.from({ value: 'original' })]] };
    const changed: HttpEndpoint = { ...endpoint, httpHeaders: [['X-Custom', Secret.from({ value: 'changed' })]] };
    expect(JSON.stringify(endpoint)).toBe(JSON.stringify(changed));
    expect(areEndpointsEqual({ left: endpoint, right: same })).toBe(true);
    expect(areEndpointsEqual({ left: endpoint, right: changed })).toBe(false);
    expect(endpoint).toEqual(same);
    expect(endpoint).not.toEqual(changed);
    const clone = cloneEndpoint({ endpoint });
    expect(clone).not.toBe(endpoint);
    if (!isHttpEndpoint(clone)) {
      throw new Error('Expected HTTP clone');
    }
    expect(clone.httpHeaders).not.toBe(endpoint.httpHeaders);
    expect(clone.httpHeaders?.[0]).not.toBe(endpoint.httpHeaders?.[0]);
    expect(clone.httpHeaders?.[0]?.[1]).toBe(endpoint.httpHeaders?.[0]?.[1]);
    expect(endpoint.httpHeaders?.[0]?.[1].reveal()).toBe('original');
  });
});
