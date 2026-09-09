// Build fixture: use the same Worker URL form as the application's bootstrap.
export function createFixtureWorker() {
  return new Worker(new URL('./worker-entry.ts', import.meta.url), { type: 'module' });
}

export const TEST_ONLY = {
};
