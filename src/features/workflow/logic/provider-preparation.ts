/** Provider construction loads shared modules/configuration, not a generation
 * lease. Stop waiting promptly, but observe late import failures and never use a
 * late provider. This must not wrap operations that already own model resources.
 */
export async function prepareWorkflowProvider<T>({ signal, load }: { signal: AbortSignal, load: () => Promise<T> }): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    // Start in a microtask so synchronous throws and synchronous aborts from a
    // loader are both observed by the rejection handler below.
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return load();
    }).then(provider => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        reject(signal.reason);
      } else {
        resolve(provider);
      }
    }, reason => {
      signal.removeEventListener('abort', abort);
      reject(reason);
    });
    if (signal.aborted) {
      abort();
    }
  });
}

export const TEST_ONLY = {
};
