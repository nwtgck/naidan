import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createWorkflowImageProvider } from './local-image';
import { imageRequest, imageCandidate, imageResult } from '@/features/workflow/logic/image-generation.test-support';
import { artifactFixture } from '@/features/stable-diffusion-cpp-browser/test-fixtures';
import type { ImageClient } from '@/features/stable-diffusion-cpp-browser/worker/types';
import type { ModelInventory } from '@/features/stable-diffusion-cpp-browser/logic/model-candidates';
import { temporaryModelFiles } from '@/logic/temporary-model-files';

const mocks = vi.hoisted(() => ({
  configuration: undefined as unknown,
  inspect: vi.fn(),
  create: vi.fn(),
  jspi: vi.fn(),
  memory64: vi.fn(),
  profile: vi.fn(),
  generate: vi.fn<ImageClient['generate']>(),
  dispose: vi.fn(),
}));
vi.mock('@/features/image-generation/providers/local-environment', () => ({
  get rawConfiguration() {
    return mocks.configuration;
  },
  createImageEngineClient: mocks.create,
  inspectImageInventory: mocks.inspect,
  initialProfile: mocks.profile,
  supportsJspi: mocks.jspi,
  supportsMemory64: mocks.memory64,
}));

beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('File', NodeFile);
  mocks.configuration = { kind: 'available', sourceCommit: 'a'.repeat(40), artifacts: [artifactFixture()] };
  mocks.profile.mockReturnValue('webgpu-wasm32-asyncify');
  mocks.jspi.mockReturnValue(false);
  mocks.memory64.mockReturnValue(false);
  mocks.create.mockImplementation(() => ({ generate: mocks.generate, dispose: mocks.dispose }));
  mocks.inspect.mockImplementation(async () => ({ candidates: [imageCandidate({ overrides: {} })], issues: [] }));
  mocks.generate.mockImplementation(async () => imageResult({ width: 256, height: 256, compression: 'small' }));
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const provider = createWorkflowImageProvider({ directories: [{ directoryId: 'registered', directoryName: 'Models' }] });
  const controller = new AbortController();
  return {
    provider,
    controller,
    async [Symbol.asyncDispose]() {
      controller.abort();
      provider.close();
    },
  };
}

it('pins the inspected File snapshots and owns one client for sequential images in one run', async () => {
  await using test = fixture();
  const request = imageRequest(), onProgress = vi.fn();
  await test.provider.generate({ request, signal: test.controller.signal, onProgress });
  const first = mocks.generate.mock.calls[0]![0];
  await test.provider.generate({ request, signal: test.controller.signal, onProgress });
  expect(mocks.inspect).toHaveBeenCalledOnce();
  expect(mocks.create).toHaveBeenCalledOnce();
  expect(mocks.generate.mock.calls[1]![0].request.models[0]!.file).toBe(first.request.models[0]!.file);
  expect(first.onProgress).toBe(onProgress);
  expect(first.request).toMatchObject({ parameters: { prompt: 'A tree', seed: '42' }, debug: 'off', loras: [], artifact: artifactFixture() });
  expect(mocks.inspect.mock.calls[0]![0].hostDirectories).toEqual([{ directoryId: 'registered', directoryName: 'Models' }]);
  test.provider.close();
  test.provider.close();
  expect(mocks.dispose).toHaveBeenCalledOnce();
  await expect(test.provider.generate({ request, signal: test.controller.signal, onProgress })).rejects.toThrow('closed');
});

it('refuses unsupported runtime builds before inspecting any local files or creating an engine', async () => {
  await using test = fixture();
  mocks.configuration = { kind: 'unavailable', reason: 'standalone' };
  await expect(test.provider.generate({ request: imageRequest(), signal: test.controller.signal, onProgress: () => undefined })).rejects.toThrow('not included');
  expect(mocks.inspect).not.toHaveBeenCalled();
  expect(mocks.create).not.toHaveBeenCalled();
});

it('does not silently substitute a different runtime profile', async () => {
  await using test = fixture();
  const request = imageRequest();
  request.parameters.profile = 'webgpu-wasm64-jspi';
  await expect(test.provider.generate({ request, signal: test.controller.signal, onProgress: () => undefined })).rejects.toThrow('unavailable');
  expect(mocks.inspect).not.toHaveBeenCalled();
});

it('checks browser capabilities even when the selected artifact exists', async () => {
  await using test = fixture();
  const artifact = artifactFixture(), profile = 'webgpu-wasm64-jspi';
  mocks.configuration = { kind: 'available', sourceCommit: 'a'.repeat(40), artifacts: [{ ...artifact, profile, modulePath: artifact.modulePath.replace('webgpu-wasm32-asyncify', profile), wasmPath: artifact.wasmPath.replace('webgpu-wasm32-asyncify', profile) }] };
  const request = imageRequest();
  request.parameters.profile = profile;
  await expect(test.provider.generate({ request, signal: test.controller.signal, onProgress: () => undefined })).rejects.toThrow('unavailable');
  expect(mocks.inspect).not.toHaveBeenCalled();
});

