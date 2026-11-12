import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storageService } from './index';
import { MemoryStorageProvider } from './memory-storage';
import { readModelGraphRegistry, sameModelGraphRegistry, writeModelGraphRegistry } from './model-graph-registry';
import { toModelGraphRegistrationId } from '@/01-models/ids';
import { modelGraphSourceDigest, type ModelGraphRegistration } from '@/01-models/model-graph-registry';

function registration({ source }: { source: string }): ModelGraphRegistration {
  return { id: toModelGraphRegistrationId({ raw: 'test-registration' }), label: 'Example', source, sourceSha256: modelGraphSourceDigest({ source }), rule: { mode: 'disabled' } };
}

beforeEach(async () => {
  localStorage.clear();
  let previous = Promise.resolve();
  vi.stubGlobal('navigator', {
    locks: {
      request: vi.fn((_name: string, run: () => Promise<unknown>) => {
        const result = previous.then(run);
        previous = result.then(() => {}, () => {});
        return result;
      }),
    },
  });
  await storageService.init({ type: 'local' });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('retains unsupported experimental source without turning it into executable data', async () => {
  const provider = new MemoryStorageProvider();
  const initial = await readModelGraphRegistry({ provider, providerGeneration: 0, persistence: 'session' });
  const entry = registration({ source: '{"format":"retired"}' });
  await writeModelGraphRegistry({ provider, current: initial, registrations: [entry] });
  const saved = await readModelGraphRegistry({ provider, providerGeneration: 0, persistence: 'session' });
  expect(saved.registrations).toEqual([entry]);
  expect(saved.access.revision).toBe(1);
  expect(saved.access.registryId).toBeDefined();
});

it('preserves the registry identity when all entries are removed', async () => {
  const first = await storageService.loadModelGraphRegistry();
  const saved = await storageService.updateModelGraphRegistry({ access: first.access, registrations: [registration({ source: '{}' })] });
  const empty = await storageService.updateModelGraphRegistry({ access: saved.access, registrations: [] });
  expect(empty.access.registryId).toBe(saved.access.registryId);
  expect(empty.access.revision).toBe(2);
});

it('rejects an editor with the right identity but a stale revision', async () => {
  const initial = await storageService.loadModelGraphRegistry();
  const first = await storageService.updateModelGraphRegistry({ access: initial.access, registrations: [registration({ source: '{}' })] });
  await storageService.updateModelGraphRegistry({ access: first.access, registrations: [] });
  await expect(storageService.updateModelGraphRegistry({ access: first.access, registrations: first.registrations })).rejects.toThrow('changed');
  expect((await storageService.loadModelGraphRegistry()).registrations).toEqual([]);
});

it('allows only one concurrent writer from the same revision', async () => {
  const initial = await storageService.loadModelGraphRegistry();
  const writes = await Promise.allSettled([1, 2].map(n => storageService.updateModelGraphRegistry({ access: initial.access, registrations: [registration({ source: JSON.stringify({ n }) })] })));
  expect(writes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(writes.filter(result => result.status === 'rejected')).toHaveLength(1);
});

it('fails closed on corrupt persistence, rather than silently returning an empty registry', async () => {
  const provider = new MemoryStorageProvider();
  vi.spyOn(provider, 'loadModelGraphRegistry').mockResolvedValue({ version: 1, id: 'registry-invalid', revision: 1, registrations: [{ id: 'test-registration', label: 'broken', source: '{}', sourceSha256: '0'.repeat(64), rule: { mode: 'disabled' } }] });
  await expect(readModelGraphRegistry({ provider, providerGeneration: 1, persistence: 'session' })).rejects.toThrow('digest');
});

it('does not share a snapshot across provider generations or persistence modes', () => {
  const access = { registryId: undefined, revision: 0, providerGeneration: 1, persistence: 'session' as const };
  expect(sameModelGraphRegistry({ left: access, right: { ...access, providerGeneration: 2 } })).toBe(false);
  expect(sameModelGraphRegistry({ left: access, right: { ...access, persistence: 'durable' } })).toBe(false);
});

describe('admission limits', () => {
  it('rejects duplicate identifiers before persistence', async () => {
    const initial = await storageService.loadModelGraphRegistry();
    const entry = registration({ source: '{}' });
    await expect(storageService.updateModelGraphRegistry({ access: initial.access, registrations: [entry, entry] })).rejects.toThrow('duplicate');
    expect((await storageService.loadModelGraphRegistry()).access.revision).toBe(0);
  });

  it('rejects source substitution without new approval', async () => {
    const initial = await storageService.loadModelGraphRegistry();
    const entry = registration({ source: '{}' });
    await expect(storageService.updateModelGraphRegistry({ access: initial.access, registrations: [{ ...entry, rule: { mode: 'replace_native', architecture: 'llama', approvedSha256: '0'.repeat(64) } }] })).rejects.toThrow('approval');
  });
});

it('preserves local graph authority on an explicit provider switch and invalidates open editors', async () => {
  const initial = await storageService.loadModelGraphRegistry();
  const entry = registration({ source: '{"format":"retired-but-preserved"}' });
  const saved = await storageService.updateModelGraphRegistry({ access: initial.access, registrations: [entry] });
  await storageService.switchProvider({ type: 'memory' });
  const moved = await storageService.loadModelGraphRegistry();
  expect(moved.registrations).toEqual([entry]);
  expect(moved.access.registryId).toBe(saved.access.registryId);
  expect(moved.access.persistence).toBe('session');
  expect(moved.access.providerGeneration).not.toBe(saved.access.providerGeneration);
  await expect(storageService.updateModelGraphRegistry({ access: saved.access, registrations: [] })).rejects.toThrow('changed');
});

it('keeps the active provider and original registry if copying the registry fails', async () => {
  const initial = await storageService.loadModelGraphRegistry();
  const entry = registration({ source: '{}' });
  const saved = await storageService.updateModelGraphRegistry({ access: initial.access, registrations: [entry] });
  vi.spyOn(MemoryStorageProvider.prototype, 'saveModelGraphRegistry').mockRejectedValueOnce(new Error('registry copy failed'));
  await expect(storageService.switchProvider({ type: 'memory' })).rejects.toThrow('registry copy failed');
  expect(storageService.getCurrentType()).toBe('local');
  const remaining = await storageService.loadModelGraphRegistry();
  expect(remaining.registrations).toEqual([entry]);
  expect(remaining.access).toEqual(saved.access);
});
