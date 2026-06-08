import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  runWikipediaApiRequest,
  TEST_ONLY_resetWikipediaApiRequestScheduler,
  WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS,
} from './request-scheduler'

type Deferred<T> = {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })

  return {
    promise,
    reject,
    resolve,
  }
}

async function flushMicrotasks({
  _testOnly,
}: {
  _testOnly: undefined;
}): Promise<void> {
  void _testOnly
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('runWikipediaApiRequest', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    TEST_ONLY_resetWikipediaApiRequestScheduler({
      _testOnly: undefined,
    })
  })

  afterEach(() => {
    TEST_ONLY_resetWikipediaApiRequestScheduler({
      _testOnly: undefined,
    })
    vi.useRealTimers()
  })

  it('does not start the second request until the first one completes', async () => {
    const firstRequest = createDeferred<string>()
    const startedRequests: string[] = []

    const firstPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => {
        startedRequests.push('first')
        return firstRequest.promise
      },
    })
    const secondPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => {
        startedRequests.push('second')
        return 'second-result'
      },
    })

    await flushMicrotasks({
      _testOnly: undefined,
    })
    expect(startedRequests).toEqual(['first'])

    firstRequest.resolve('first-result')
    await flushMicrotasks({
      _testOnly: undefined,
    })
    expect(startedRequests).toEqual(['first'])

    await vi.advanceTimersByTimeAsync(WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS)
    await flushMicrotasks({
      _testOnly: undefined,
    })

    expect(startedRequests).toEqual(['first', 'second'])
    await expect(firstPromise).resolves.toBe('first-result')
    await expect(secondPromise).resolves.toBe('second-result')
  })

  it('keeps at least 1000ms between request start times', async () => {
    const firstRequest = createDeferred<string>()
    const startTimes: number[] = []

    const firstPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => {
        startTimes.push(Date.now())
        return firstRequest.promise
      },
    })
    const secondPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => {
        startTimes.push(Date.now())
        return 'second-result'
      },
    })

    await flushMicrotasks({
      _testOnly: undefined,
    })
    firstRequest.resolve('first-result')
    await flushMicrotasks({
      _testOnly: undefined,
    })
    await vi.advanceTimersByTimeAsync(WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS)
    await flushMicrotasks({
      _testOnly: undefined,
    })

    expect(startTimes).toHaveLength(2)
    expect(startTimes[1]! - startTimes[0]!).toBeGreaterThanOrEqual(WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS)
    await expect(firstPromise).resolves.toBe('first-result')
    await expect(secondPromise).resolves.toBe('second-result')
  })

  it('continues to the next request after a rejected request', async () => {
    const secondStarted = vi.fn()

    const firstPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => {
        throw new Error('first failed')
      },
    })
    void firstPromise.catch(() => undefined)
    const secondPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => {
        secondStarted()
        return 'second-result'
      },
    })

    await flushMicrotasks({
      _testOnly: undefined,
    })
    await vi.advanceTimersByTimeAsync(WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS)
    await flushMicrotasks({
      _testOnly: undefined,
    })

    expect(secondStarted).toHaveBeenCalledTimes(1)
    await expect(firstPromise).rejects.toThrow(/first failed/i)
    await expect(secondPromise).resolves.toBe('second-result')
  })

  it('does not start a waiting request that is aborted before execution', async () => {
    const firstRequest = createDeferred<string>()
    const secondStarted = vi.fn()
    const secondController = new AbortController()

    const firstPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => firstRequest.promise,
    })
    const secondPromise = runWikipediaApiRequest({
      signal: secondController.signal,
      request: async () => {
        secondStarted()
        return 'second-result'
      },
    })
    void secondPromise.catch(() => undefined)

    await flushMicrotasks({
      _testOnly: undefined,
    })
    secondController.abort()
    firstRequest.resolve('first-result')
    await flushMicrotasks({
      _testOnly: undefined,
    })
    await vi.advanceTimersByTimeAsync(WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS)
    await flushMicrotasks({
      _testOnly: undefined,
    })

    expect(secondStarted).not.toHaveBeenCalled()
    await expect(firstPromise).resolves.toBe('first-result')
    await expect(secondPromise).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('does not start a queued request that is aborted before it begins waiting', async () => {
    const firstRequest = createDeferred<string>()
    const secondStarted = vi.fn()
    const secondController = new AbortController()

    const firstPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => firstRequest.promise,
    })
    const secondPromise = runWikipediaApiRequest({
      signal: secondController.signal,
      request: async () => {
        secondStarted()
        return 'second-result'
      },
    })
    void secondPromise.catch(() => undefined)

    secondController.abort()
    await flushMicrotasks({
      _testOnly: undefined,
    })
    firstRequest.resolve('first-result')
    await flushMicrotasks({
      _testOnly: undefined,
    })
    await vi.advanceTimersByTimeAsync(WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS)
    await flushMicrotasks({
      _testOnly: undefined,
    })

    expect(secondStarted).not.toHaveBeenCalled()
    await expect(firstPromise).resolves.toBe('first-result')
    await expect(secondPromise).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('cancels the waiting timer when a waiting request is aborted', async () => {
    const firstRequest = createDeferred<string>()
    const secondStarted = vi.fn()
    const secondController = new AbortController()

    const firstPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => firstRequest.promise,
    })
    const secondPromise = runWikipediaApiRequest({
      signal: secondController.signal,
      request: async () => {
        secondStarted()
        return 'second-result'
      },
    })
    void secondPromise.catch(() => undefined)

    await flushMicrotasks({
      _testOnly: undefined,
    })
    firstRequest.resolve('first-result')
    await flushMicrotasks({
      _testOnly: undefined,
    })
    secondController.abort()
    await flushMicrotasks({
      _testOnly: undefined,
    })
    await vi.advanceTimersByTimeAsync(WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS)
    await flushMicrotasks({
      _testOnly: undefined,
    })

    expect(secondStarted).not.toHaveBeenCalled()
    await expect(firstPromise).resolves.toBe('first-result')
    await expect(secondPromise).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('starts the next queued request after a running request resolves', async () => {
    const firstRequest = createDeferred<string>()
    const startedRequests: string[] = []

    const firstPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => {
        startedRequests.push('first')
        return firstRequest.promise
      },
    })
    const secondPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => {
        startedRequests.push('second')
        return 'second-result'
      },
    })

    await flushMicrotasks({
      _testOnly: undefined,
    })
    firstRequest.resolve('first-result')
    await flushMicrotasks({
      _testOnly: undefined,
    })
    await vi.advanceTimersByTimeAsync(WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS)
    await flushMicrotasks({
      _testOnly: undefined,
    })

    expect(startedRequests).toEqual(['first', 'second'])
    await expect(firstPromise).resolves.toBe('first-result')
    await expect(secondPromise).resolves.toBe('second-result')
  })

  it('throws if reset is called while a request is running', async () => {
    const firstRequest = createDeferred<string>()

    const firstPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => firstRequest.promise,
    })

    await flushMicrotasks({
      _testOnly: undefined,
    })

    expect(() => TEST_ONLY_resetWikipediaApiRequestScheduler({
      _testOnly: undefined,
    })).toThrow(/while a request is running/i)

    firstRequest.resolve('first-result')
    await expect(firstPromise).resolves.toBe('first-result')
  })

  it('allows reset while idle and leaves the next test run clean', async () => {
    TEST_ONLY_resetWikipediaApiRequestScheduler({
      _testOnly: undefined,
    })

    const promise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => 'ok',
    })

    await expect(promise).resolves.toBe('ok')
  })
})
