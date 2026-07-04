import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockCreateFakeLmFetchForEndpoint,
  mockFetchModuleLoaded,
  mockPreloadFakeLmLanguagePacks,
} = vi.hoisted(() => ({
  mockCreateFakeLmFetchForEndpoint: vi.fn(),
  mockFetchModuleLoaded: vi.fn(),
  mockPreloadFakeLmLanguagePacks: vi.fn(),
}));

vi.mock('@/features/fake-lm/hosted/fakeLmFetchForEndpoint', () => {
  mockFetchModuleLoaded();
  return {
    createFakeLmFetchForEndpoint: mockCreateFakeLmFetchForEndpoint,
  };
});

vi.mock('@/features/fake-lm/core/lexiconLoader', () => ({
  preloadFakeLmLanguagePacks: mockPreloadFakeLmLanguagePacks,
}));

import {
  createFakeLmFetchForEndpoint,
  FAKE_LM_ENDPOINT_URL,
  preloadFakeLmRuntime,
} from '@/features/fake-lm';

describe('Fake LM hosted facade', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preloads both the fetch runtime and language packs', async () => {
    await preloadFakeLmRuntime();

    expect(mockFetchModuleLoaded).toHaveBeenCalledOnce();
    expect(mockPreloadFakeLmLanguagePacks).toHaveBeenCalledOnce();
  });

  it('delegates fetch creation to the lazily loaded hosted runtime', async () => {
    const expectedFetch = vi.fn();
    mockCreateFakeLmFetchForEndpoint.mockReturnValue(expectedFetch);

    const result = await createFakeLmFetchForEndpoint({
      endpointUrl: FAKE_LM_ENDPOINT_URL,
      fakeLmDebugModeStatus: 'enabled',
    });

    expect(result).toBe(expectedFetch);
    expect(mockCreateFakeLmFetchForEndpoint).toHaveBeenCalledWith({
      endpointUrl: FAKE_LM_ENDPOINT_URL,
      fakeLmDebugModeStatus: 'enabled',
    });
  });
});
