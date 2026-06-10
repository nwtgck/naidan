import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  runWikipediaApiRequest,
  TEST_ONLY_resetWikipediaApiRequestScheduler,
  waitForWikipediaApiAttemptWindow,
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

  it('serializes whole logical Wikipedia API calls', async () => {
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

    expect(startedRequests).toEqual(['first', 'second'])
    await expect(firstPromise).resolves.toBe('first-result')
    await expect(secondPromise).resolves.toBe('second-result')
  })

  it('rejects queued calls that are aborted before they acquire the slot', async () => {
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

    expect(secondStarted).not.toHaveBeenCalled()
    await expect(firstPromise).resolves.toBe('first-result')
    await expect(secondPromise).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('releases the slot after a running request throws', async () => {
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

    expect(secondStarted).toHaveBeenCalledTimes(1)
    await expect(firstPromise).rejects.toThrow(/first failed/i)
    await expect(secondPromise).resolves.toBe('second-result')
  })

  it('keeps at least 1000ms between attempt starts', async () => {
    await waitForWikipediaApiAttemptWindow({
      signal: undefined,
    })

    const secondAttemptPromise = waitForWikipediaApiAttemptWindow({
      signal: undefined,
    })
    await flushMicrotasks({
      _testOnly: undefined,
    })

    let settled = false
    void secondAttemptPromise.then(() => {
      settled = true
    })
    await flushMicrotasks({
      _testOnly: undefined,
    })
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS)
    await expect(secondAttemptPromise).resolves.toBeUndefined()
  })

  it('resets cleanly while idle and rejects reset during a running request', async () => {
    await waitForWikipediaApiAttemptWindow({
      signal: undefined,
    })

    TEST_ONLY_resetWikipediaApiRequestScheduler({
      _testOnly: undefined,
    })

    const runningRequest = createDeferred<string>()
    const runningPromise = runWikipediaApiRequest({
      signal: undefined,
      request: async () => runningRequest.promise,
    })
    await flushMicrotasks({
      _testOnly: undefined,
    })

    expect(() => TEST_ONLY_resetWikipediaApiRequestScheduler({
      _testOnly: undefined,
    })).toThrow(/while a request is running/i)

    runningRequest.resolve('done')
    await expect(runningPromise).resolves.toBe('done')
  })
})