it('does not create an engine when a model locator or a required component is missing', async () => {
  await using test = fixture();
  mocks.inspect.mockResolvedValue({ candidates: [], issues: [] });
  await expect(test.provider.generate({ request: imageRequest(), signal: test.controller.signal, onProgress: () => undefined })).rejects.toThrow('unavailable');
  expect(mocks.create).not.toHaveBeenCalled();
});

it('honors a stop delivered during inventory inspection before constructing an engine', async () => {
  await using test = fixture();
  const gate = Promise.withResolvers<ModelInventory>();
  mocks.inspect.mockReturnValue(gate.promise);
  using settle = {
    [Symbol.dispose]() {
      gate.resolve({ candidates: [imageCandidate({ overrides: {} })], issues: [] });
    },
  };
  void settle;
  const result = test.provider.generate({ request: imageRequest(), signal: test.controller.signal, onProgress: () => undefined });
  const assertion = expect(result).rejects.toThrow('stop');
  test.controller.abort(new Error('stop'));
  gate.resolve({ candidates: [imageCandidate({ overrides: {} })], issues: [] });
  await assertion;
  expect(mocks.create).not.toHaveBeenCalled();
});

it('awaits physical cancellation and disallows another generation or retirement in the meantime', async () => {
  await using test = fixture();
  const gate = Promise.withResolvers<Awaited<ReturnType<ImageClient['generate']>>>();
  mocks.generate.mockReturnValue(gate.promise);
  using settle = {
    [Symbol.dispose]() {
      gate.resolve({ cancelled: true, modelResident: false });
    },
  };
  void settle;
  const input = { request: imageRequest(), signal: test.controller.signal, onProgress: () => undefined };
  const running = test.provider.generate(input);
  const assertion = expect(running).rejects.toThrow('stop');
  await vi.waitFor(() => expect(mocks.generate).toHaveBeenCalledOnce());
  await expect(test.provider.generate(input)).rejects.toThrow('already');
  test.controller.abort(new Error('stop'));
  expect(() => test.provider.close()).toThrow('Await');
  expect(mocks.dispose).not.toHaveBeenCalled();
  gate.resolve(imageResult({ width: 256, height: 256, compression: 'small' }));
  await assertion;
  test.provider.close();
  expect(mocks.dispose).toHaveBeenCalledOnce();
});

it('rejects temporary root replacement during a scan rather than binding a same-named folder', async () => {
  await using test = fixture();
  const root = temporaryModelFiles.register({ directory: { rootName: 'workflow-fixture', files: [{ relativePath: 'model.gguf', file: new File([new Uint8Array(16)], 'model.gguf') }] }, signal: undefined });
  using cleanup = {
    [Symbol.dispose]() {
      temporaryModelFiles.remove({ rootPath: root.rootPath });
    },
  };
  void cleanup;
  mocks.inspect.mockImplementation(async () => {
    temporaryModelFiles.remove({ rootPath: root.rootPath });
    temporaryModelFiles.register({ directory: { rootName: root.rootName, files: [...root.files] }, signal: undefined });
    return { candidates: [], issues: [] };
  });
  await expect(test.provider.generate({ request: imageRequest(), signal: test.controller.signal, onProgress: () => undefined })).rejects.toThrow('changed during');
  expect(mocks.create).not.toHaveBeenCalled();
});

it('restores original temporary Files after worker inspection and does not assign publication authority', async () => {
  await using test = fixture();
  const file = new File([new Uint8Array(16)], 'model.gguf');
  const root = temporaryModelFiles.register({ directory: { rootName: 'workflow-fixture', files: [{ relativePath: 'model.gguf', file }] }, signal: undefined });
  using cleanup = {
    [Symbol.dispose]() {
      temporaryModelFiles.remove({ rootPath: root.rootPath });
    },
  };
  void cleanup;
  mocks.inspect.mockResolvedValue({ candidates: [imageCandidate({ overrides: { repositoryKey: root.rootPath } })], issues: [] });
  const request = imageRequest();
  request.model.primary.location = { kind: 'temp', path: root.rootPath + '/model.gguf' };
  await test.provider.generate({ request, signal: test.controller.signal, onProgress: () => undefined });
  expect(mocks.generate.mock.calls[0]![0].request.models[0]!.file).toBe(file);
  expect(mocks.generate.mock.calls[0]![0].request.models[0]!.modelFilesReuseKey).toBeUndefined();
});

it('does not repeat a failing disposal after clearing its owned handle', async () => {
  await using test = fixture();
  await test.provider.generate({ request: imageRequest(), signal: test.controller.signal, onProgress: () => undefined });
  mocks.dispose.mockImplementationOnce(() => {
    throw new Error('retirement failed');
  });
  expect(() => test.provider.close()).toThrow('retirement failed');
  test.provider.close();
  expect(mocks.dispose).toHaveBeenCalledOnce();
});

export const TEST_ONLY = {
};
