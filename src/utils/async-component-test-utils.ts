/**
 * Utility to track and wait for Vue async components (defineAsyncComponent) in Vitest.
 * [DISABLED FOR TESTING GLOBAL vi.dynamicImportSettled]
 */
export const asyncComponentTracker = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pending: new Set<Promise<any>>(),
  
  track<T>(promise: Promise<T>): Promise<T> {
    // Disabled: just return the promise
    return promise;
  },

  async wait() {
    // Disabled: do nothing
    return Promise.resolve();
  }
};

/**
 * [DISABLED FOR TESTING GLOBAL vi.dynamicImportSettled]
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wrapVueWithAsyncTracking(actualVue: any) {
  // Disabled: return actual Vue without wrapping
  return actualVue;
}
