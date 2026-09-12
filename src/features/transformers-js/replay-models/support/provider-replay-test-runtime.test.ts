// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { createProviderReplayTestRuntime } from './provider-replay-test-runtime';
import { createProviderReplayTestWorkerConstructor, ProviderReplayTestWorker } from './provider-replay-test-transport';
import { createProviderReplayTestImagePlatform } from './provider-replay-test-image-platform';
import * as artifactFixture from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';
import type { ProviderReplayGenerate } from './provider-replay-test-runtime';
import type { LmProvider } from '@/01-models/lm';
import { createProductionProviderTrace } from '@/features/transformers-js/model-support-investigation/logic/production-provider-trace';
import type { CaptureRequestInput } from '@/features/transformers-js/model-support-investigation/logic/production-provider-capture-plan';

const capturedSmolLoadIdentity = {
  status: 'ready', workerLoadOrdinal: 1, requestedModelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
  requestedRevision: { status: 'provided', value: '12fd25f77366fa6b3b4b768ec3050bf629380bac' },
  cleanModelId: 'HuggingFaceTB/SmolLM2-135M-Instruct', autoClass: 'AutoModelForCausalLM', processor: 'tokenizer',
  selectedCandidate: { device: 'webgpu', dtype: 'q4f16' },
  resolvedRevision: { status: 'not-observed' }, sessionExecutionProvider: { status: 'not-observed' },
};

function mechanicsArguments({ generate }: { generate: ProviderReplayGenerate }): Parameters<typeof createProviderReplayTestRuntime>[0] {
  return {
    modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
    expectedRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', cacheRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', metadataCache: "all-fixture",
    artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: Uint8Array.of(1, 2, 3) }],
    generate,
    imagePlatform: undefined,
  };
}

