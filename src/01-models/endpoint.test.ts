import { describe, expect, it } from 'vitest';

import {
  areEndpointsEqual,
  cloneEndpoint,
  isConfiguredEndpoint,
  isHttpEndpoint,
  isSupportedEndpoint,
} from '@/01-models/endpoint';

describe('endpoint helpers', () => {
  it('treats Prompt API as a configured non-HTTP endpoint', () => {
    const endpoint = { type: 'prompt_api' } as const;

    expect(isHttpEndpoint(endpoint)).toBe(false);
    expect(isSupportedEndpoint(endpoint)).toBe(true);
    expect(isConfiguredEndpoint({ endpoint })).toBe(true);
    expect(cloneEndpoint({ endpoint })).toEqual(endpoint);
    expect(areEndpointsEqual({ left: endpoint, right: endpoint })).toBe(true);
  });

  it('keeps an unsupported experimental endpoint non-configured', () => {
    const endpoint = {
      type: 'unsupported_experimental_endpoint',
      persistedType: 'future_browser_ai',
      persistedExperimental: {
        type: 'future_browser_ai',
        mode: 'future',
      },
    } as const;

    expect(isHttpEndpoint(endpoint)).toBe(false);
    expect(isSupportedEndpoint(endpoint)).toBe(false);
    expect(isConfiguredEndpoint({ endpoint })).toBe(false);
    expect(cloneEndpoint({ endpoint })).toEqual(endpoint);
    expect(cloneEndpoint({ endpoint })).not.toBe(endpoint);
  });
});
