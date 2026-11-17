import { beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, shallowRef } from 'vue';
import { downloadJobKey, type DownloadJob } from '@/features/llama-cpp-browser/hugging-face/download-queue';
import type { DownloadSelection } from '@/features/llama-cpp-browser/hugging-face/types';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
import type { ModelDestination } from '@/features/llama-cpp-browser/runtime/model-destination';
import { useAudioTranscriptionModels } from './useAudioTranscriptionModels';

const mocks = vi.hoisted(() => ({
  inventory: vi.fn(),
  inspectStored: vi.fn(),
  inspectFile: vi.fn(),
  openStored: vi.fn(),
  inspectRepository: vi.fn(),
  enqueue: vi.fn(),
  installed: vi.fn(),
  importDirectories: vi.fn(),
  unsubscribe: vi.fn(),
  subscribe: vi.fn(),
  authorize: vi.fn(),
}));
const jobs = shallowRef<DownloadJob[]>([]);
const destination = shallowRef<ModelDestination>({ kind: 'opfs' });
vi.mock('@/features/llama-cpp-browser/composables/useModelDownloadDestination', () => ({ useModelDownloadDestination: () => ({ destination, authorize: mocks.authorize }) }));
vi.mock('@/features/llama-cpp-browser/composables/model-inventory', () => ({ listModelInventory: mocks.inventory }));
vi.mock('@/features/speech-cpp-browser/recognition/models', () => ({ inspectStoredSpeechRecognitionModel: mocks.inspectStored, openStoredSpeechRecognitionModel: mocks.openStored }));
vi.mock('@/features/speech-cpp-browser/recognition/model-file', () => ({ inspectSpeechRecognitionCandidate: mocks.inspectFile }));
vi.mock('@/features/llama-cpp-browser/hugging-face/metadata-session', () => ({ getMetadataSession: () => ({ inspect: mocks.inspectRepository }) }));
vi.mock('@/features/llama-cpp-browser/hugging-face/download-queue', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/download-queue')>(), getDownloadQueue: () => ({ jobs, enqueue: mocks.enqueue }) }));
vi.mock('@/features/llama-cpp-browser/hugging-face/storage', async importOriginal => ({ ...await importOriginal<typeof import('@/features/llama-cpp-browser/hugging-face/storage')>(), installedSelection: mocks.installed }));
vi.mock('@/features/llama-cpp-browser/logic/local-model-input', () => ({ importLocalModelDirectories: mocks.importDirectories }));
vi.mock('@/features/llama-cpp-browser/model-files', () => ({ llamaCppBrowserModelFiles: { subscribeModelList: mocks.subscribe } }));

const local: LocalModel = { modelId: 'hf.co/sakasegawa/Qwen3-ASR-0.6B-GGUF:Q8_0', size: 1024, importedAt: 0 };
const pinned: DownloadSelection = { repository: 'test/recognition', revision: 'a'.repeat(40), files: [{ path: 'recognition-Q8_0.gguf', size: 1024 }] };
const file = new File(['GGUF'], 'recognition.gguf');
const recognized = { kind: 'recognition', info: { name: file.name, bytes: 1024, architecture: 'qwen3-asr', task: 'recognition', sampleRate: 16000, requiredVersion: '1' } };
const defaultRepository = 'sakasegawa/Qwen3-ASR-0.6B-GGUF';
const q8 = { path: 'Qwen3-ASR-0.6B-Q8_0.gguf', size: 1024 };
const q4 = { path: 'Qwen3-ASR-0.6B-Q4_K_M.gguf', size: 512 };
const repositoryCatalog = {
  repository: defaultRepository,
  revision: 'b'.repeat(40),
  models: [{ label: 'Q8_0', size: q8.size, files: [q8] }, { label: 'Q4_K_M', size: q4.size, files: [q4] }],
  projectors: [],
};

function mountModels({ remembered }: { remembered: string | undefined }) {
  const scope = effectScope();
  const modelId = shallowRef(remembered);
  const rememberModel = vi.fn<Parameters<typeof useAudioTranscriptionModels>[0]['preference']['rememberModel']>(async saved => {
    modelId.value = saved.modelId;
  });
  const models = scope.run(() => useAudioTranscriptionModels({ preference: { modelId, rememberModel } }));
  if (models === undefined) {
    throw new Error('Missing models scope');
  }
  return {
    models,
    rememberModel,
    [Symbol.dispose]() {
      scope.stop();
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  jobs.value = [];
  destination.value = { kind: 'opfs' };
  mocks.authorize.mockImplementation(async ({ destination }: { destination: ModelDestination }) => ({ destination, expectedRoot: undefined }));
  mocks.inventory.mockResolvedValue([]);
  mocks.inspectStored.mockResolvedValue(recognized);
  mocks.inspectFile.mockResolvedValue(recognized);
  mocks.openStored.mockResolvedValue(file);
  mocks.subscribe.mockReturnValue(mocks.unsubscribe);
  mocks.installed.mockResolvedValue(local);
});

describe('Transcription model selection', () => {
  it('restores an uninstalled repository variant by model ID without contacting Hugging Face', async () => {
    const modelId = `hf.co/${defaultRepository}:Q4_K_M`;
    using mounted = mountModels({ remembered: modelId });
    expect(mounted.models.models.value.find(model => model.id === mounted.models.selectedId.value)?.availability).toBe('checking');
    await mounted.models.refresh();
    expect(mounted.models.selectedModelId.value).toBe(modelId);
    expect(mounted.models.selectedQuantizationLabel.value).toBe('Q4_K_M');
    expect(mounted.models.models.value.find(model => model.id === mounted.models.selectedId.value)?.availability).toBe('download_required');
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mounted.rememberModel).not.toHaveBeenCalled();
  });

  it('preselects the small bundled model without metadata or downloads', async () => {
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.refresh();
    expect(mounted.models.models.value).toHaveLength(4);
    expect(mounted.models.models.value[0]).toMatchObject({ label: 'Qwen3-ASR 0.6B', availability: 'download_required' });
    expect(mounted.models.selectedId.value).toBe(mounted.models.models.value[0]?.id);
    mounted.models.select({ id: mounted.models.models.value[1]?.id });
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('uses the installed equivalent of a suggestion and excludes other model formats', async () => {
    mocks.inventory.mockResolvedValue([local, { ...local, modelId: 'user/chat' }]);
    mocks.inspectStored.mockImplementation(async ({ modelId }: { modelId: string }) => modelId === local.modelId ? recognized : { kind: 'other' });
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.refresh();
    expect(mounted.models.models.value[0]?.availability).toBe('local');
    expect(mounted.models.models.value).toHaveLength(4);
    const canonicalId = mounted.models.selectedId.value;
    mounted.models.select({ id: `stored:${local.modelId}` });
    expect(mounted.models.selectedId.value).toBe(canonicalId);
    expect(mounted.models.models.value.some(model => model.label === 'user/chat')).toBe(false);
    await expect(mounted.models.openSelected({ signal: new AbortController().signal })).resolves.toEqual({ modelId: local.modelId, file });
    expect(mocks.openStored).toHaveBeenCalledWith(expect.objectContaining({ modelId: local.modelId }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
  });

  it('waits for initial header inspection before opening an already stored candidate', async () => {
    const header = Promise.withResolvers<typeof recognized>();
    using release = {
      [Symbol.dispose]() {
        header.resolve(recognized);
      },
    };
    mocks.inventory.mockResolvedValue([local]);
    mocks.inspectStored.mockReturnValue(header.promise);
    using mounted = mountModels({ remembered: undefined });
    const pending = mounted.models.openSelected({ signal: new AbortController().signal });
    await vi.waitFor(() => expect(mocks.inspectStored).toHaveBeenCalledOnce());
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    header.resolve(recognized);
    await expect(pending).resolves.toEqual({ modelId: local.modelId, file });
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    void release;
  });

  it('rechecks the captured background candidate after initial inspection without changing selection', async () => {
    const header = Promise.withResolvers<typeof recognized>();
    using release = {
      [Symbol.dispose]() {
        header.resolve(recognized);
      },
    };
    mocks.inventory.mockResolvedValue([local]);
    mocks.inspectStored.mockReturnValue(header.promise);
    using mounted = mountModels({ remembered: undefined });
    const id = mounted.models.models.value[0]?.id;
    if (id === undefined) {
      throw new Error('Missing default model');
    }
    const pending = mounted.models.backgroundDownload({ id });
    const duplicate = mounted.models.backgroundDownload({ id });
    const nextId = mounted.models.models.value[1]?.id;
    mounted.models.select({ id: nextId });
    destination.value = { kind: 'host', directoryId: 'another-folder' };
    await vi.waitFor(() => expect(mocks.inspectStored).toHaveBeenCalledOnce());
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    header.resolve(recognized);
    await pending;
    await duplicate;
    expect(mounted.models.selectedId.value).toBe(nextId);
    expect(mounted.models.models.value[0]?.availability).toBe('local');
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.openStored).not.toHaveBeenCalled();
    void release;
  });

  it('cancels an initial inventory wait before any model network or write permission action', async () => {
    const header = Promise.withResolvers<typeof recognized>();
    using release = {
      [Symbol.dispose]() {
        header.resolve(recognized);
      },
    };
    mocks.inventory.mockResolvedValue([local]);
    mocks.inspectStored.mockReturnValue(header.promise);
    using mounted = mountModels({ remembered: undefined });
    const controller = new AbortController();
    const pending = mounted.models.openSelected({ signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(mocks.inspectStored).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(mounted.models.busy.value).toBe(false);
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    void release;
  });

  it('does not enqueue a background action when its view closes during initial inspection', async () => {
    const header = Promise.withResolvers<typeof recognized>();
    using release = {
      [Symbol.dispose]() {
        header.resolve(recognized);
      },
    };
    mocks.inventory.mockResolvedValue([local]);
    mocks.inspectStored.mockReturnValue(header.promise);
    using mounted = mountModels({ remembered: undefined });
    const id = mounted.models.models.value[0]?.id;
    if (id === undefined) {
      throw new Error('Missing default model');
    }
    const pending = mounted.models.backgroundDownload({ id });
    await vi.waitFor(() => expect(mocks.inspectStored).toHaveBeenCalledOnce());
    mounted[Symbol.dispose]();
    await pending;
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.authorize).not.toHaveBeenCalled();
    void release;
  });

  it('does not infer repository identity from an imported filename', async () => {
    mocks.inventory.mockResolvedValue([{ ...local, modelId: 'user/Qwen3-ASR-0.6B-Q8_0' }]);
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.refresh();
    expect(mounted.models.models.value[0]?.availability).toBe('download_required');
    expect(mounted.models.models.value.some(model => model.label === 'user/Qwen3-ASR-0.6B-Q8_0')).toBe(true);
  });

  it('resolves and downloads the selected suggestion only when Run opens it', async () => {
    const repository = 'sakasegawa/Qwen3-ASR-0.6B-GGUF';
    const selection = { ...pinned, repository };
    mocks.inspectRepository.mockResolvedValue({ ...selection, models: [{ label: 'Q8_0', size: 1024, files: selection.files }], projectors: [] });
    mocks.enqueue.mockImplementation(({ prepare }: { prepare({ signal }: { signal: AbortSignal }): Promise<DownloadSelection> }) => ({
      id: 42,
      done: prepare({ signal: new AbortController().signal }).then(resolved => ({ id: 42, status: 'complete', selection: resolved, destination: { kind: 'opfs' } })),
    }));
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.refresh();
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
    await expect(mounted.models.openSelected({ signal: new AbortController().signal })).resolves.toEqual({ modelId: local.modelId, file });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ repository, source: 'suggestion' }));
    expect(mocks.inspectRepository).toHaveBeenCalledWith(expect.objectContaining({ input: repository }));
    expect(mocks.installed).toHaveBeenCalledWith(expect.objectContaining({ selection }));
  });

  it('pins an explicitly chosen repository file without downloading on selection', async () => {
    using mounted = mountModels({ remembered: undefined });
    mounted.models.addRepositoryModel({ selection: pinned });
    const selected = mounted.models.selectedId.value;
    mounted.models.addRepositoryModel({ selection: { ...pinned } });
    expect(mounted.models.selectedId.value).toBe(selected);
    expect(mounted.models.models.value).toHaveLength(5);
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
    await expect(mounted.models.openSelected({ signal: new AbortController().signal })).resolves.toEqual({ modelId: local.modelId, file });
    expect(mocks.installed).toHaveBeenCalledWith(expect.objectContaining({ selection: pinned }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mounted.models.models.value.find(model => model.id === selected)?.availability).toBe('local');
  });

  it.each(['failed', 'paused', 'cancelled'] as const)('does not load a model after a %s download', async status => {
    mocks.enqueue.mockReturnValue({ id: 42, done: Promise.resolve({ status, selection: pinned }) });
    using mounted = mountModels({ remembered: undefined });
    await expect(mounted.models.openSelected({ signal: new AbortController().signal })).rejects.toThrow('did not complete');
    expect(mocks.openStored).not.toHaveBeenCalled();
    expect(mounted.models.failure.value).toBe('model');
    expect(mounted.models.busy.value).toBe(false);
  });

  it('stops the waiting run on abort while leaving its shared download available', async () => {
    const gate = Promise.withResolvers<DownloadJob>();
    mocks.enqueue.mockReturnValue({ id: 42, done: gate.promise });
    using mounted = mountModels({ remembered: undefined });
    const controller = new AbortController();
    const pending = mounted.models.openSelected({ signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    gate.resolve({ id: 42, key: 'test', repository: pinned.repository, source: 'repository', destination: { kind: 'opfs' }, status: 'complete', selection: pinned, progress: undefined, error: undefined });
    expect(mocks.openStored).not.toHaveBeenCalled();
    expect(mounted.models.failure.value).toBeUndefined();
    expect(mounted.models.busy.value).toBe(false);
  });

  it('imports and selects a local recognition model without network access', async () => {
    mocks.importDirectories.mockResolvedValue([local]);
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.refresh();
    await mounted.models.importModels({ directories: Promise.resolve([{ rootName: 'recognition', files: [{ relativePath: file.name, file }] }]), controller: new AbortController(), save: 'later', repositoryLayout: 'confirmed' });
    expect(mocks.importDirectories).toHaveBeenCalledWith(expect.objectContaining({ save: 'later' }));
    expect(mounted.models.models.value.find(model => model.id === mounted.models.selectedId.value)?.availability).toBe('local');
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a model with companions before importing it', async () => {
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.importModels({ directories: Promise.resolve([{ rootName: 'recognition', files: [{ relativePath: file.name, file }, { relativePath: 'companion.gguf', file }] }]), controller: new AbortController(), save: 'browser', repositoryLayout: 'confirmed' });
    expect(mocks.importDirectories).not.toHaveBeenCalled();
    expect(mounted.models.failure.value).toBe('import');
  });

  it('shows only the known repository before an explicit metadata request', async () => {
    using mounted = mountModels({ remembered: undefined });
    expect(mounted.models.canInspectQuantizations.value).toBe(true);
    expect(mounted.models.quantizations.value).toEqual([]);
    expect(mounted.models.selectedQuantizationLabel.value).toBe('Q8_0');
    expect(mounted.models.selectedDetails.value).toEqual({ kind: 'huggingface', repository: defaultRepository, repositoryUrl: `https://huggingface.co/${defaultRepository}`, revision: undefined, files: undefined });
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('lists real single-file quantizations and keeps the existing default after explicit inspection', async () => {
    mocks.inspectRepository.mockResolvedValue({ ...repositoryCatalog, models: [...repositoryCatalog.models, { label: 'F16', size: 2048, files: [{ path: 'model-F16-00001-of-00002.gguf', size: 1024 }, { path: 'model-F16-00002-of-00002.gguf', size: 1024 }] }] });
    using mounted = mountModels({ remembered: undefined });
    const initialId = mounted.models.selectedId.value;
    await mounted.models.inspectSelectedQuantizations({ signal: new AbortController().signal });
    expect(mocks.inspectRepository).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ input: defaultRepository }));
    expect(mounted.models.quantizations.value).toEqual([{ id: q4.path, label: 'Q4_K_M', filePath: q4.path, bytes: q4.size }, { id: q8.path, label: 'Q8_0', filePath: q8.path, bytes: q8.size }]);
    expect(mounted.models.selectedQuantizationId.value).toBe(q8.path);
    expect(mounted.models.selectedId.value).toBe(initialId);
    expect(mounted.models.selectedDetails.value).toEqual({ kind: 'huggingface', repository: defaultRepository, repositoryUrl: `https://huggingface.co/${defaultRepository}`, revision: repositoryCatalog.revision, files: [{ name: q8.path, bytes: q8.size, url: `https://huggingface.co/${defaultRepository}/resolve/${repositoryCatalog.revision}/${q8.path}` }] });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('runs an explicitly selected quantization with its pinned files and no second metadata request', async () => {
    mocks.inspectRepository.mockResolvedValue(repositoryCatalog);
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.inspectSelectedQuantizations({ signal: new AbortController().signal });
    const initialId = mounted.models.selectedId.value;
    mounted.models.selectQuantization({ id: q4.path });
    expect(mounted.models.selectedId.value).toBe(initialId);
    expect(mounted.models.selectedQuantizationId.value).toBe(q4.path);
    expect(mounted.models.selectedQuantizationLabel.value).toBe('Q4_K_M');
    expect(mocks.enqueue).not.toHaveBeenCalled();
    const installedQ4 = { ...local, modelId: `hf.co/${defaultRepository}:Q4_K_M`, size: q4.size };
    mocks.installed.mockResolvedValueOnce(undefined).mockResolvedValueOnce(installedQ4);
    mocks.enqueue.mockImplementation(({ prepare }: { prepare({ signal }: { signal: AbortSignal }): Promise<DownloadSelection> }) => ({ id: 42, done: prepare({ signal: new AbortController().signal }).then(selection => ({ status: 'complete', selection, destination: { kind: 'opfs' } })) }));
    await expect(mounted.models.openSelected({ signal: new AbortController().signal })).resolves.toEqual({ modelId: installedQ4.modelId, file });
    expect(mocks.inspectRepository).toHaveBeenCalledOnce();
    expect(mocks.installed).toHaveBeenCalledWith({ selection: { repository: defaultRepository, revision: repositoryCatalog.revision, files: [q4] }, destination: { kind: 'opfs' } });
  });

  it('reuses the verified installed quantization and retains its canonical catalog selection', async () => {
    mocks.inventory.mockResolvedValue([local]);
    mocks.inspectRepository.mockResolvedValue(repositoryCatalog);
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.refresh();
    await mounted.models.inspectSelectedQuantizations({ signal: new AbortController().signal });
    expect(mounted.models.models.value).toHaveLength(4);
    expect(mounted.models.models.value[0]?.availability).toBe('local');
    expect(mounted.models.selectedQuantizationId.value).toBe(q8.path);
    await mounted.models.openSelected({ signal: new AbortController().signal });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('keeps local imports distinct from Hugging Face provenance in details', async () => {
    const imported = { ...local, modelId: 'user/recognition' };
    mocks.inventory.mockResolvedValue([imported]);
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.refresh();
    mounted.models.select({ id: `stored:${imported.modelId}` });
    expect(mounted.models.canInspectQuantizations.value).toBe(false);
    expect(mounted.models.selectedQuantizationLabel.value).toBeUndefined();
    expect(mounted.models.selectedDetails.value).toEqual({ kind: 'local', name: imported.modelId, fileName: file.name, bytes: imported.size });
    await mounted.models.inspectSelectedQuantizations({ signal: new AbortController().signal });
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
  });

  it('does not apply late quantization metadata after the selected model changes', async () => {
    const gate = Promise.withResolvers<typeof repositoryCatalog>();
    mocks.inspectRepository.mockReturnValue(gate.promise);
    using mounted = mountModels({ remembered: undefined });
    const pending = mounted.models.inspectSelectedQuantizations({ signal: new AbortController().signal });
    mounted.models.select({ id: mounted.models.models.value[1]?.id });
    await pending;
    gate.resolve(repositoryCatalog);
    expect(mounted.models.quantizations.value).toEqual([]);
    expect(mounted.models.quantizationsFailure.value).toBeUndefined();
    expect(mounted.models.selectedDetails.value).toMatchObject({ repository: 'sakasegawa/Qwen3-ASR-1.7B-GGUF', files: undefined });
  });

  it('does not follow a changed repository while inspecting quantizations', async () => {
    mocks.inspectRepository.mockResolvedValue({ ...repositoryCatalog, repository: 'other/model' });
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.inspectSelectedQuantizations({ signal: new AbortController().signal });
    expect(mounted.models.quantizations.value).toEqual([]);
    expect(mounted.models.quantizationsFailure.value).toBe('metadata');
    expect(mounted.models.selectedDetails.value).toMatchObject({ repository: defaultRepository, files: undefined });
  });

  it('downloads in the background without locking selection or opening the model', async () => {
    const gate = Promise.withResolvers<DownloadJob>();
    mocks.enqueue.mockReturnValue({ id: 42, done: gate.promise });
    using mounted = mountModels({ remembered: undefined });
    const id = mounted.models.models.value[0]?.id;
    if (id === undefined) {
      throw new Error('Missing default model');
    }
    const pending = mounted.models.backgroundDownload({ id });
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    expect(mounted.models.busy.value).toBe(false);
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
    const download = mocks.enqueue.mock.calls[0]?.[0];
    const downloading: DownloadJob = { id: 42, key: downloadJobKey({ key: download.key, destination: download.destination }), repository: defaultRepository, source: 'suggestion', destination: { kind: 'opfs' }, status: 'downloading', selection: undefined, progress: { phase: 'transferring', processed: 2, completed: 2, total: 10 }, error: undefined };
    jobs.value = [downloading];
    expect(mounted.models.downloadStates.value.get(id)).toMatchObject({ status: 'downloading', progress: { completed: 2 } });
    const nextId = mounted.models.models.value[1]?.id;
    mounted.models.select({ id: nextId });
    expect(mounted.models.selectedId.value).toBe(nextId);
    const complete: DownloadJob = { ...downloading, status: 'complete', selection: { repository: defaultRepository, revision: repositoryCatalog.revision, files: [q8] } };
    jobs.value = [complete];
    gate.resolve(complete);
    await pending;
    expect(mounted.models.selectedId.value).toBe(nextId);
    expect(mounted.models.models.value[0]?.availability).toBe('local');
    expect(mounted.models.downloadStates.value.get(id)?.status).toBe('complete');
    expect(mocks.openStored).not.toHaveBeenCalled();
  });

  it('reports a downloaded model with an unsupported recognition format as failed', async () => {
    mocks.inspectStored.mockResolvedValue({ kind: 'other' });
    using mounted = mountModels({ remembered: undefined });
    const id = mounted.models.models.value[0]?.id;
    if (id === undefined) {
      throw new Error('Missing default model');
    }
    mocks.enqueue.mockImplementation(({ key, destination }: { key: string, destination: DownloadJob['destination'] }) => {
      const complete: DownloadJob = { id: 42, key: downloadJobKey({ key, destination }), repository: defaultRepository, source: 'suggestion', destination, status: 'complete', selection: { repository: defaultRepository, revision: repositoryCatalog.revision, files: [q8] }, progress: undefined, error: undefined };
      jobs.value = [complete];
      return { id: 42, done: Promise.resolve(complete) };
    });
    await mounted.models.backgroundDownload({ id });
    expect(mounted.models.downloadStates.value.get(id)).toMatchObject({ status: 'failed', error: 'selection-unavailable' });
    expect(mounted.models.models.value[0]?.availability).toBe('download_required');
    expect(mocks.openStored).not.toHaveBeenCalled();
  });

  it('captures the background destination and physical root before authorization yields', async () => {
    const captured: ModelDestination = { kind: 'host', directoryId: 'folder-a' };
    destination.value = captured;
    const root = { name: 'captured-root' };
    const authorization = Promise.withResolvers<{ destination: ModelDestination, expectedRoot: typeof root }>();
    mocks.authorize.mockReturnValue(authorization.promise);
    mocks.enqueue.mockReturnValue({ id: 42, done: Promise.resolve({ status: 'failed' }) });
    using mounted = mountModels({ remembered: undefined });
    const id = mounted.models.models.value[0]?.id;
    if (id === undefined) {
      throw new Error('Missing default model');
    }
    const pending = mounted.models.backgroundDownload({ id });
    const nextId = mounted.models.models.value[1]?.id;
    mounted.models.select({ id: nextId });
    destination.value = { kind: 'host', directoryId: 'folder-b' };
    await vi.waitFor(() => expect(mocks.authorize).toHaveBeenCalledExactlyOnceWith({ destination: captured }));
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mounted.models.busy.value).toBe(false);
    authorization.resolve({ destination: captured, expectedRoot: root });
    await pending;
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ destination: captured, expectedRoot: root }));
    expect(mounted.models.selectedId.value).toBe(nextId);
    expect(mocks.inspectRepository).not.toHaveBeenCalled();
    expect(mocks.openStored).not.toHaveBeenCalled();
  });

  it('never falls back to OPFS when background host authorization fails', async () => {
    destination.value = { kind: 'host', directoryId: 'denied-folder' };
    mocks.authorize.mockRejectedValue(new Error('Permission denied'));
    using mounted = mountModels({ remembered: undefined });
    const id = mounted.models.models.value[0]?.id;
    if (id === undefined) {
      throw new Error('Missing default model');
    }
    await mounted.models.backgroundDownload({ id });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mounted.models.downloadStates.value.get(id)).toMatchObject({ status: 'failed' });
    expect(destination.value).toEqual({ kind: 'host', directoryId: 'denied-folder' });
    expect(mounted.models.selectedId.value).toBe(id);
  });

  it('keeps Run bound to the destination authorized for its click', async () => {
    const captured: ModelDestination = { kind: 'host', directoryId: 'folder-a' };
    destination.value = captured;
    const root = { name: 'captured-root' };
    const authorization = Promise.withResolvers<{ destination: ModelDestination, expectedRoot: typeof root }>();
    mocks.authorize.mockReturnValue(authorization.promise);
    mocks.enqueue.mockReturnValue({ id: 42, done: Promise.resolve({ status: 'failed' }) });
    using mounted = mountModels({ remembered: undefined });
    const pending = mounted.models.openSelected({ signal: new AbortController().signal });
    const rejected = expect(pending).rejects.toThrow('did not complete');
    destination.value = { kind: 'opfs' };
    authorization.resolve({ destination: captured, expectedRoot: root });
    await rejected;
    expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ destination: captured, expectedRoot: root }));
  });

  it('uses an existing host model from its source without changing the new-download destination', async () => {
    const host: LocalModel = { ...local, modelId: `host/Models/${defaultRepository}:Q8_0`, source: { kind: 'host', directoryId: 'saved-folder', directoryName: 'Models', repository: defaultRepository, primaryRelativePath: q8.path } };
    mocks.inventory.mockResolvedValue([host]);
    destination.value = { kind: 'host', directoryId: 'new-download-folder' };
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.refresh();
    await expect(mounted.models.openSelected({ signal: new AbortController().signal })).resolves.toEqual({ modelId: host.modelId, file });
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(destination.value).toEqual({ kind: 'host', directoryId: 'new-download-folder' });
  });

  it('does not replace a newer quantization choice when an earlier background download completes', async () => {
    mocks.inspectRepository.mockResolvedValue(repositoryCatalog);
    const gate = Promise.withResolvers<DownloadJob>();
    mocks.enqueue.mockReturnValue({ id: 42, done: gate.promise });
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.inspectSelectedQuantizations({ signal: new AbortController().signal });
    const id = mounted.models.selectedId.value;
    if (id === undefined) {
      throw new Error('Missing selected model');
    }
    const pending = mounted.models.backgroundDownload({ id });
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    mounted.models.selectQuantization({ id: q4.path });
    gate.resolve({ id: 42, key: 'background-q8', repository: defaultRepository, source: 'repository', destination: { kind: 'opfs' }, status: 'complete', selection: { repository: defaultRepository, revision: repositoryCatalog.revision, files: [q8] }, progress: undefined, error: undefined });
    await pending;
    expect(mounted.models.selectedQuantizationId.value).toBe(q4.path);
    expect(mounted.models.selectedId.value).toBe(id);
    expect(mounted.models.models.value.find(model => model.id === id)?.availability).toBe('download_required');
    expect(mocks.openStored).not.toHaveBeenCalled();
  });

  it('allows a pinned arbitrary repository to change quantization in the same entry', async () => {
    mocks.inspectRepository.mockResolvedValue({ ...repositoryCatalog, repository: pinned.repository });
    using mounted = mountModels({ remembered: undefined });
    mounted.models.addRepositoryModel({ selection: pinned });
    const id = mounted.models.selectedId.value;
    await mounted.models.inspectSelectedQuantizations({ signal: new AbortController().signal });
    mounted.models.selectQuantization({ id: q4.path });
    expect(mounted.models.selectedId.value).toBe(id);
    expect(mounted.models.selectedQuantizationId.value).toBe(q4.path);
    expect(mounted.models.selectedDetails.value).toMatchObject({ repository: pinned.repository, revision: repositoryCatalog.revision, files: [{ name: q4.path, bytes: q4.size, url: `https://huggingface.co/${pinned.repository}/resolve/${repositoryCatalog.revision}/${q4.path}` }] });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('does not invent the bundled Q8 variant or select another quantization when it is absent', async () => {
    mocks.inspectRepository.mockResolvedValue({ ...repositoryCatalog, models: [repositoryCatalog.models[1]] });
    using mounted = mountModels({ remembered: undefined });
    await mounted.models.inspectSelectedQuantizations({ signal: new AbortController().signal });
    expect(mounted.models.quantizations.value.map(choice => choice.id)).toEqual([q4.path]);
    expect(mounted.models.selectedQuantizationId.value).toBeUndefined();
    expect(mounted.models.selectedDetails.value).toMatchObject({ repository: defaultRepository, files: undefined });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the default download intent stable after its real Q8 files are inspected', async () => {
    const gate = Promise.withResolvers<DownloadJob>();
    mocks.enqueue.mockReturnValue({ id: 42, done: gate.promise });
    mocks.inspectRepository.mockResolvedValue(repositoryCatalog);
    using mounted = mountModels({ remembered: undefined });
    const id = mounted.models.selectedId.value;
    if (id === undefined) {
      throw new Error('Missing selected model');
    }
    const first = mounted.models.backgroundDownload({ id });
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    const originalKey = mocks.enqueue.mock.calls[0]?.[0].key;
    await mounted.models.inspectSelectedQuantizations({ signal: new AbortController().signal });
    const second = mounted.models.backgroundDownload({ id });
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(2));
    expect(mocks.enqueue.mock.calls[1]?.[0].key).toBe(originalKey);
    gate.resolve({ id: 42, key: originalKey, repository: defaultRepository, source: 'suggestion', destination: { kind: 'opfs' }, status: 'complete', selection: { repository: defaultRepository, revision: repositoryCatalog.revision, files: [q8] }, progress: undefined, error: undefined });
    await first;
    await second;
    expect(mocks.openStored).not.toHaveBeenCalled();
  });

  it('refuses to open a shared download whose files differ from the explicit pinned choice', async () => {
    mocks.installed.mockResolvedValue(undefined);
    mocks.enqueue.mockReturnValue({ id: 42, done: Promise.resolve({ status: 'complete', selection: { ...pinned, revision: 'f'.repeat(40) }, destination: { kind: 'opfs' } }) });
    using mounted = mountModels({ remembered: undefined });
    mounted.models.addRepositoryModel({ selection: pinned });
    await expect(mounted.models.openSelected({ signal: new AbortController().signal })).rejects.toThrow('differs from the pinned');
    expect(mocks.openStored).not.toHaveBeenCalled();
    expect(mounted.models.failure.value).toBe('model');
  });
});
