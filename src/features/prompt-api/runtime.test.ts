import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  preparePromptApi,
  promptApiRuntimeState,
  refreshPromptApiAvailability,
  TEST_ONLY,
} from './runtime';

beforeEach(() => {
  TEST_ONLY.reset();
});

afterEach(() => {
  TEST_ONLY.reset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Prompt API runtime', () => {
  it('reports a missing LanguageModel API without hiding the feature', async () => {
    vi.stubGlobal('LanguageModel', undefined);

    await refreshPromptApiAvailability({ showCheckingState: 'yes' });

    expect(promptApiRuntimeState.value).toEqual({ status: 'api_unavailable' });
  });

  it('accepts the constructor-shaped LanguageModel global exposed by browsers', async () => {
    const languageModel = Object.assign(function LanguageModel() {}, {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn(),
    });
    vi.stubGlobal('LanguageModel', languageModel);

    await refreshPromptApiAvailability({ showCheckingState: 'yes' });

    expect(promptApiRuntimeState.value).toEqual({ status: 'ready' });
  });

  it.each([
    ['available', { status: 'ready' }],
    ['downloadable', { status: 'downloadable' }],
    ['downloading', { status: 'downloading', progress: undefined }],
    ['unavailable', { status: 'model_unavailable' }],
  ] as const)('maps %s availability to runtime state', async (availability, state) => {
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue(availability),
      create: vi.fn(),
    });

    await refreshPromptApiAvailability({ showCheckingState: 'yes' });

    expect(promptApiRuntimeState.value).toEqual(state);
  });

  it('shows download progress, then preparation, and destroys the preparation session', async () => {
    let downloadProgressListener: ((event: ProgressEvent) => void) | undefined;
    let resolveSession: ((session: unknown) => void) | undefined;
    const destroy = vi.fn();
    const createPromise = new Promise<unknown>(resolve => {
      resolveSession = resolve;
    });
    const create = vi.fn((options: {
      monitor?: (value: {
        addEventListener: (
          type: 'downloadprogress',
          listener: (event: ProgressEvent) => void,
        ) => void,
      }) => void,
    }) => {
      options.monitor?.({
        addEventListener: (_type, listener) => {
          downloadProgressListener = listener;
        },
      });
      return createPromise;
    });
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('downloadable'),
      create,
    });

    const preparation = preparePromptApi({ signal: undefined });
    expect(create).toHaveBeenCalledTimes(1);

    downloadProgressListener?.({ loaded: 0.4 } as ProgressEvent);
    expect(promptApiRuntimeState.value).toEqual({ status: 'downloading', progress: 0.4 });

    downloadProgressListener?.({ loaded: 1 } as ProgressEvent);
    expect(promptApiRuntimeState.value).toEqual({ status: 'preparing' });

    resolveSession?.({
      promptStreaming: vi.fn(),
      destroy,
    });
    await preparation;

    expect(promptApiRuntimeState.value).toEqual({ status: 'ready' });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent preparation requests', async () => {
    let resolveSession: ((session: unknown) => void) | undefined;
    const create = vi.fn(() => new Promise<unknown>(resolve => {
      resolveSession = resolve;
    }));
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('downloadable'),
      create,
    });

    const first = preparePromptApi({ signal: undefined });
    const second = preparePromptApi({ signal: undefined });
    expect(create).toHaveBeenCalledTimes(1);

    resolveSession?.({
      promptStreaming: vi.fn(),
      destroy: vi.fn(),
    });
    await Promise.all([first, second]);
  });
});
