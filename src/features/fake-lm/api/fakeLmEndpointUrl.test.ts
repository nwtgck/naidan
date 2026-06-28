import { describe, expect, it } from 'vitest';
import { isFakeLmEndpointUrl } from '@/features/fake-lm/api/fakeLmEndpointUrl';

describe('isFakeLmEndpointUrl', () => {
  it('accepts fake LM http and https endpoints', () => {
    expect(isFakeLmEndpointUrl({ endpointUrl: 'https://fake-lm.invalid' })).toBe(true);
    expect(isFakeLmEndpointUrl({ endpointUrl: 'https://fake-lm.invalid/v1' })).toBe(true);
    expect(isFakeLmEndpointUrl({ endpointUrl: 'http://fake-lm.invalid' })).toBe(true);
  });

  it('rejects other URLs and invalid input', () => {
    expect(isFakeLmEndpointUrl({ endpointUrl: 'https://example.com' })).toBe(false);
    expect(isFakeLmEndpointUrl({ endpointUrl: 'not a url' })).toBe(false);
    expect(isFakeLmEndpointUrl({ endpointUrl: undefined })).toBe(false);
  });
});