describe('Production replay explicit image platform ownership', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  it('keeps the real offline deny boundary and snapshots the exact local image capability', async () => {
    const platform = createProviderReplayTestImagePlatform();
    const nativeFetch = globalThis.fetch;
    const delegated = vi.fn<typeof fetch>((input, init) => nativeFetch(input, init));
    vi.stubGlobal('fetch', delegated);
    const allowedDataUrls = [dataUrl];
    const harness = await createProviderReplayTestRuntime({
      ...mechanicsArguments({ generate: async () => {
        throw new Error('No inference in capability test');
      } }),
      imagePlatform: { platform, allowedDataUrls },
    });
    try {
      const unlisted = 'data:image/png;base64,AAAA';
      allowedDataUrls.push(unlisted);
      await expect(fetch('https://huggingface.co/synthetic/model/resolve/main/image.png')).rejects.toThrow('blocked non-runtime');
      await expect(fetch('http://localhost/not-a-runtime-asset.png')).rejects.toThrow('blocked non-runtime');
      await expect(fetch('blob:http://localhost/synthetic-image')).rejects.toThrow('blocked non-runtime');
      await expect(fetch(unlisted)).rejects.toThrow('Unprovided replay transport');
      await expect(fetch('data:text/plain;base64,AAAA')).rejects.toThrow('Unprovided replay transport');
      expect(delegated).not.toHaveBeenCalled();
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.fetchCalls).toEqual([
        'https://huggingface.co/synthetic/model/resolve/main/image.png',
        'http://localhost/not-a-runtime-asset.png', 'blob:http://localhost/synthetic-image',
        unlisted, 'data:text/plain;base64,AAAA',
      ]);
      const response = await fetch(dataUrl);
      expect(response.status).toBe(200);
      expect(delegated).toHaveBeenCalledOnce();
      expect(harness.observations.localImageFetchCalls).toEqual([dataUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([unlisted, 'data:text/plain;base64,AAAA']);
    } finally {
      await harness.close();
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it('preserves native Request headers, override precedence and abort while forcing redirect error', async () => {
    const platform = createProviderReplayTestImagePlatform();
    const nativeFetch = globalThis.fetch;
    const requests: Request[] = [];
    const delegated = vi.fn<typeof fetch>((input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return nativeFetch(request);
    });
    vi.stubGlobal('fetch', delegated);
    const harness = await createProviderReplayTestRuntime({
      ...mechanicsArguments({ generate: async () => {
        throw new Error('No inference in request test');
      } }),
      imagePlatform: { platform, allowedDataUrls: [dataUrl] },
    });
    try {
      const inherited = new AbortController();
      const replacement = new AbortController();
      const request = new Request(dataUrl, { headers: { 'x-image-test': 'original' }, signal: inherited.signal });
      inherited.abort(new Error('Overridden signal must not win'));
      const response = await fetch(request, { headers: { 'x-image-test': 'replacement' }, signal: replacement.signal, redirect: 'follow' });
      expect(response.status).toBe(200);
      expect(requests[0]?.url).toBe(dataUrl);
      expect(requests[0]?.method).toBe('GET');
      expect(requests[0]?.headers.get('x-image-test')).toBe('replacement');
      expect(requests[0]?.redirect).toBe('error');
      expect(requests[0]?.signal.aborted).toBe(false);
      const stopped = new Error('Local image request stopped');
      replacement.abort(stopped);
      await expect(fetch(dataUrl, { signal: replacement.signal })).rejects.toThrow(stopped.message);
      expect(requests[1]?.signal.reason).toBe(stopped);
      await expect(fetch(dataUrl, { method: 'POST' })).rejects.toThrow('Unsupported local');
      expect(delegated).toHaveBeenCalledTimes(2);
      expect(harness.observations.localImageFetchCalls).toEqual([dataUrl, dataUrl]);
    } finally {
      await harness.close();
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it('does not enable local data transport when the image platform option is absent', async () => {
    const parentFetch = vi.fn<typeof fetch>(async () => {
      throw new Error('Parent fetch must remain unused');
    });
    vi.stubGlobal('fetch', parentFetch);
    const harness = await createProviderReplayTestRuntime(mechanicsArguments({ generate: async () => {
      throw new Error('No inference in absent image test');
    } }));
    try {
      await expect(fetch(dataUrl)).rejects.toThrow('Unprovided replay transport');
      expect(parentFetch).not.toHaveBeenCalled();
      expect(harness.observations.localImageFetchCalls).toEqual([]);
    } finally {
      await harness.close();
      expect(globalThis.fetch).toBe(parentFetch);
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it('rejects a non-data image capability before changing globals or importing the runtime', async () => {
    const beforeFetch = globalThis.fetch;
    const importer = vi.spyOn(artifactFixture, 'importProductionTransformersArtifact');
    try {
      await expect(createProviderReplayTestRuntime({
        ...mechanicsArguments({ generate: async () => {
          throw new Error('No inference in invalid capability test');
        } }),
        imagePlatform: { platform: createProviderReplayTestImagePlatform(), allowedDataUrls: ['http://localhost/synthetic.png'] },
      })).rejects.toThrow('exact bounded PNG data URL');
      expect(importer).not.toHaveBeenCalled();
      expect(globalThis.fetch).toBe(beforeFetch);
    } finally {
      importer.mockRestore();
    }
  });

  it('runs actual RawImage decode, RGB conversion and resize through the explicit platform', async () => {
    const platform = createProviderReplayTestImagePlatform();
    const before = ['self', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope', 'ImageData', 'OffscreenCanvas', 'createImageBitmap', 'fetch'].map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const harness = await createProviderReplayTestRuntime({
      ...mechanicsArguments({ generate: async () => {
        throw new Error('No inference in native image boundary test');
      } }),
      imagePlatform: { platform, allowedDataUrls: [dataUrl] },
    });
    try {
      await harness.service.loadDownloadedModel({ modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct' });
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      expect(blob).toBeInstanceOf(Blob);
      const image = await harness.runtime.RawImage.read(blob);
      expect(vi.isMockFunction(harness.runtime.RawImage.read)).toBe(false);
      expect(vi.isMockFunction(harness.runtime.RawImage.fromBlob)).toBe(false);
      expect(vi.isMockFunction(image.resize)).toBe(false);
      expect(image).toBeInstanceOf(harness.runtime.RawImage);
      expect([image.width, image.height, image.channels]).toEqual([1, 1, 4]);
      expect(Array.from(image.data)).toEqual([0, 0, 0, 255]);
      const resized = await image.rgb().resize(768, 768);
      expect([resized.width, resized.height, resized.channels]).toEqual([768, 768, 3]);
      expect(resized.data.length).toBe(768 * 768 * 3);
      expect(resized.data.every(value => value === 0)).toBe(true);
      expect(globalThis.self.constructor.name).toBe('DedicatedWorkerGlobalScope');
      const workerScope = Reflect.get(globalThis, 'WorkerGlobalScope');
      const dedicatedScope = Reflect.get(globalThis, 'DedicatedWorkerGlobalScope');
      if (typeof workerScope !== 'function' || typeof dedicatedScope !== 'function') throw new Error('Missing owned Worker scope constructors');
      expect(globalThis.self).toBeInstanceOf(workerScope);
      expect(globalThis.self).toBeInstanceOf(dedicatedScope);
      expect(globalThis.ImageData).toBe(platform.ImageData);
      expect(globalThis.OffscreenCanvas).toBe(platform.OffscreenCanvas);
      expect(harness.observations.localImageFetchCalls).toEqual([dataUrl]);
      expect(harness.observations.fetchCalls).toContain(dataUrl);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(platform.observations.decodes).toHaveLength(1);
      expect(platform.observations.draws).toEqual([
        { sourceWidth: 1, sourceHeight: 1, targetWidth: 1, targetHeight: 1 },
        { sourceWidth: 1, sourceHeight: 1, targetWidth: 768, targetHeight: 768 },
      ]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
    expect(['self', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope', 'ImageData', 'OffscreenCanvas', 'createImageBitmap', 'fetch'].map(key => Object.getOwnPropertyDescriptor(globalThis, key))).toEqual(before);
  }, 30_000);

  it('restores image globals even when service unload rejects', async () => {
    const keys = ['self', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope', 'ImageData', 'OffscreenCanvas', 'createImageBitmap', 'fetch'];
    const before = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const originalImport = artifactFixture.importProductionTransformersArtifact;
    const methods: Array<{ target: object, descriptor: PropertyDescriptor | undefined }> = [];
    const importer = vi.spyOn(artifactFixture, 'importProductionTransformersArtifact').mockImplementationOnce(async args => {
      const runtime = await originalImport(args) as typeof import('@huggingface/transformers');
      for (const target of [runtime.AutoTokenizer, runtime.AutoProcessor, runtime.AutoModelForCausalLM, runtime.AutoModelForImageTextToText]) {
        methods.push({ target, descriptor: Object.getOwnPropertyDescriptor(target, 'from_pretrained') });
      }
      return runtime;
    });
    try {
      const harness = await createProviderReplayTestRuntime({
        ...mechanicsArguments({ generate: async () => {
          throw new Error('No inference in unload failure test');
        } }),
        imagePlatform: { platform: createProviderReplayTestImagePlatform(), allowedDataUrls: [dataUrl] },
      });
      const failure = new Error('Synthetic unload failure with image platform');
      const unload = vi.spyOn(harness.service, 'unloadModel').mockRejectedValueOnce(failure);
      try {
        await expect(harness.close()).rejects.toBe(failure);
        expect(keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key))).toEqual(before);
        expect(harness.observations.cleanupErrors).toEqual([]);
        expect(methods).toHaveLength(4);
        for (const { target, descriptor } of methods) {
          expect(Object.getOwnPropertyDescriptor(target, 'from_pretrained')).toEqual(descriptor);
        }
      } finally {
        unload.mockRestore();
      }
    } finally {
      importer.mockRestore();
    }
  }, 30_000);

  it('restores caller-owned image globals after setup failure while retaining its cause', async () => {
    const platform = createProviderReplayTestImagePlatform();
    const parentImageData = { owner: 'parent ImageData' };
    vi.stubGlobal('ImageData', parentImageData);
    const keys = ['self', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope', 'ImageData', 'OffscreenCanvas', 'createImageBitmap', 'fetch'];
    const before = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const failure = new Error('Image-enabled artifact import failure');
    const importer = vi.spyOn(artifactFixture, 'importProductionTransformersArtifact').mockImplementationOnce(async () => {
      expect(globalThis.ImageData).toBe(platform.ImageData);
      expect(globalThis.self.constructor.name).toBe('DedicatedWorkerGlobalScope');
      throw failure;
    });
    try {
      await expect(createProviderReplayTestRuntime({
        ...mechanicsArguments({ generate: async () => {
          throw new Error('No inference after setup failure');
        } }),
        imagePlatform: { platform, allowedDataUrls: [dataUrl] },
      })).rejects.toBe(failure);
      expect(keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key))).toEqual(before);
    } finally {
      importer.mockRestore();
      vi.unstubAllGlobals();
    }
  }, 30_000);
});

describe('Production replay explicit local cache metadata', () => {
  it('rejects duplicate, unrecorded, escaped and foreign cache identities before native startup', async () => {
    const startup = vi.spyOn(artifactFixture, 'getProductionTransformersArtifact');
    const args = mechanicsArguments({ generate: async () => {
      throw new Error('No inference for invalid setup');
    } });
    try {
      for (const metadataCache of [['config.json', 'config.json'], ['not-recorded.json'], ['../config.json'], ['/config.json']]) {
        await expect(createProviderReplayTestRuntime({ ...args, metadataCache })).rejects.toThrow('Unprovided or duplicate replay cache metadata');
      }
      await expect(createProviderReplayTestRuntime({ ...args, cacheRevision: '../foreign' })).rejects.toThrow('Replay cache namespace');
      expect(startup).not.toHaveBeenCalled();
    } finally {
      startup.mockRestore();
    }
  });
});

describe('Production replay construction ownership', () => {
  it('owns fresh runtime wrappers without global spies and restores own and inherited methods', async () => {
    const parent = { call: () => 'parent' };
    const parentSpy = vi.spyOn(parent, 'call');
    const originalImport = artifactFixture.importProductionTransformersArtifact;
    const methods: Array<{ target: object, descriptor: PropertyDescriptor | undefined }> = [];
    const importer = vi.spyOn(artifactFixture, 'importProductionTransformersArtifact').mockImplementationOnce(async args => {
      const runtime = await originalImport(args) as typeof import('@huggingface/transformers');
      for (const target of [runtime.AutoTokenizer, runtime.AutoProcessor, runtime.AutoModelForCausalLM, runtime.AutoModelForImageTextToText]) {
        methods.push({ target, descriptor: Object.getOwnPropertyDescriptor(target, 'from_pretrained') });
      }
      return runtime;
    });
    try {
      const harness = await createProviderReplayTestRuntime(mechanicsArguments({ generate: async () => {
        throw new Error('No inference in wrapper ownership control');
      } }));
      try {
        expect(methods).toHaveLength(4);
        expect(methods[0]!.descriptor).toBeDefined();
        expect(methods[2]!.descriptor).toBeUndefined();
        for (const { target } of methods) {
          expect(vi.isMockFunction(Reflect.get(target, 'from_pretrained'))).toBe(false);
          expect(Object.hasOwn(target, 'from_pretrained')).toBe(true);
        }
        await harness.service.loadDownloadedModel({ modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct' });
        expect(harness.service.getState().status).toBe('ready');
        expect(harness.observations.modelLoadCalls).toEqual(['AutoModelForCausalLM']);
      } finally {
        await harness.close();
      }
      for (const { target, descriptor } of methods) {
        expect(Object.getOwnPropertyDescriptor(target, 'from_pretrained')).toEqual(descriptor);
      }
      expect(parent.call).toBe(parentSpy);
      expect(parent.call()).toBe('parent');
      expect(parentSpy).toHaveBeenCalledExactlyOnceWith();
    } finally {
      importer.mockRestore();
      parentSpy.mockRestore();
    }
  }, 30_000);

  it('keeps the setup error and restores parent globals even when a spy restoration throws', async () => {
    const artifact = await artifactFixture.getProductionTransformersArtifact();
    const ort = await import(/* @vite-ignore */ artifact.ortWebGpuUrl);
    const parentFetch = vi.fn<typeof fetch>(async () => {
      throw new Error('Parent-owned forbidden transport');
    });
    vi.stubGlobal('fetch', parentFetch);
    const primary = new Error('Primary artifact import failure');
    const secondary = new Error('Secondary spy restoration failure');
    const throwingRestore = vi.fn(() => {
      throw secondary;
    });
    let restoreOwnedSpy: (() => void) | undefined;
    const importer = vi.spyOn(artifactFixture, 'importProductionTransformersArtifact').mockImplementationOnce(async () => {
      const ownedSpy = ort.InferenceSession.create;
      if (!vi.isMockFunction(ownedSpy)) throw new Error('Fixture did not reach its ORT replacement boundary');
      restoreOwnedSpy = ownedSpy.mockRestore.bind(ownedSpy);
      ownedSpy.mockRestore = throwingRestore;
      throw primary;
    });
    try {
      await expect(createProviderReplayTestRuntime(mechanicsArguments({ generate: async () => {
        throw new Error('Not reached');
      } }))).rejects.toBe(primary);
      expect(throwingRestore).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toBe(parentFetch);
      expect(parentFetch).not.toHaveBeenCalled();
    } finally {
      restoreOwnedSpy?.();
      importer.mockRestore();
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it('rolls back globals, object-URL platform and the ORT spy after artifact import fails', async () => {
    const artifact = await artifactFixture.getProductionTransformersArtifact();
    const ort = await import(/* @vite-ignore */ artifact.ortWebGpuUrl);
    const factory = ort.InferenceSession.create;
    const before = {
      fetch: globalThis.fetch, navigator: globalThis.navigator, Blob: globalThis.Blob,
      crypto: globalThis.crypto, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL,
      self: Object.getOwnPropertyDescriptor(globalThis, 'self'),
    };
    const failure = new Error('Synthetic native artifact import failure');
    const importer = vi.spyOn(artifactFixture, 'importProductionTransformersArtifact').mockRejectedValueOnce(failure);
    try {
      await expect(createProviderReplayTestRuntime(mechanicsArguments({ generate: async () => {
        throw new Error('Not reached');
      } }))).rejects.toBe(failure);
      expect(ort.InferenceSession.create).toBe(factory);
      expect(globalThis.fetch).toBe(before.fetch);
      expect(globalThis.navigator).toBe(before.navigator);
      expect(globalThis.Blob).toBe(before.Blob);
      expect(globalThis.crypto).toBe(before.crypto);
      expect(URL.createObjectURL).toBe(before.createObjectURL);
      expect(URL.revokeObjectURL).toBe(before.revokeObjectURL);
      expect(Object.getOwnPropertyDescriptor(globalThis, 'self')).toEqual(before.self);
    } finally {
      importer.mockRestore();
      // Also clean the pre-fix failure so it cannot contaminate another case.
      if (vi.isMockFunction(ort.InferenceSession.create)) ort.InferenceSession.create.mockRestore();
      vi.unstubAllGlobals();
    }
  }, 30_000);

  it('removes owned module mocks when Provider import fails after their registration', async () => {
    const failure = new Error('Synthetic Provider evaluation failure');
    const beforeFetch = globalThis.fetch;
    const originalImport = artifactFixture.importProductionTransformersArtifact;
    const methods: Array<{ target: object, descriptor: PropertyDescriptor | undefined }> = [];
    const importer = vi.spyOn(artifactFixture, 'importProductionTransformersArtifact').mockImplementationOnce(async args => {
      const runtime = await originalImport(args) as typeof import('@huggingface/transformers');
      for (const target of [runtime.AutoTokenizer, runtime.AutoProcessor, runtime.AutoModelForCausalLM, runtime.AutoModelForImageTextToText]) {
        methods.push({ target, descriptor: Object.getOwnPropertyDescriptor(target, 'from_pretrained') });
      }
      return runtime;
    });
    vi.doMock('@/features/transformers-js/provider-hosted', () => {
      throw failure;
    });
    try {
      // Vitest wraps a rejected module factory, preserving its cause. That
      // upstream wrapper must not be replaced by a cleanup error either.
      await expect(createProviderReplayTestRuntime(mechanicsArguments({ generate: async () => {
        throw new Error('Not reached');
      } }))).rejects.toMatchObject({ cause: failure });
      const actual = await vi.importActual<typeof import('@/utils/worker-transport')>('@/utils/worker-transport');
      const imported = await import('@/utils/worker-transport');
      expect(imported.exposeWorkerRemote).toBe(actual.exposeWorkerRemote);
      expect(globalThis.fetch).toBe(beforeFetch);
      expect(methods).toHaveLength(4);
      for (const { target, descriptor } of methods) {
        expect(Object.getOwnPropertyDescriptor(target, 'from_pretrained')).toEqual(descriptor);
      }
    } finally {
      importer.mockRestore();
      vi.doUnmock('@/features/transformers-js/provider-hosted');
      vi.doUnmock('@huggingface/transformers');
      vi.doUnmock('@/utils/worker-transport');
      vi.doUnmock('@/features/transformers-js/runtime/import-production-runtime-module');
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  }, 30_000);
});

describe('Production replay native inference boundary', () => {
  it('rejects a same-shape attention mask before calling the injected inference callback', async () => {
    let invocation: Parameters<ProviderReplayGenerate>[0] | undefined;
    const generate = vi.fn<ProviderReplayGenerate>(async value => {
      invocation = value;
      throw new Error('Synthetic inference inspection');
    });
    const harness = await createProviderReplayTestRuntime(mechanicsArguments({ generate }));
    try {
      await expect(harness.provider.chat({ model: 'HuggingFaceTB/SmolLM2-135M-Instruct', messages: [{ role: 'user', content: 'Synthetic mechanics probe' }], onChunk: () => undefined })).rejects.toThrow('Synthetic inference inspection');
      if (!invocation) throw new Error('Actual inference was not reached');
      const captured = invocation;
      const tensor = captured.options.attention_mask;
      if (!(tensor instanceof harness.runtime.Tensor)) throw new Error('Expected actual tokenizer attention mask');
      generate.mockClear();
      await expect(async () => captured.model.generate({ ...captured.options, attention_mask: {
        type: tensor.type, dims: [...tensor.dims], data: tensor.data, location: tensor.location,
      } })).rejects.toThrow('Replay requires actual Tensor: attention_mask');
      expect(generate).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('rejects a same-shape input object before calling the injected inference callback', async () => {
    let invocation: Parameters<ProviderReplayGenerate>[0] | undefined;
    const generate = vi.fn<ProviderReplayGenerate>(async value => {
      invocation = value;
      throw new Error('Synthetic inference inspection');
    });
    const harness = await createProviderReplayTestRuntime(mechanicsArguments({ generate }));
    try {
      await expect(harness.provider.chat({ model: 'HuggingFaceTB/SmolLM2-135M-Instruct', messages: [{ role: 'user', content: 'Synthetic mechanics probe' }], onChunk: () => undefined })).rejects.toThrow('Synthetic inference inspection');
      if (!invocation) throw new Error('Actual inference was not reached');
      const captured = invocation;
      const tensor = captured.options.input_ids;
      if (!(tensor instanceof harness.runtime.Tensor)) throw new Error('Expected actual tokenizer tensor');
      generate.mockClear();
      await expect(async () => captured.model.generate({ ...captured.options, input_ids: {
        type: tensor.type, dims: [...tensor.dims], data: tensor.data, location: tensor.location,
      } })).rejects.toThrow('Replay requires actual Tensor: input_ids');
      expect(generate).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  }, 30_000);
});

describe('Production replay Worker construction boundary', () => {
  it('reads capture once and preserves inherited once and signal options at the native endpoint', async () => {
    const started = Promise.withResolvers<void>();
    const worker = new ProviderReplayTestWorker({ start: async () => {
      started.resolve();
    } });
    await started.promise;
    const controller = new AbortController();
    const calls: string[] = [];
    let captureReads = 0;
    const options = Object.create({ once: true, signal: controller.signal }) as AddEventListenerOptions;
    Object.defineProperty(options, 'capture', { get: () => {
      captureReads++;
      return true;
    } });
    const once = () => calls.push('once');
    const aborted = () => calls.push('aborted');
    try {
      worker.endpoint.addEventListener('message', once, options);
      worker.channel.port2.dispatchEvent(new MessageEvent('message', { data: 'first' }));
      worker.channel.port2.dispatchEvent(new MessageEvent('message', { data: 'second' }));
      const abortOptions = Object.create({ signal: controller.signal }) as AddEventListenerOptions;
      worker.endpoint.addEventListener('message', aborted, abortOptions);
      controller.abort();
      worker.channel.port2.dispatchEvent(new MessageEvent('message', { data: 'after-abort' }));
      expect(captureReads).toBe(1);
      expect(calls).toEqual(['once']);
      expect(getEventListeners(worker.channel.port2, 'message')).not.toContain(once);
      expect(getEventListeners(worker.channel.port2, 'message')).not.toContain(aborted);
    } finally {
      worker.terminate();
    }
  });

  it('releases owned endpoint listeners by capture identity and prevents late registration after termination', async () => {
    const started = Promise.withResolvers<void>();
    const worker = new ProviderReplayTestWorker({ start: async () => {
      started.resolve();
    } });
    await started.promise;
    const listener = () => {};
    const mutableOptions = { capture: false };
    try {
      worker.endpoint.addEventListener('message', listener, mutableOptions);
      worker.endpoint.addEventListener('message', listener, true);
      worker.endpoint.removeEventListener('message', listener, true);
      expect(getEventListeners(worker.channel.port2, 'message').filter(item => item === listener)).toHaveLength(1);
      // The native registration captured false, regardless of later mutation.
      mutableOptions.capture = true;
      worker.terminate();
      worker.terminate();
      expect(getEventListeners(worker.channel.port2, 'message')).not.toContain(listener);
      worker.endpoint.addEventListener('message', listener);
      expect(getEventListeners(worker.channel.port2, 'message')).not.toContain(listener);
      expect(worker.hostMessages).toEqual([]);
      expect(worker.workerMessages).toEqual([]);
    } finally {
      worker.terminate();
    }
  });

  it('preserves native clone errors but discards valid sends after physical termination', async () => {
    const started = Promise.withResolvers<void>();
    const worker = new ProviderReplayTestWorker({ start: async () => {
      started.resolve();
    } });
    await started.promise;
    worker.terminate();
    expect(() => worker.postMessage({ type: 'RELEASE', id: 'synthetic-closed-port' }, [])).not.toThrow();
    expect(() => worker.postMessage(() => {}, [])).toThrow(expect.objectContaining({ name: 'DataCloneError' }));
    expect(worker.hostMessages).toEqual([]);
    expect(worker.workerMessages).toEqual([]);
  });

  it('does not retain listeners added by an already-started entry after termination', async () => {
    const entered = Promise.withResolvers<void>();
    const continueStartup = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    const listener = () => {};
    const worker = new ProviderReplayTestWorker({ start: async ({ worker }) => {
      entered.resolve();
      await continueStartup.promise;
      worker.endpoint.addEventListener('message', listener);
      completed.resolve();
    } });
    try {
      await entered.promise;
      worker.terminate();
      continueStartup.resolve();
      await completed.promise;
      expect(worker.terminated).toBe(true);
      expect(getEventListeners(worker.channel.port2, 'message')).not.toContain(listener);
      expect(worker.hostMessages).toEqual([]);
      expect(worker.workerMessages).toEqual([]);
    } finally {
      continueStartup.resolve();
      worker.terminate();
    }
  });

  it('delivers the original asynchronous startup error before cleanup', async () => {
    const failure = new Error('Synthetic replay entry startup failure');
    const delivered = Promise.withResolvers<unknown>();
    const worker = new ProviderReplayTestWorker({ start: async () => {
      throw failure;
    } });
    worker.addEventListener('error', event => delivered.resolve((event as MessageEvent).data));
    try {
      expect(await delivered.promise).toBe(failure);
      expect(worker.hostMessages).toEqual([]);
      expect(worker.workerMessages).toEqual([]);
    } finally {
      worker.terminate();
    }
  });

  it('rejects a foreign first entry before creating channels or scheduling Production startup', async () => {
    const started = Promise.withResolvers<void>();
    const start = vi.fn(async () => started.resolve());
    const onConstructed = vi.fn();
    const scriptUrl = new URL('../../worker/bootstrap.ts', import.meta.url);
    const Worker = createProviderReplayTestWorkerConstructor({ scriptUrl, start, onConstructed });
    expect(() => new Worker(new URL('../../worker/entry.ts', import.meta.url), { type: 'module' })).toThrow('Unexpected replay Worker script');
    expect(onConstructed).not.toHaveBeenCalled();
    const worker = new Worker(scriptUrl, { type: 'module' });
    try {
      await started.promise; // Observe the explicit startup event, not an RPC/callback drain.
      expect(start).toHaveBeenCalledOnce();
      expect(onConstructed).toHaveBeenCalledOnce();
      expect(worker.workerMessages).toEqual([]); // The factory never invents ready.
      expect(() => new Worker(scriptUrl, { type: 'module' })).toThrow('unexpected restart or Download');
      expect(onConstructed).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledOnce();
    } finally {
      worker.terminate();
    }
  });

  it('rejects classic mode for the exact Production bootstrap before startup', () => {
    const start = vi.fn(async () => undefined);
    const onConstructed = vi.fn();
    const scriptUrl = new URL('../../worker/bootstrap.ts', import.meta.url);
    const Worker = createProviderReplayTestWorkerConstructor({ scriptUrl, start, onConstructed });
    expect(() => new Worker(scriptUrl, { type: 'classic' })).toThrow();
    expect(start).not.toHaveBeenCalled();
    expect(onConstructed).not.toHaveBeenCalled();
  });

  it('rejects unrecorded constructor options rather than silently discarding their behavior', () => {
    const scriptUrl = new URL('../../worker/bootstrap.ts', import.meta.url);
    const start = vi.fn(async () => undefined);
    const onConstructed = vi.fn();
    const Worker = createProviderReplayTestWorkerConstructor({ scriptUrl, start, onConstructed });
    expect(() => new Worker(scriptUrl, { type: 'module', name: 'em-pthread' })).toThrow();
    expect(start).not.toHaveBeenCalled();
    expect(onConstructed).not.toHaveBeenCalled();
  });
});

describe('Production replay runtime mechanics, not captured model semantics', () => {
  it('keeps the real Provider settlement observation unchanged when the bounded trace is enabled', async () => {
    type Callbacks = Pick<Parameters<LmProvider['chat']>[0], 'onChunk' | 'onAssistantMessageStart'>;
    async function run({ callbacks, onSettled }: { callbacks: Callbacks; onSettled: () => void }) {
      const generate = vi.fn<ProviderReplayGenerate>(async ({ options, tokenizer, runtime }) => {
        const input = options.input_ids;
        if (!(input instanceof runtime.Tensor) || !options.streamer) throw new Error('Expected actual strategy input and streamer');
        const output = tokenizer.encode('Synthetic output.', { add_special_tokens: false }).map(BigInt);
        // Exactly the synchronous native substitute used by the adjacent RED.
        // The real streamer, parser, Worker client and Provider still execute.
        options.streamer.put(input.tolist());
        for (const token of output) options.streamer.put([[token]]);
        options.streamer.end();
        return new runtime.Tensor('int64', BigInt64Array.from(output), [1, output.length]);
      });
      const harness = await createProviderReplayTestRuntime(mechanicsArguments({ generate }));
      try {
        await harness.provider.chat({
          model: 'HuggingFaceTB/SmolLM2-135M-Instruct',
          messages: [{ role: 'user', content: 'Synthetic mechanics probe' }],
          ...callbacks,
        });
        // Measure inside the same direct-await continuation for both runs.
        // Cleanup and this helper's own Promise resolution occur afterwards.
        onSettled();
        expect(generate).toHaveBeenCalledOnce();
        expect(harness.observations.workers).toHaveLength(1);
        expect(harness.observations.forbiddenTransport).toEqual([]);
        expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      } finally {
        await harness.close();
      }
    }
    const baselineEvents: Array<{ kind: 'assistant-start' } | { kind: 'chunk'; chunk: string }> = [];
    let baselineAtSettlement: typeof baselineEvents = [];
    await run({
      callbacks: {
        onAssistantMessageStart: () => {
          baselineEvents.push({ kind: 'assistant-start' });
        },
        onChunk: ({ chunk }) => {
          baselineEvents.push({ kind: 'chunk', chunk });
        },
      },
      onSettled: () => {
        baselineAtSettlement = baselineEvents.slice();
      },
    });
    const trace = createProductionProviderTrace({
      requestId: 'synthetic-production-settlement', limits: { maximumEvents: 64, maximumCharacters: 4096 },
    });
    await run({
      callbacks: trace.callbacks,
      onSettled: () => {
        trace.settle({ outcome: 'fulfilled', error: undefined });
      },
    });
    const snapshot = trace.snapshot();
    if (snapshot.settled === undefined) throw new Error('Expected actual Provider settlement');
    expect(snapshot.settled.outcome).toEqual({ status: 'fulfilled' });
    expect(snapshot.settled.completeness).toBe('complete');
    expect(snapshot.settled.events.map(({ sequence: _sequence, phase: _phase, ...event }) => event)).toEqual(baselineAtSettlement);
    expect(snapshot.settled.events.map(event => event.sequence)).toEqual(baselineAtSettlement.map((_, index) => index));
    expect(snapshot.settled.events.every(event => event.phase === 'before-settlement')).toBe(true);
    // Equality here proves diagnostic non-repair, not successful delivery.
    // The adjacent contract independently demands the full output and stays RED.
    // Immediate test cleanup also does not certify that no late callbacks exist.
  }, 30_000);

  it('preserves real Comlink settlement and immediate next inputs inside the investigation Provider owner', async () => {
    type Trace = ReturnType<typeof createProductionProviderTrace>;
    type CapturedRequest = { input: Pick<CaptureRequestInput, 'messages'> | undefined; trace: ReturnType<Trace['snapshot']> };
    function comparableRequests({ requests }: { requests: readonly CapturedRequest[] }) {
      return requests.map(({ input, trace }) => ({
        messages: input?.messages,
        settled: trace.settled,
        lateEvents: trace.lateEvents,
        completeness: trace.completeness,
      }));
    }
    function createNativeBoundary() {
      const inputs: Array<{ ids: string[]; maxNewTokens: unknown }> = [];
      const outputs: Uint8Array[] = [];
      const generate: ProviderReplayGenerate = async ({ options, tokenizer, runtime }) => {
        const input = options.input_ids;
        if (!(input instanceof runtime.Tensor) || !options.streamer) throw new Error('Expected real input Tensor and streamer');
        inputs.push({ ids: Array.from(input.data, String), maxNewTokens: options.max_new_tokens });
        const output = tokenizer.encode('Synthetic output.', { add_special_tokens: false }).map(BigInt);
        outputs.push(new Uint8Array(BigInt64Array.from(output).buffer));
        // A scheduling control, not captured model inference: no timer or drain.
        // Actual tokenizer, streamer, parser, service and Comlink remain in place.
        options.streamer.put(input.tolist());
        for (const token of output) options.streamer.put([[token]]);
        options.streamer.end();
        return new runtime.Tensor('int64', BigInt64Array.from(output), [1, output.length]);
      };
      return { generate, inputs, outputs };
    }
    const baselineNative = createNativeBoundary();
    const baseline = await createProviderReplayTestRuntime(mechanicsArguments({ generate: baselineNative.generate }));
    let expectedRequests: ReturnType<typeof comparableRequests> = [];
    try {
      const requests: CapturedRequest[] = [];
      let firstSettledText = '';
      for (const scenario of ['first', 'continuity', 'independent'] as const) {
        const messages: Array<{ role: 'user' | 'assistant'; content: string }> = scenario === 'continuity'
          ? [
            { role: 'user', content: 'Template probe user message.' },
            { role: 'assistant', content: firstSettledText },
            { role: 'user', content: 'Continue the synthetic conversation with a short response.' },
          ]
          : [{ role: 'user', content: scenario === 'first' ? 'Template probe user message.' : 'A separate synthetic capture conversation.' }];
        const trace = createProductionProviderTrace({ requestId: scenario, limits: { maximumEvents: 64, maximumCharacters: 4096 } });
        await baseline.provider.chat({
          model: 'HuggingFaceTB/SmolLM2-135M-Instruct', messages, tools: [], ...trace.callbacks,
          parameters: {
            temperature: 0, topP: 1, maxCompletionTokens: scenario === 'independent' ? 1 : 16,
            presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined },
          },
        });
        const settled = trace.settle({ outcome: 'fulfilled', error: undefined });
        if (scenario === 'first') firstSettledText = settled.events.filter(event => event.kind === 'chunk').map(event => event.chunk).join('');
        // Keep live trace access, not a post-hoc repaired settlement or history.
        requests.push({ input: { messages }, get trace() {
          return trace.snapshot();
        } });
      }
      expectedRequests = comparableRequests({ requests });
      expect(baseline.observations.workers).toHaveLength(1);
      expect(baseline.observations.forbiddenTransport).toEqual([]);
      expect(baseline.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await baseline.close();
    }

    const capturedNative = createNativeBoundary();
    const captured = await createProviderReplayTestRuntime(mechanicsArguments({ generate: capturedNative.generate }));
    // Import after the harness's module isolation, so both owned and normal
    // services see the same real hosted implementation and browser substitute.
    const { createProductionProviderCaptureOwner } = await import('@/features/transformers-js/model-support-investigation/logic/production-provider-capture-owner');
    const { createTransformersJsGenerationCaptureClient } = await import('@/features/transformers-js/worker/client-hosted');
    const captures: Array<ReturnType<typeof createTransformersJsGenerationCaptureClient>> = [];
    const owner: ReturnType<typeof createProductionProviderCaptureOwner> = createProductionProviderCaptureOwner({
      runId: 'synthetic-owner-comlink', modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      plan: 'first-continuity-independent',
      createWorkerClient: () => {
        const capture = createTransformersJsGenerationCaptureClient({
          runId: 'synthetic-owner-comlink', workerEpoch: captures.length + 1,
          getActiveRequest: () => owner.getActiveRequest(),
          limits: { maxCalls: 8, maxInvocationsPerCall: 4, maxEvents: 256, maxTextBytes: 8192, maxTensorBytes: 8192, maxTotalTensorBytes: 65536, maxTokensPerStreamEvent: 4096, maxTotalStreamTokens: 16384, maxTotalStreamTokenBytes: 262144 },
        });
        captures.push(capture);
        return capture.client;
      },
      traceLimits: { maximumEvents: 64, maximumCharacters: 4096 },
    });
    try {
      const snapshot = await owner.run();
      expect(snapshot.run).toEqual({ status: 'completed' });
      expect(snapshot.requests.map(request => request.status)).toEqual(['settled', 'settled', 'settled']);
      expect(comparableRequests({ requests: snapshot.requests })).toEqual(expectedRequests);
      expect(capturedNative.inputs).toEqual(baselineNative.inputs);
      expect(capturedNative.inputs.map(input => input.maxNewTokens)).toEqual([16, 16, 1]);
      expect(captures).toHaveLength(1);
      const recorded = await captures[0]!.takeGenerationCapture();
      if (recorded.status !== 'captured') throw new Error(`Expected captured generation, received ${recorded.status}`);
      const identities = snapshot.requests.map((request, index) => ({
        runId: 'synthetic-owner-comlink', workerEpoch: 1, requestId: request.requestId, generationCallId: index + 1,
      }));
      expect(recorded.capture.calls).toEqual(identities.map(context => ({ context, loadIdentity: capturedSmolLoadIdentity, outcome: 'fulfilled', invocations: [{ nativeInvocationOrdinal: 1, stream: { status: 'available', restoration: 'restored' } }] })));
      expect(captures[0]!.getCaptureLifetime().issuedCalls).toEqual(identities);
      expect(captures[0]!.getCaptureLifetime().incompleteReasons).toEqual([]);
      expect(recorded.capture.incompleteReasons).toEqual([]);
      expect(recorded.capture.events.filter(event => event.kind === 'native-call')).toEqual(identities.flatMap(identity => [
        { kind: 'native-call', identity: { ...identity, nativeInvocationOrdinal: 1 }, phase: 'entering' },
        { kind: 'native-call', identity: { ...identity, nativeInvocationOrdinal: 1 }, phase: 'fulfilled' },
      ]));
      const nativeInputs = recorded.capture.events.filter(event => event.kind === 'inputs').filter(event => event.phase === 'native-kwargs');
      expect(nativeInputs.map(event => event.values.find(value => value.name === 'input_ids')?.snapshot)).toEqual(baselineNative.inputs.map(input => {
        const bytes = new Uint8Array(BigInt64Array.from(input.ids.map(BigInt)).buffer);
        return { status: 'captured', dtype: 'int64', dims: [1, input.ids.length], byteLength: bytes.byteLength, bytes };
      }));
      expect(recorded.capture.events.filter(event => event.kind === 'settings').map(event => event.value.kwargs.maxNewTokens)).toEqual([
        { status: 'value', value: 16 }, { status: 'value', value: 16 }, { status: 'value', value: 1 },
      ]);
      expect(recorded.capture.events.filter(event => event.kind === 'sequence')).toEqual(identities.map((identity, index) => {
        const bytes = baselineNative.outputs[index]!;
        return {
          kind: 'sequence', identity: { ...identity, nativeInvocationOrdinal: 1 }, resultShape: 'tensor',
          snapshot: { status: 'captured', dtype: 'int64', dims: [1, bytes.byteLength / 8], byteLength: bytes.byteLength, bytes },
        };
      }));
      expect(recorded.capture.unobserved).toEqual(['native-stop-cause', 'native-forward-input', 'kv-bytes']);
      expect(owner.snapshot().requests.map(request => request.trace.settled)).toEqual(snapshot.requests.map(request => request.trace.settled));
      await expect(captures[0]!.takeGenerationCapture()).resolves.toEqual({ status: 'already-taken' });
      expect(captured.observations.workers).toHaveLength(1);
      expect(captured.service.getState().status).toBe('idle');
      expect(captured.observations.forbiddenTransport).toEqual([]);
      expect(captured.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Equality demonstrates non-repair and owner isolation, not successful
      // delivery. The independent full-output contract below must stay RED.
    } finally {
      try {
        await owner.dispose();
      } finally {
        await captured.close();
      }
    }
  }, 30_000);

  it('retains the rejected real Provider request without starting later capture scenarios', async () => {
    const generate = vi.fn<ProviderReplayGenerate>(async () => {
      throw new Error('Synthetic native failure after real input preparation');
    });
    const harness = await createProviderReplayTestRuntime(mechanicsArguments({ generate }));
    const { createProductionProviderCaptureOwner } = await import('@/features/transformers-js/model-support-investigation/logic/production-provider-capture-owner');
    const { createTransformersJsGenerationCaptureClient } = await import('@/features/transformers-js/worker/client-hosted');
    const captures: Array<ReturnType<typeof createTransformersJsGenerationCaptureClient>> = [];
    const owner: ReturnType<typeof createProductionProviderCaptureOwner> = createProductionProviderCaptureOwner({
      runId: 'synthetic-owner-rejected', modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      plan: 'first-continuity-independent',
      createWorkerClient: () => {
        const capture = createTransformersJsGenerationCaptureClient({
          runId: 'synthetic-owner-rejected', workerEpoch: captures.length + 1,
          getActiveRequest: () => owner.getActiveRequest(),
          limits: { maxCalls: 8, maxInvocationsPerCall: 4, maxEvents: 256, maxTextBytes: 8192, maxTensorBytes: 8192, maxTotalTensorBytes: 65536, maxTokensPerStreamEvent: 4096, maxTotalStreamTokens: 16384, maxTotalStreamTokenBytes: 262144 },
        });
        captures.push(capture);
        return capture.client;
      },
      traceLimits: { maximumEvents: 64, maximumCharacters: 4096 },
    });
    try {
      const snapshot = await owner.run();
      expect(snapshot.run).toEqual({ status: 'stopped', reason: 'provider-rejected' });
      expect(snapshot.requests.map(request => request.status)).toEqual(['settled', 'not-started', 'not-started']);
      expect(snapshot.requests[0]?.input?.messages).toEqual([{ role: 'user', content: 'Template probe user message.' }]);
      // Actual Comlink deserialization assigns an own name to the Error. Keep
      // that allowlisted name, but not its message, stack or guessed origin.
      expect(snapshot.requests[0]?.trace.settled?.outcome).toEqual({ status: 'rejected', errorName: 'Error' });
      expect(snapshot.requests.slice(1).map(request => ({ input: request.input, settled: request.trace.settled, events: request.trace.events })))
        .toEqual([{ input: undefined, settled: undefined, events: [] }, { input: undefined, settled: undefined, events: [] }]);
      expect(generate).toHaveBeenCalledOnce();
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(captures).toHaveLength(1);
      const recorded = await captures[0]!.takeGenerationCapture();
      if (recorded.status !== 'captured') throw new Error(`Expected partial native capture, received ${recorded.status}`);
      const identity = {
        runId: 'synthetic-owner-rejected', workerEpoch: 1,
        requestId: snapshot.requests[0]!.requestId, generationCallId: 1,
      };
      expect(recorded.capture.calls).toEqual([{ context: identity, loadIdentity: capturedSmolLoadIdentity, outcome: 'rejected', invocations: [
        { nativeInvocationOrdinal: 1, stream: { status: 'available', restoration: 'restored' } },
      ] }]);
      expect(recorded.capture.events.filter(event => event.kind === 'native-call')).toEqual([
        { kind: 'native-call', identity: { ...identity, nativeInvocationOrdinal: 1 }, phase: 'entering' },
        { kind: 'native-call', identity: { ...identity, nativeInvocationOrdinal: 1 }, phase: 'rejected' },
      ]);
      expect(recorded.capture.events.filter(event => event.kind === 'inputs').map(event => event.phase)).toEqual(['pre-budget', 'native-kwargs']);
      expect(recorded.capture.events.filter(event => event.kind === 'sequence')).toEqual([]);
      expect(recorded.capture.incompleteReasons).toEqual([]);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.service.getState().status).toBe('idle');
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      try {
        await owner.dispose();
      } finally {
        await harness.close();
      }
    }
  }, 30_000);

  it('observes actual streamed callbacks at Provider settlement without a post-hoc drain', async () => {
    const harness = await createProviderReplayTestRuntime({
      imagePlatform: undefined,
      modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      expectedRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', cacheRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', metadataCache: "all-fixture",
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: new Uint8Array([1, 2, 3]) }],
      generate: async ({ options, tokenizer, runtime }) => {
        const input = options.input_ids;
        if (!(input instanceof runtime.Tensor) || !options.streamer) throw new Error('Expected actual strategy input and streamer');
        const output = tokenizer.encode('Synthetic output.', { add_special_tokens: false }).map(BigInt);
        // Synthetic transport probe, not captured inference. No timers, yields,
        // callback wrappers or returning a completed assistant response.
        options.streamer.put(input.tolist());
        for (const token of output) options.streamer.put([[token]]);
        options.streamer.end();
        return new runtime.Tensor('int64', BigInt64Array.from(output), [1, output.length]);
      },
    });
    try {
      const chunks: string[] = [];
      await harness.provider.chat({
        model: 'HuggingFaceTB/SmolLM2-135M-Instruct',
        messages: [{ role: 'user', content: 'Synthetic mechanics probe' }],
        onChunk: ({ chunk }) => chunks.push(chunk),
      });
      expect(chunks.join('')).toBe('Synthetic output.');
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('reaches injected inference only after actual Provider, Comlink, offline Load and tokenizer', async () => {
    const generate = vi.fn(async ({ options, tokenizer }: Parameters<import('./provider-replay-test-runtime').ProviderReplayGenerate>[0]) => {
      expect(options).toHaveProperty('input_ids');
      expect(options).toHaveProperty('streamer');
      expect(tokenizer.encode('Synthetic mechanics probe').length).toBeGreaterThan(0);
      throw new Error('Synthetic inference boundary reached');
    });
    const harness = await createProviderReplayTestRuntime({
      imagePlatform: undefined,
      modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct',
      expectedRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', cacheRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac', metadataCache: "all-fixture",
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: new Uint8Array([1, 2, 3]) }],
      generate,
    });
    try {
      const onChunk = vi.fn();
      await expect(harness.provider.chat({
        model: 'HuggingFaceTB/SmolLM2-135M-Instruct',
        messages: [{ role: 'user', content: 'Synthetic mechanics probe' }], onChunk,
      })).rejects.toThrow('Synthetic inference boundary reached');
      expect(generate).toHaveBeenCalledOnce();
      expect(onChunk).not.toHaveBeenCalled();
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => item.operation.startsWith('writer') || item.operation.startsWith('create') || item.operation === 'remove')).toEqual([]);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.ortCalls).toHaveLength(1);
    } finally {
      await harness.close();
    }
    expect(harness.observations.platform.blobs.size).toBe(0);
  }, 30_000);
});
