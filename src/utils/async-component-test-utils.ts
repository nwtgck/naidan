/**
 * Utility to track and wait for Vue async components (defineAsyncComponent) in Vitest.
 * This prevents "Closing rpc while fetch was pending" errors in CI by ensuring
 * all dynamic imports complete before the test process exits.
 */
export const asyncComponentTracker = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pending: new Set<Promise<any>>(),
  
  /**
   * Track a promise and remove it from the set when it settles.
   */
  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    promise.catch(() => {}).finally(() => this.pending.delete(promise));
    return promise;
  },

  /**
   * Wait for all currently tracked pending promises to complete.
   */
  async wait() {
    // Keep waiting as long as there are pending imports
    // (handles cases where one import triggers another)
    while (this.pending.size > 0) {
      await Promise.allSettled(Array.from(this.pending));
    }
  }
};

/**
 * Reusable logic to wrap Vue's defineAsyncComponent with tracking.
 * 
 * Usage in your test file:
 * 
 * vi.mock('vue', async (importOriginal) => {
 *   const actual = await importOriginal<typeof import('vue')>();
 *   const { wrapVueWithAsyncTracking } = await vi.importActual<any>('../utils/async-component-test-utils');
 *   return wrapVueWithAsyncTracking(actual);
 * });
 * 
 * afterAll(async () => {
 *   await asyncComponentTracker.wait();
 * });
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrapVueWithAsyncTracking(actualVue: any) {
  return {
    ...actualVue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    defineAsyncComponent: (source: any) => {
      // Handle both defineAsyncComponent(loader) and defineAsyncComponent({ loader, ... })
      const loader = typeof source === 'function' ? source : source.loader;
      
      const wrappedLoader = () => {
        return asyncComponentTracker.track(loader());
      };

      return actualVue.defineAsyncComponent(
        typeof source === 'function' 
          ? wrappedLoader 
          : { ...source, loader: wrappedLoader }
      );
    }
  };
}
