export const WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS = 500

type ScheduledWikipediaApiRequest = {
  reject: (reason: unknown) => void;
  request: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  signal: AbortSignal | undefined;
  stage: 'queued' | 'waiting' | 'running' | 'settled';
  waitAbortResolver: (() => void) | undefined;
}

const scheduledWikipediaApiRequests: ScheduledWikipediaApiRequest[] = []

let isWikipediaApiRequestRunning = false
let nextWikipediaApiRequestStartAt = 0

function createWikipediaApiAbortError(): Error {
  return new Error('Wikipedia API request was aborted')
}

function settleScheduledWikipediaApiRequest({
  task,
  callback,
}: {
  task: ScheduledWikipediaApiRequest;
  callback: () => void;
}): void {
  switch (task.stage) {
  case 'queued':
  case 'waiting':
  case 'running':
    break
  case 'settled':
    return
  default: {
    const neverStage: never = task.stage
    throw new Error(`Unhandled Wikipedia API request stage: ${String(neverStage)}`)
  }
  }

  task.stage = 'settled'
  task.waitAbortResolver?.()
  task.waitAbortResolver = undefined
  callback()
}

function removeScheduledWikipediaApiRequest({
  task,
}: {
  task: ScheduledWikipediaApiRequest;
}): void {
  const taskIndex = scheduledWikipediaApiRequests.indexOf(task)
  if (taskIndex >= 0) {
    scheduledWikipediaApiRequests.splice(taskIndex, 1)
  }
}

async function waitForWikipediaApiRequestWindow({
  task,
  waitMs,
}: {
  task: ScheduledWikipediaApiRequest;
  waitMs: number;
}): Promise<void> {
  if (waitMs <= 0) {
    return
  }

  await new Promise<void>((resolve) => {
    const timeoutId = setTimeout(() => {
      task.waitAbortResolver = undefined
      resolve()
    }, waitMs)

    task.waitAbortResolver = () => {
      clearTimeout(timeoutId)
      task.waitAbortResolver = undefined
      resolve()
    }
  })
}

async function processScheduledWikipediaApiRequests(): Promise<void> {
  if (isWikipediaApiRequestRunning) {
    return
  }

  isWikipediaApiRequestRunning = true

  try {
    while (scheduledWikipediaApiRequests.length > 0) {
      const task = scheduledWikipediaApiRequests.shift()
      if (task === undefined) {
        continue
      }

      switch (task.stage) {
      case 'queued':
      case 'waiting':
      case 'running':
        break
      case 'settled':
        continue
      default: {
        const neverStage: never = task.stage
        throw new Error(`Unhandled Wikipedia API request stage: ${String(neverStage)}`)
      }
      }

      task.stage = 'waiting'
      const waitMs = Math.max(0, nextWikipediaApiRequestStartAt - Date.now())
      await waitForWikipediaApiRequestWindow({
        task,
        waitMs,
      })

      if (task.stage !== 'waiting') {
        continue
      }

      task.stage = 'running'
      nextWikipediaApiRequestStartAt = Date.now() + WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS

      try {
        const result = await task.request()
        settleScheduledWikipediaApiRequest({
          task,
          callback: () => {
            task.resolve(result)
          },
        })
      } catch (error) {
        settleScheduledWikipediaApiRequest({
          task,
          callback: () => {
            task.reject(error)
          },
        })
      }
    }
  } finally {
    isWikipediaApiRequestRunning = false
    if (scheduledWikipediaApiRequests.length > 0) {
      void processScheduledWikipediaApiRequests()
    }
  }
}

export async function runWikipediaApiRequest<T>({
  signal,
  request,
}: {
  signal: AbortSignal | undefined;
  request: () => Promise<T>;
}): Promise<T> {
  if (signal?.aborted) {
    throw createWikipediaApiAbortError()
  }

  return new Promise<T>((resolve, reject) => {
    const task: ScheduledWikipediaApiRequest = {
      reject,
      request,
      resolve: (value) => {
        resolve(value as T)
      },
      signal,
      stage: 'queued',
      waitAbortResolver: undefined,
    }

    const onAbort = () => {
      if (task.stage === 'running' || task.stage === 'settled') {
        return
      }

      removeScheduledWikipediaApiRequest({
        task,
      })
      settleScheduledWikipediaApiRequest({
        task,
        callback: () => {
          reject(createWikipediaApiAbortError())
        },
      })
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    const originalResolve = task.resolve
    task.resolve = (value) => {
      signal?.removeEventListener('abort', onAbort)
      originalResolve(value)
    }

    const originalReject = task.reject
    task.reject = (reason) => {
      signal?.removeEventListener('abort', onAbort)
      originalReject(reason)
    }

    scheduledWikipediaApiRequests.push(task)
    void processScheduledWikipediaApiRequests()
  })
}

export function TEST_ONLY_resetWikipediaApiRequestScheduler({
  _testOnly,
}: {
  _testOnly: undefined;
}): void {
  void _testOnly

  for (const task of scheduledWikipediaApiRequests.splice(0)) {
    settleScheduledWikipediaApiRequest({
      task,
      callback: () => {
        task.reject(new Error('Wikipedia API request scheduler was reset during a test'))
      },
    })
  }

  isWikipediaApiRequestRunning = false
  nextWikipediaApiRequestStartAt = 0
}
