/** Stop waiting for an uninterruptible platform read. Its late completion is
 * observed but cannot publish stale state or cause an unhandled rejection. */
export async function awaitInspection<T>({ task, signal }: { task: Promise<T>, signal: AbortSignal | undefined }): Promise<T> {
  if (!signal) return task;
  let abort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason ?? new DOMException('Inspection cancelled', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([task, stopped]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
export const TEST_ONLY = {
};
