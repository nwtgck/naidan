import type { Q8DiagnosticClient } from './q8-diagnostic-worker-types';

export function createQ8DiagnosticClient(): Q8DiagnosticClient {
  return {
    async run({ signal }) {
      signal?.throwIfAborted();
      return { status: 'unavailable', reason: 'standalone' };
    },
    dispose() {},
  };
}

export const TEST_ONLY = {
};
