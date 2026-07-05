import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acquirePromptApiGenerationSession,
  preparePromptApi,
  promptApiRuntimeState,
  refreshPromptApiAvailability,
  TEST_ONLY,
} from './runtime';

function createSessionMock() {
  const destroy = vi.fn();
  return {
    destroy,
    session: {
      promptStreaming: vi.fn(),
      destroy,
    },
  };
}

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
  ] as const)('maps %s availability to runtime state without creating a session', async (
    availability,
    state,
  ) => {
    const create = vi.fn();
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue(availability),
      create,
    });

    await refreshPromptApiAvailability({ showCheckingState: 'yes' });

    expect(promptApiRuntimeState.value).toEqual(state);
    expect(create).not.toHaveBeenCalled();
    expect(TEST_ONLY.getSessionState().hasWarmKeeper).toBe(false);
  });

  it('keeps the raw availability error and records its phase', async () => {
    const rawError = new DOMException('availability failed', 'NotSupportedError');
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockRejectedValue(rawError),
      create: vi.fn(),
    });

    await refreshPromptApiAvailability({ showCheckingState: 'yes' });

    expect(promptApiRuntimeState.value).toMatchObject({
      status: 'error',
      phase: 'availability',
      error: {
        code: 'unsupported_input',
        cause: rawError,
      },
    });
  });

  it('keeps the raw preparation error and records its phase', async () => {
    const rawError = new Error('model download failed');
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('downloadable'),
      create: vi.fn().mockRejectedValue(rawError),
    });

    await expect(preparePromptApi({ signal: undefined })).rejects.toMatchObject({
      code: 'operation_failed',
      cause: rawError,
    });

    expect(promptApiRuntimeState.value).toMatchObject({
      status: 'error',
      phase: 'preparation',
      error: {
        code: 'operation_failed',
        cause: rawError,
      },
    });
  });

  it('keeps the preparation session alive as the warm keeper', async () => {
    let downloadProgressListener: ((event: ProgressEvent) => void) | undefined;
    let resolveSession: ((session: unknown) => void) | undefined;
    const keeper = createSessionMock();
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

    resolveSession?.(keeper.session);
    await preparation;

    expect(promptApiRuntimeState.value).toEqual({ status: 'ready' });
    expect(keeper.destroy).not.toHaveBeenCalled();
    expect(TEST_ONLY.getSessionState()).toMatchObject({
      hasActivatedPromptApi: true,
      hasWarmKeeper: true,
    });
  });

  it('does not let a stale availability result overwrite active preparation', async () => {
    let resolveAvailability!: (availability: string) => void;
    let resolveSession!: (session: unknown) => void;
    const availability = vi.fn(() => new Promise<string>(resolve => {
      resolveAvailability = resolve;
    }));
    const create = vi.fn(() => new Promise<unknown>(resolve => {
      resolveSession = resolve;
    }));
    vi.stubGlobal('LanguageModel', {
      availability,
      create,
    });

    const refresh = refreshPromptApiAvailability({ showCheckingState: 'yes' });
    await Promise.resolve();
    expect(promptApiRuntimeState.value).toEqual({ status: 'checking' });

    const preparation = preparePromptApi({ signal: undefined });
    expect(promptApiRuntimeState.value).toEqual({ status: 'preparing' });

    resolveAvailability('downloadable');
    await refresh;
    expect(promptApiRuntimeState.value).toEqual({ status: 'preparing' });

    resolveSession(createSessionMock().session);
    await preparation;
    expect(promptApiRuntimeState.value).toEqual({ status: 'ready' });
  });

  it('ignores availability refresh requests while preparation is active', async () => {
    let resolveSession!: (session: unknown) => void;
    const availability = vi.fn().mockResolvedValue('downloadable');
    vi.stubGlobal('LanguageModel', {
      availability,
      create: vi.fn(() => new Promise<unknown>(resolve => {
        resolveSession = resolve;
      })),
    });

    const preparation = preparePromptApi({ signal: undefined });
    await refreshPromptApiAvailability({ showCheckingState: 'yes' });

    expect(availability).not.toHaveBeenCalled();
    expect(promptApiRuntimeState.value).toEqual({ status: 'preparing' });

    resolveSession(createSessionMock().session);
    await preparation;
  });

  it('reuses the existing warm keeper on repeated preparation', async () => {
    const keeper = createSessionMock();
    const create = vi.fn().mockResolvedValue(keeper.session);
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('available'),
      create,
    });

    await preparePromptApi({ signal: undefined });
    await preparePromptApi({ signal: undefined });

    expect(create).toHaveBeenCalledTimes(1);
    expect(keeper.destroy).not.toHaveBeenCalled();
    expect(TEST_ONLY.getSessionState().hasWarmKeeper).toBe(true);
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

    resolveSession?.(createSessionMock().session);
    await Promise.all([first, second]);
  });

  it('hands the live model from the warm keeper to a generation session', async () => {
    vi.useFakeTimers();
    const keeper = createSessionMock();
    const generation = createSessionMock();
    const replacementKeeper = createSessionMock();
    const create = vi.fn()
      .mockResolvedValueOnce(keeper.session)
      .mockResolvedValueOnce(generation.session)
      .mockResolvedValueOnce(replacementKeeper.session);
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('available'),
      create,
    });

    await preparePromptApi({ signal: undefined });
    const lease = await acquirePromptApiGenerationSession({
      initialPrompts: [],
      signal: undefined,
      inputMode: 'text',
    });

    expect(keeper.destroy).toHaveBeenCalledTimes(1);
    expect(generation.destroy).not.toHaveBeenCalled();
    expect(TEST_ONLY.getSessionState()).toMatchObject({
      activeGenerationSessionCount: 1,
      hasWarmKeeper: false,
    });

    lease.release();
    expect(generation.destroy).toHaveBeenCalledTimes(1);
    expect(TEST_ONLY.getSessionState().hasWarmKeeperRecreationTimer).toBe(true);

    await vi.advanceTimersByTimeAsync(TEST_ONLY.WARM_KEEPER_RECREATE_DELAY_MS);

    expect(create).toHaveBeenCalledTimes(3);
    expect(replacementKeeper.destroy).not.toHaveBeenCalled();
    expect(TEST_ONLY.getSessionState()).toMatchObject({
      activeGenerationSessionCount: 0,
      hasWarmKeeper: true,
    });
  });

  it('keeps text runtime ready when image input is unavailable', async () => {
    const keeper = createSessionMock();
    const availability = vi.fn(async (options: {
      expectedInputs?: Array<{ type: string }>,
    }) => options.expectedInputs?.some(input => input.type === 'image')
      ? 'unavailable'
      : 'available');
    const create = vi.fn().mockResolvedValue(keeper.session);
    vi.stubGlobal('LanguageModel', { availability, create });

    await preparePromptApi({ signal: undefined });

    await expect(acquirePromptApiGenerationSession({
      initialPrompts: [],
      signal: undefined,
      inputMode: 'image',
    })).rejects.toMatchObject({ code: 'unsupported_input' });

    expect(availability).toHaveBeenLastCalledWith({
      expectedInputs: [{ type: 'image' }],
      expectedOutputs: [{ type: 'text' }],
    });
    expect(promptApiRuntimeState.value).toEqual({ status: 'ready' });
    expect(keeper.destroy).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(1);
    expect(TEST_ONLY.getSessionState().hasWarmKeeper).toBe(true);
  });

  it('keeps the warm keeper when generation session creation fails', async () => {
    const keeper = createSessionMock();
    const create = vi.fn()
      .mockResolvedValueOnce(keeper.session)
      .mockRejectedValueOnce(new Error('generation create failed'));
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('available'),
      create,
    });

    await preparePromptApi({ signal: undefined });

    await expect(acquirePromptApiGenerationSession({
      initialPrompts: [],
      signal: undefined,
      inputMode: 'text',
    })).rejects.toThrow('generation create failed');

    expect(keeper.destroy).not.toHaveBeenCalled();
    expect(TEST_ONLY.getSessionState().hasWarmKeeper).toBe(true);
  });

  it('cancels scheduled keeper recreation when another generation starts', async () => {
    vi.useFakeTimers();
    const keeper = createSessionMock();
    const firstGeneration = createSessionMock();
    const secondGeneration = createSessionMock();
    const create = vi.fn()
      .mockResolvedValueOnce(keeper.session)
      .mockResolvedValueOnce(firstGeneration.session)
      .mockResolvedValueOnce(secondGeneration.session);
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('available'),
      create,
    });

    await preparePromptApi({ signal: undefined });
    const firstLease = await acquirePromptApiGenerationSession({
      initialPrompts: [],
      signal: undefined,
      inputMode: 'text',
    });
    firstLease.release();

    const secondLease = await acquirePromptApiGenerationSession({
      initialPrompts: [],
      signal: undefined,
      inputMode: 'text',
    });
    await vi.advanceTimersByTimeAsync(TEST_ONLY.WARM_KEEPER_RECREATE_DELAY_MS);

    expect(create).toHaveBeenCalledTimes(3);
    expect(TEST_ONLY.getSessionState()).toMatchObject({
      activeGenerationSessionCount: 1,
      hasWarmKeeper: false,
      hasWarmKeeperRecreationTimer: false,
    });

    secondLease.release();
  });

  it('waits for the last parallel generation before recreating a keeper', async () => {
    vi.useFakeTimers();
    const firstGeneration = createSessionMock();
    const secondGeneration = createSessionMock();
    const replacementKeeper = createSessionMock();
    const create = vi.fn()
      .mockResolvedValueOnce(firstGeneration.session)
      .mockResolvedValueOnce(secondGeneration.session)
      .mockResolvedValueOnce(replacementKeeper.session);
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('available'),
      create,
    });

    const [firstLease, secondLease] = await Promise.all([
      acquirePromptApiGenerationSession({ initialPrompts: [], signal: undefined, inputMode: 'text' }),
      acquirePromptApiGenerationSession({ initialPrompts: [], signal: undefined, inputMode: 'text' }),
    ]);

    firstLease.release();
    expect(TEST_ONLY.getSessionState().hasWarmKeeperRecreationTimer).toBe(false);

    secondLease.release();
    expect(TEST_ONLY.getSessionState().hasWarmKeeperRecreationTimer).toBe(true);

    await vi.advanceTimersByTimeAsync(TEST_ONLY.WARM_KEEPER_RECREATE_DELAY_MS);
    expect(create).toHaveBeenCalledTimes(3);
    expect(TEST_ONLY.getSessionState().hasWarmKeeper).toBe(true);
  });

  it('destroys an in-flight background keeper if a generation becomes active', async () => {
    vi.useFakeTimers();
    const initialKeeper = createSessionMock();
    const firstGeneration = createSessionMock();
    const lateKeeper = createSessionMock();
    const secondGeneration = createSessionMock();
    let resolveLateKeeper!: (session: unknown) => void;
    const create = vi.fn()
      .mockResolvedValueOnce(initialKeeper.session)
      .mockResolvedValueOnce(firstGeneration.session)
      .mockImplementationOnce(() => new Promise<unknown>(resolve => {
        resolveLateKeeper = resolve;
      }))
      .mockResolvedValueOnce(secondGeneration.session);
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('available'),
      create,
    });

    await preparePromptApi({ signal: undefined });
    const firstLease = await acquirePromptApiGenerationSession({
      initialPrompts: [],
      signal: undefined,
      inputMode: 'text',
    });
    firstLease.release();
    await vi.advanceTimersByTimeAsync(TEST_ONLY.WARM_KEEPER_RECREATE_DELAY_MS);
    expect(TEST_ONLY.getSessionState().hasWarmKeeperCreation).toBe(true);

    const secondLease = await acquirePromptApiGenerationSession({
      initialPrompts: [],
      signal: undefined,
      inputMode: 'text',
    });
    resolveLateKeeper(lateKeeper.session);
    await Promise.resolve();
    await Promise.resolve();

    expect(lateKeeper.destroy).toHaveBeenCalledTimes(1);
    expect(TEST_ONLY.getSessionState().hasWarmKeeper).toBe(false);

    secondLease.release();
  });

  it('reschedules keeper recreation after an in-flight keeper is displaced', async () => {
    vi.useFakeTimers();
    const firstGeneration = createSessionMock();
    const displacedKeeper = createSessionMock();
    const secondGeneration = createSessionMock();
    const replacementKeeper = createSessionMock();
    let resolveDisplacedKeeper!: (session: unknown) => void;
    const create = vi.fn()
      .mockResolvedValueOnce(firstGeneration.session)
      .mockImplementationOnce(() => new Promise<unknown>(resolve => {
        resolveDisplacedKeeper = resolve;
      }))
      .mockResolvedValueOnce(secondGeneration.session)
      .mockResolvedValueOnce(replacementKeeper.session);
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('available'),
      create,
    });

    const firstLease = await acquirePromptApiGenerationSession({
      initialPrompts: [],
      signal: undefined,
      inputMode: 'text',
    });
    firstLease.release();
    await vi.advanceTimersByTimeAsync(TEST_ONLY.WARM_KEEPER_RECREATE_DELAY_MS);

    const secondLease = await acquirePromptApiGenerationSession({
      initialPrompts: [],
      signal: undefined,
      inputMode: 'text',
    });
    displacedKeeper.destroy.mockImplementation(() => {
      secondLease.release();
    });
    resolveDisplacedKeeper(displacedKeeper.session);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(displacedKeeper.destroy).toHaveBeenCalledTimes(1);
    expect(TEST_ONLY.getSessionState().hasWarmKeeperRecreationTimer).toBe(true);

    await vi.advanceTimersByTimeAsync(TEST_ONLY.WARM_KEEPER_RECREATE_DELAY_MS);
    expect(replacementKeeper.destroy).not.toHaveBeenCalled();
    expect(TEST_ONLY.getSessionState().hasWarmKeeper).toBe(true);
  });

  it('makes generation lease release idempotent', async () => {
    vi.useFakeTimers();
    const generation = createSessionMock();
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('available'),
      create: vi.fn().mockResolvedValue(generation.session),
    });

    const lease = await acquirePromptApiGenerationSession({
      initialPrompts: [],
      signal: undefined,
      inputMode: 'text',
    });
    lease.release();
    lease.release();

    expect(generation.destroy).toHaveBeenCalledTimes(1);
    expect(TEST_ONLY.getSessionState()).toMatchObject({
      activeGenerationSessionCount: 0,
      hasWarmKeeperRecreationTimer: true,
    });
  });

  it('treats background keeper recreation as a best-effort optimization', async () => {
    vi.useFakeTimers();
    const generation = createSessionMock();
    const create = vi.fn()
      .mockResolvedValueOnce(generation.session)
      .mockRejectedValueOnce(new Error('keeper failed'));
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('available'),
      create,
    });

    const lease = await acquirePromptApiGenerationSession({
      initialPrompts: [],
      signal: undefined,
      inputMode: 'text',
    });
    lease.release();
    await vi.advanceTimersByTimeAsync(TEST_ONLY.WARM_KEEPER_RECREATE_DELAY_MS);

    expect(promptApiRuntimeState.value).toEqual({ status: 'ready' });
    expect(TEST_ONLY.getSessionState()).toMatchObject({
      hasWarmKeeper: false,
      hasWarmKeeperCreation: false,
      hasWarmKeeperRecreationTimer: false,
    });
  });

  it('destroys warm and active sessions when the runtime is reset', async () => {
    vi.useFakeTimers();
    const keeper = createSessionMock();
    const generation = createSessionMock();
    const create = vi.fn()
      .mockResolvedValueOnce(keeper.session)
      .mockResolvedValueOnce(generation.session);
    vi.stubGlobal('LanguageModel', {
      availability: vi.fn().mockResolvedValue('available'),
      create,
    });

    await preparePromptApi({ signal: undefined });
    const lease = await acquirePromptApiGenerationSession({
      initialPrompts: [],
      signal: undefined,
      inputMode: 'text',
    });

    TEST_ONLY.reset();
    lease.release();

    expect(keeper.destroy).toHaveBeenCalledTimes(1);
    expect(generation.destroy).toHaveBeenCalledTimes(1);
    expect(TEST_ONLY.getSessionState()).toEqual({
      activeGenerationSessionCount: 0,
      hasActivatedPromptApi: false,
      hasWarmKeeper: false,
      hasWarmKeeperCreation: false,
      hasWarmKeeperRecreationTimer: false,
      pendingGenerationSessionCount: 0,
    });
  });
});
