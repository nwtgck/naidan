import { describe, expect, it } from 'vitest';

import {
  areEndpointsEqual,
  cloneEndpoint,
  isConfiguredEndpoint,
  isHttpEndpoint,
  isSupportedEndpoint,
} from '@/01-models/endpoint';

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
});
