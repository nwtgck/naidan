import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostModelHandles, type HostModelDirectoryHandle } from '@/00-storage/service/host-model-handles';
import { toHostModelDirectoryId } from '@/01-models/ids';
import { findLocalSuggestedModel } from '@/features/llama-cpp-browser/hugging-face/suggestion-plan';
import { generateInputSchema, modelSchema } from '@/features/llama-cpp-browser/types';
import type { SuggestedQuantization } from '@/features/llama-cpp-browser/hugging-face/model-suggestions';
import { destinationKey, hostModelRoot, withDestinationLock } from './model-destination';
import { formatHostModelId } from './host-model-aliases';
import { parsePublicHostModelReference } from './model-destination-types';

vi.mock('@/00-storage/service/host-model-handles', () => ({ hostModelHandles: { get: vi.fn() } }));

beforeEach(() => {
  vi.mocked(hostModelHandles.get).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('source-qualified linked model locations', () => {
  it('does not case-fold linked root locations when matching an installed catalog choice', () => {
    const quantization: SuggestedQuantization = {
      id: 'q4',
      hfRepository: 'owner/repo',
      preferredQuantization: 'Q4_K_M',
      checkpoint: 'standard',
      approximateModelBytes: 128,
      approximateMultimodalBytes: undefined,
      suggestedMemoryGiB: 1,
      suggestedMultimodalMemoryGiB: undefined,
    };
    const installed = {
      modelId: 'host/Models/owner/repo:model-Q4_K_M',
      size: 128,
      importedAt: 1,
      source: { kind: 'host' as const, directoryId: 'Root-A', directoryName: 'Models', repository: 'owner/repo', primaryRelativePath: 'model-Q4_K_M.gguf' },
    };

    expect(findLocalSuggestedModel({ quantization, models: [installed], destination: { kind: 'host', directoryId: 'root-a' } })).toBeUndefined();
    expect(findLocalSuggestedModel({ quantization, models: [installed], destination: { kind: 'host', directoryId: 'Root-A' } })).toBe(installed);
    expect(findLocalSuggestedModel({ quantization, models: [installed], destination: { kind: 'opfs' } })).toBeUndefined();
    const otherRepository = { ...installed, modelId: 'host/Models/Owner/repo:model-Q4_K_M', source: { ...installed.source, repository: 'Owner/repo' } };
    expect(findLocalSuggestedModel({ quantization, models: [otherRepository], destination: { kind: 'host', directoryId: 'Root-A' } })).toBeUndefined();
  });

  it('encodes the public folder alias while keeping opaque destination IDs separate', () => {
    const directoryId = 'same name:%/root';
    const folderName = 'same name:%/folder';
    const repository = 'owner/repository';
    const primaryRelativePath = 'weights:original/100% model.gguf';
    const directories = [{ id: toHostModelDirectoryId({ raw: directoryId }), name: folderName }];
    const modelId = formatHostModelId({ directoryId, repository, primaryRelativePath, directories });

    expect(modelId).toBe('host/same%20name%3A%25%2Ffolder/owner/repository:weights:original/100% model');
    expect(parsePublicHostModelReference({ modelId })).toEqual({ alias: folderName, repository, selector: 'weights:original/100% model' });
    expect(destinationKey({ destination: { kind: 'host', directoryId } })).toBe('host/same%20name%3A%25%2Froot');
    expect(destinationKey({ destination: { kind: 'host', directoryId: 'different root' } })).not.toBe(destinationKey({ destination: { kind: 'host', directoryId } }));
    expect(destinationKey({ destination: { kind: 'host', directoryId } })).not.toBe(destinationKey({ destination: { kind: 'opfs' } }));
  });

  it.each([
    'host/Models/owner/repo:weights//model.gguf',
    'host/%4Dodels/owner/repo:model.gguf',
    'host/Models/owner/repo:/model.gguf',
    'host/Models/owner/repo:../model.gguf',
    'host/Models/owner/repo:weights\\model.gguf',
    'host/Models/owner/repo:model.gguf\0',
    'host//owner/repo:model.gguf',
    'host/%zz/owner/repo:model.gguf',
    'host/Models/owner/repo:model.gguf/../extra',
    'hf.co/owner/repo:model.gguf',
  ])('rejects non-canonical aliases or unsafe public references %s', modelId => {
    expect(() => parsePublicHostModelReference({ modelId })).toThrow();
  });

  it('keeps a repository route separate from a selectable modelId', () => {
    const directories = [{ id: toHostModelDirectoryId({ raw: 'root' }), name: 'Models' }];
    const repositoryRoute = 'host/Models/owner/repo';
    const modelId = formatHostModelId({ directoryId: 'root', repository: 'owner/repo', primaryRelativePath: 'model.gguf', directories });

    expect(parsePublicHostModelReference({ modelId: repositoryRoute })).toEqual({ alias: 'Models', repository: 'owner/repo', selector: undefined });
    expect(modelId).toBe('host/Models/owner/repo:model');
    expect(parsePublicHostModelReference({ modelId }).selector).toBe('model');
    expect(modelSchema.parse({ modelId: repositoryRoute, size: 128, importedAt: 1 }).modelId).toBe(repositoryRoute);
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
  function publicModelId({ length }: { length: number }): string {
    const prefix = 'host/Models/owner/repo:';
    let remaining = length - prefix.length;
    const segments: string[] = [];
    while (remaining > 255) {
      segments.push('a'.repeat(200));
      remaining -= 201;
    }
    segments.push('b'.repeat(remaining));
    return `${prefix}${segments.join('/')}`;
  }

  it.each([512, 513, 1024, 4096])('accepts the same public %i-character modelId for inventory and generation', length => {
    const modelId = publicModelId({ length });
    expect(modelId).toHaveLength(length);
    expect(modelSchema.safeParse({ modelId, size: 128, importedAt: 1 }).success).toBe(true);
    expect(generateInputSchema.parse({ ...input, modelId }).modelId).toBe(modelId);
  });

  it('preserves long modelId strings at the inventory and generation boundaries', () => {
    const modelId = publicModelId({ length: 4097 });
    expect(modelSchema.parse({ modelId, size: 128, importedAt: 1 }).modelId).toBe(modelId);
    expect(generateInputSchema.parse({ ...input, modelId }).modelId).toBe(modelId);
  });

  it.each([
    'host/Models/owner/repo:../model.gguf',
    'host/%4Dodels/owner/repo:nested/model',
    `host/Models/owner/repo:${'a'.repeat(500)}%ZZ.gguf`,
  ])('passes a modelId string to resolution without imposing path rules: %s', modelId => {
    expect(generateInputSchema.parse({ ...input, modelId }).modelId).toBe(modelId);
  });

  it('does not impose a source-specific length boundary on modelId data', () => {
    const prefix = `hf.co/owner/repo:${'a'.repeat(250)}/`;
    expect(generateInputSchema.safeParse({ ...input, modelId: `${prefix}${'b'.repeat(512 - prefix.length)}` }).success).toBe(true);
    expect(generateInputSchema.safeParse({ ...input, modelId: `${prefix}${'b'.repeat(513 - prefix.length)}` }).success).toBe(true);
  });

  it.each(['nested%2fmodel', '..%2Fmodel', '%ZZ', '100% model 日本語'])('admits the literal public selector %s without URL decoding', selector => {
    const modelId = `host/Models/owner/repo:${selector}`;
    expect(modelSchema.safeParse({ modelId, size: 128, importedAt: 1 }).success).toBe(true);
    expect(generateInputSchema.parse({ ...input, modelId }).modelId).toBe(modelId);
  });
});
