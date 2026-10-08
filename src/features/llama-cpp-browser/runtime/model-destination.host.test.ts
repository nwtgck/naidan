import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { findLocalSuggestedModel } from '@/features/llama-cpp-browser/hugging-face/suggestion-plan';
import { generateInputSchema, modelSchema } from '@/features/llama-cpp-browser/types';
import type { SuggestedQuantization } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { destinationKey, hostModelReference, hostModelRoot, parseHostModelReference, withDestinationLock } from './model-destination';

vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));

beforeEach(() => {
  vi.mocked(hostModelHandles.get).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('source-qualified linked model identities', () => {
  it('does not case-fold linked root identities when matching an installed catalog choice', () => {
    const quantization: SuggestedQuantization = {
      id: 'q4',
      repository: 'owner/repo',
      preferredQuantization: 'Q4_K_M',
      checkpoint: 'standard',
      approximateModelBytes: 128,
      approximateMultimodalBytes: undefined,
      suggestedMemoryGiB: 1,
      suggestedMultimodalMemoryGiB: undefined,
    };
    const id = hostModelReference({ directoryId: 'Root-A', repository: quantization.repository, modelPath: 'model-Q4_K_M.gguf' });
    const installed = { id, name: id, size: 128, importedAt: 1 };

    expect(findLocalSuggestedModel({ quantization, models: [installed], destination: { kind: 'host', directoryId: 'root-a' } })).toBeUndefined();
    expect(findLocalSuggestedModel({ quantization, models: [installed], destination: { kind: 'host', directoryId: 'Root-A' } })).toBe(installed);
    expect(findLocalSuggestedModel({ quantization, models: [installed], destination: { kind: 'opfs' } })).toBeUndefined();
    const otherRepositoryId = hostModelReference({ directoryId: 'Root-A', repository: 'Owner/repo', modelPath: 'model-Q4_K_M.gguf' });
    const otherRepository = { ...installed, id: otherRepositoryId, name: otherRepositoryId };
    expect(findLocalSuggestedModel({ quantization, models: [otherRepository], destination: { kind: 'host', directoryId: 'Root-A' } })).toBeUndefined();
  });

  it('round-trips opaque root IDs and exact nested paths without using display names', () => {
    const directoryId = 'same name:%/root';
    const repository = 'owner/repository';
    const modelPath = 'weights:original/100% model.gguf';
    const reference = hostModelReference({ directoryId, repository, modelPath });

    expect(reference).toBe('host/same%20name%3A%25%2Froot/owner/repository:weights%3Aoriginal%2F100%25%20model.gguf');
    expect(parseHostModelReference({ name: reference })).toEqual({ destination: { kind: 'host', directoryId }, repository, modelPath });
    expect(hostModelReference({ directoryId: 'different root', repository, modelPath })).not.toBe(reference);
    expect(destinationKey({ destination: { kind: 'host', directoryId } })).not.toBe(destinationKey({ destination: { kind: 'opfs' } }));
  });

  it.each([
    'host/root/owner/repo:weights%2fmodel.gguf',
    'host/%72oot/owner/repo:model.gguf',
    'host/root/owner/repo:%2Fmodel.gguf',
    'host/root/owner/repo:..%2Fmodel.gguf',
    'host/root/owner/repo:weights%5Cmodel.gguf',
    'host/root/owner/repo:model.gguf%00',
    'host//owner/repo:model.gguf',
    'host/%zz/owner/repo:model.gguf',
    'host/root/owner/repo:model.gguf/extra',
    'hf.co/owner/repo:model.gguf',
  ])('rejects non-canonical or unsafe reference %s', name => {
    expect(() => parseHostModelReference({ name })).toThrow();
  });

  it('keeps a repository-level identity separate from an exact model identity', () => {
    const repository = hostModelReference({ directoryId: 'root', repository: 'owner/repo', modelPath: undefined });
    expect(repository).toBe('host/root/owner/repo');
    expect(parseHostModelReference({ name: repository }).modelPath).toBeUndefined();
    expect(hostModelReference({ directoryId: 'root', repository: 'owner/repo', modelPath: 'model.gguf' })).not.toBe(repository);
  });
});

describe('linked model permission failures do not change storage routes', () => {
  it('cancels while another operation owns the linked-root lock without entering the writer', async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => undefined);
    const request = vi.fn(async (_name: string, { signal }: { signal: AbortSignal }) => {
      expect(signal).toBe(controller.signal);
      return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    vi.stubGlobal('navigator', { locks: { request } });

    const waiting = withDestinationLock({ destination: { kind: 'host', directoryId: 'root' }, signal: controller.signal, operation });
    const rejected = expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;

    expect(operation).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(['prompt', 'denied'] as const)('rejects %s write permission without requesting access or opening OPFS', async permission => {
    const queryPermission = vi.fn(async () => permission);
    const requestPermission = vi.fn();
    const getDirectory = vi.fn();
    vi.stubGlobal('navigator', { storage: { getDirectory } });
    vi.mocked(hostModelHandles.get).mockResolvedValue({ queryPermission, requestPermission } as unknown as HostModelDirectoryHandle);

    await expect(hostModelRoot({ destination: { kind: 'host', directoryId: 'root' }, mode: 'readwrite' })).rejects.toThrow();

    expect(hostModelHandles.get).toHaveBeenCalledExactlyOnceWith({ id: toHostModelDirectoryId({ raw: 'root' }) });
    expect(queryPermission).toHaveBeenCalledExactlyOnceWith({ mode: 'readwrite' });
    expect(requestPermission).not.toHaveBeenCalled();
    expect(getDirectory).not.toHaveBeenCalled();
  });

  it('requires only read permission for an existing model', async () => {
    const queryPermission = vi.fn(async () => 'granted' as const);
    const root = { queryPermission } as unknown as HostModelDirectoryHandle;
    vi.mocked(hostModelHandles.get).mockResolvedValue(root);

    expect(await hostModelRoot({ destination: { kind: 'host', directoryId: 'root' }, mode: 'read' })).toBe(root);
    expect(queryPermission).toHaveBeenCalledExactlyOnceWith({ mode: 'read' });
  });

  it('preserves handle-storage failures rather than resolving the same repository in OPFS', async () => {
    const failure = new DOMException('Handle database denied', 'SecurityError');
    const getDirectory = vi.fn();
    vi.stubGlobal('navigator', { storage: { getDirectory } });
    vi.mocked(hostModelHandles.get).mockRejectedValue(failure);

    await expect(hostModelRoot({ destination: { kind: 'host', directoryId: 'root' }, mode: 'read' })).rejects.toBe(failure);
    expect(getDirectory).not.toHaveBeenCalled();
  });
});

describe('linked model generation admission', () => {
  const input = {
    messages: [{ role: 'user', content: 'Hello' }],
    temperature: 0.7,
    topP: 1,
    presencePenalty: 0,
    frequencyPenalty: 0,
    stop: [],
    options: { profile: 'cpu-wasm32' },
  };
  function reference({ length }: { length: number }): string {
    const prefix = `${hostModelReference({ directoryId: 'root', repository: 'owner/repo', modelPath: undefined })}:`;
    let remaining = length - prefix.length;
    const segments: string[] = [];
    while (remaining > 255) {
      segments.push('a'.repeat(200)); remaining -= 203;
    }
    segments.push(`${'b'.repeat(remaining - '.gguf'.length)}.gguf`);
    return hostModelReference({ directoryId: 'root', repository: 'owner/repo', modelPath: segments.join('/') });
  }

  it.each([512, 513, 1024])('accepts the same canonical %i-character name for inventory and generation', length => {
    const model = reference({ length });
    expect(model).toHaveLength(length);
    expect(modelSchema.safeParse({ id: model, name: model, size: 128, importedAt: 1 }).success).toBe(true);
    expect(generateInputSchema.parse({ ...input, model }).model).toBe(model);
  });

  it('rejects canonical linked references beyond the inventory boundary', () => {
    const model = reference({ length: 1025 });
    expect(modelSchema.safeParse({ id: model, name: model, size: 128, importedAt: 1 }).success).toBe(false);
    expect(generateInputSchema.safeParse({ ...input, model }).success).toBe(false);
  });

  it.each([
    'host/root/owner/repo:../model.gguf',
    'host/root/owner/repo:nested%2fmodel.gguf',
    `host/root/owner/repo:${'a'.repeat(500)}%ZZ.gguf`,
  ])('rejects an invalid or non-canonical linked reference: %s', model => {
    expect(generateInputSchema.safeParse({ ...input, model }).success).toBe(false);
  });

  it('retains the 512-character boundary for ordinary model names', () => {
    expect(generateInputSchema.safeParse({ ...input, model: 'a'.repeat(512) }).success).toBe(true);
    expect(generateInputSchema.safeParse({ ...input, model: 'a'.repeat(513) }).success).toBe(false);
  });
});
