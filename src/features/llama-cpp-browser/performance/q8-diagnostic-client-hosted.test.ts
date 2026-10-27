// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { createQ8DiagnosticClient } from './q8-diagnostic-client-hosted';
import { createQ8DiagnosticClient as createStandaloneClient } from './q8-diagnostic-client-standalone';

const fixture = vi.hoisted(() => ({ asset: undefined as { relativePath: string, bytes: number, sha256: string } | undefined }));
vi.mock('virtual:llama-cpp-browser-core/availability', () => ({
  get q8KernelDiagnosticSchemaAsset() {
    return fixture.asset;
  },
}));

afterEach(() => {
  fixture.asset = undefined;
  vi.unstubAllGlobals();
});

it('does not create a Worker or fetch a schema for the installed older package', async () => {
  const Worker = vi.fn();
  vi.stubGlobal('Worker', Worker);
  using fetcher = vi.spyOn(globalThis, 'fetch');
  const client = createQ8DiagnosticClient();
  using _cleanup = {
    [Symbol.dispose]() {
      client.dispose();
    },
  };
  await expect(client.run({ signal: undefined, timeoutMs: 1000, onProgress: () => {} })).resolves.toEqual({ status: 'unavailable', reason: 'artifact' });
  expect(Worker).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

it('reports Worker unavailability without accessing document', async () => {
  fixture.asset = { relativePath: 'profile/schema.json', bytes: 1, sha256: 'a'.repeat(64) };
  vi.stubGlobal('Worker', undefined);
  const client = createQ8DiagnosticClient();
  using _cleanup = {
    [Symbol.dispose]() {
      client.dispose();
    },
  };
  await expect(client.run({ signal: undefined, timeoutMs: 1000, onProgress: () => {} })).resolves.toEqual({ status: 'unavailable', reason: 'worker' });
});

it('keeps the standalone facade unavailable without starting hosted resources', async () => {
  const Worker = vi.fn();
  vi.stubGlobal('Worker', Worker);
  const client = createStandaloneClient();
  using _cleanup = {
    [Symbol.dispose]() {
      client.dispose();
    },
  };
  await expect(client.run({ signal: undefined, timeoutMs: 1000, onProgress: () => {} })).resolves.toEqual({ status: 'unavailable', reason: 'standalone' });
  expect(Worker).not.toHaveBeenCalled();
});
