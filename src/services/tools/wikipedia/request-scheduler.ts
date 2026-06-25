export const WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS = 1000;

type QueuedWikipediaApiSlot = {
  onAbort: (() => void) | undefined,
  reject: ReturnType<typeof Promise.withResolvers<void>>['reject'],
  resolve: () => void,
  signal: AbortSignal | undefined,
};

const wikipediaApiSlotQueue: QueuedWikipediaApiSlot[] = [];

let isWikipediaApiSlotLocked = false;
let nextWikipediaApiAttemptStartAt = 0;

function createWikipediaApiAbortError(): Error {
  const error = new Error('Wikipedia API request was aborted');
  error.name = 'AbortError';
  return error;
}

function removeQueuedWikipediaApiSlot({
  slot,
}: {
  slot: QueuedWikipediaApiSlot,
}): void {
  const slotIndex = wikipediaApiSlotQueue.indexOf(slot);
  if (slotIndex >= 0) {
    wikipediaApiSlotQueue.splice(slotIndex, 1);
  }
}

async function acquireWikipediaApiSlot({
  signal,
}: {
  signal: AbortSignal | undefined,
}): Promise<void> {
  if (signal?.aborted) {
    throw createWikipediaApiAbortError();
  }

  if (!isWikipediaApiSlotLocked) {
    isWikipediaApiSlotLocked = true;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const slot: QueuedWikipediaApiSlot = {
      onAbort: undefined,
      reject,
      resolve: () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      signal,
    };

    const onAbort = () => {
      signal?.removeEventListener('abort', onAbort);
      removeQueuedWikipediaApiSlot({
        slot,
      });
      reject(createWikipediaApiAbortError());
    };

    slot.onAbort = onAbort;
    signal?.addEventListener('abort', onAbort, { once: true });
    wikipediaApiSlotQueue.push(slot);
  });
}

function releaseWikipediaApiSlot(): void {
  while (wikipediaApiSlotQueue.length > 0) {
    const nextSlot = wikipediaApiSlotQueue.shift();
    if (nextSlot === undefined) {
      continue;
    }

    if (nextSlot.onAbort !== undefined) {
      nextSlot.signal?.removeEventListener('abort', nextSlot.onAbort);
    }
    if (nextSlot.signal?.aborted) {
      nextSlot.reject(createWikipediaApiAbortError());
      continue;
    }

    isWikipediaApiSlotLocked = true;
    nextSlot.resolve();
    return;
  }

  isWikipediaApiSlotLocked = false;
}

export async function waitForWikipediaApiAttemptWindow({
  signal,
}: {
  signal: AbortSignal | undefined,
}): Promise<void> {
  if (signal?.aborted) {
    throw createWikipediaApiAbortError();
  }

  const waitMs = Math.max(0, nextWikipediaApiAttemptStartAt - Date.now());
  if (waitMs > 0) {
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, waitMs);

      const onAbort = () => {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
        reject(createWikipediaApiAbortError());
      };

      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  if (signal?.aborted) {
    throw createWikipediaApiAbortError();
  }

  nextWikipediaApiAttemptStartAt = Date.now() + WIKIPEDIA_API_MIN_REQUEST_INTERVAL_MS;
}

export async function runWikipediaApiRequest<T>({
  signal,
  request,
}: {
  signal: AbortSignal | undefined,
  request: () => Promise<T>,
}): Promise<T> {
  await acquireWikipediaApiSlot({
    signal,
  });

  try {
    return await request();
  } finally {
    releaseWikipediaApiSlot();
  }
}

export function TEST_ONLY_resetWikipediaApiRequestScheduler({
  _testOnly,
}: {
  _testOnly: undefined,
}): void {
  void _testOnly;

  if (isWikipediaApiSlotLocked) {
    throw new Error('Cannot reset Wikipedia API request scheduler while a request is running');
  }

  for (const slot of wikipediaApiSlotQueue.splice(0)) {
    if (slot.onAbort !== undefined) {
      slot.signal?.removeEventListener('abort', slot.onAbort);
    }
    slot.reject(new Error('Wikipedia API request scheduler was reset during a test'));
  }

  nextWikipediaApiAttemptStartAt = 0;
}
