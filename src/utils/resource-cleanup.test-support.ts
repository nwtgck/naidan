/** Test-only adapters. Production resources retain their existing explicit APIs. */
export function createTestDisposable({ dispose }: { dispose: () => undefined }): Disposable {
  if (typeof Symbol.dispose !== 'symbol') {
    throw new Error('The test runtime must provide Symbol.dispose; do not install a polyfill.');
  }
  return { [Symbol.dispose]: dispose };
}

export function createAsyncTestDisposable({ dispose }: { dispose: () => PromiseLike<void> }): AsyncDisposable {
  if (typeof Symbol.asyncDispose !== 'symbol') {
    throw new Error('The test runtime must provide Symbol.asyncDispose; do not install a polyfill.');
  }
  return {
    async [Symbol.asyncDispose]() {
      await dispose();
    },
  };
}
