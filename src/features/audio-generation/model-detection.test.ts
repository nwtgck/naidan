import { temporaryModelFiles } from '@/logic/temporary-model-files';
import { temporaryModels } from '@/features/llama-cpp-browser/runtime/temporary-model-store';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { detectAudioModelFiles, inspectStoredAudioModel, preferredAudioModel, type AudioModelDetection } from './model-detection';
import { ggufFixture, textMetadata, boolMetadata } from './test-utils/gguf.test-support';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
const storage = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/runtime/model-resolution', async importOriginal => {
  const actual = await importOriginal<typeof import('@/features/llama-cpp-browser/runtime/model-resolution')>();
  return {
    resolveModel: ({ modelId, signal }: { modelId: string, signal: AbortSignal | undefined }) => modelId.startsWith('temp/')
      ? actual.resolveModel({ modelId, signal }) : storage.resolve({ modelId, signal }),
  };
});

beforeEach(() => {
  storage.resolve.mockReset();
});

function directory({ architecture = 'qwen3tts', projector = 'qwen3tts_gen', generates = true }: { architecture?: string, projector?: string, generates?: boolean } = {}) {
  const files = [
    { relativePath: 'renamed-00001-of-00002.gguf', file: ggufFixture({ entries: [textMetadata({ key: 'general.architecture', value: architecture })] }) },
    { relativePath: 'unusual-companion.gguf', file: ggufFixture({ entries: [boolMetadata({ key: 'clip.has_gen_audio_encoder', value: generates }), textMetadata({ key: 'clip.gen.audio.projector_type', value: projector })] }) },
  ];
  return { files, primaryFile: files[0]!, projectorFile: files[1] as typeof files[number] | undefined };
}

describe('audio candidate metadata', () => {
  it.each([
    { architecture: 'qwen3tts', projector: 'qwen3tts_gen', pipeline: 'qwen3-tts', reference: 'optional' },
    { architecture: 'pockettts', projector: 'pockettts_gen', pipeline: 'pocket-tts', reference: 'required' },
  ])('recognizes an exact pair regardless of filename: $architecture', async entry => {
    expect(await detectAudioModelFiles({ directory: directory(entry), signal: undefined })).toEqual({ status: 'detected', pipeline: entry.pipeline, reference: entry.reference });
  });

  it.each([
    { architecture: 'qwen3', projector: 'qwen3tts_gen' },
    { architecture: 'future-tts', projector: 'future_gen' },
    { architecture: 'qwen3tts', projector: 'pockettts_gen' },
    { architecture: 'qwen3tts', projector: 'qwen3tts_gen', generates: false },
  ])('does not infer support from labels or the presence of audio-related data: %j', async entry => {
    expect(await detectAudioModelFiles({ directory: directory(entry), signal: undefined })).toMatchObject({ status: 'unverified' });
  });

  it('inspects the selected companion rather than finding another matching file', async () => {
    const files = directory();
    const wrong = { relativePath: 'wrong.gguf', file: ggufFixture({ entries: [] }) };
    files.files.push(wrong);
    files.projectorFile = wrong;
    expect(await detectAudioModelFiles({ directory: files, signal: undefined })).toEqual({ status: 'unverified', reason: 'companion' });
    files.projectorFile = undefined;
    expect(await detectAudioModelFiles({ directory: files, signal: undefined })).toEqual({ status: 'unverified', reason: 'companion' });
  });

  it('returns unverified on read failure and does not convert cancellation to an ordinary result', async () => {
    const files = directory();
    vi.spyOn(files.files[0]!.file, 'slice').mockImplementation(() => {
      throw new Error('deleted file');
    });
    expect(await detectAudioModelFiles({ directory: files, signal: undefined })).toEqual({ status: 'unverified', reason: 'metadata' });
    const controller = new AbortController();
    controller.abort();
    await expect(detectAudioModelFiles({ directory: files, signal: controller.signal })).rejects.toThrow();
  });

  it('inspects temporary model metadata through captured Files without consulting persistent storage', async () => {
    const base = ggufFixture({ entries: [textMetadata({ key: 'general.architecture', value: 'qwen3tts' })] });
    const companion = ggufFixture({ entries: [boolMetadata({ key: 'clip.has_gen_audio_encoder', value: true }), textMetadata({ key: 'clip.gen.audio.projector_type', value: 'qwen3tts_gen' })] });
    const files = await Promise.all([{ relativePath: 'voice.gguf', blob: base }, { relativePath: 'mmproj.gguf', blob: companion }].map(async ({ relativePath, blob }) => {
      const file = new File([await blob.arrayBuffer()], relativePath);
      Object.defineProperty(file, 'slice', { value: (start: number, end: number) => blob.slice(start, end) });
      return { relativePath, file };
    }));
    const [model] = await temporaryModels.registerDirectory({ directory: { rootName: 'temporary-voice', files }, signal: undefined });
    using _registration = { [Symbol.dispose]: () => temporaryModelFiles.remove({ rootPath: 'temp/temporary-voice' }) };
    expect(await inspectStoredAudioModel({ modelId: model!.modelId, signal: undefined })).toEqual({ status: 'detected', pipeline: 'qwen3-tts', reference: 'optional' });
    expect(storage.resolve).not.toHaveBeenCalled();
    temporaryModels.removeModel({ modelId: model!.modelId });
    expect(await inspectStoredAudioModel({ modelId: model!.modelId, signal: undefined })).toMatchObject({ status: 'unverified' });
    expect(storage.resolve).not.toHaveBeenCalled();
  });

  it('resolves stored user, host and Hugging Face modelIds through the same file resolver', async () => {
    storage.resolve.mockResolvedValue({ directory: directory() });
    expect(await inspectStoredAudioModel({ modelId: 'user/voice', signal: undefined })).toMatchObject({ status: 'detected' });
    expect(storage.resolve).toHaveBeenCalledWith({ modelId: 'user/voice', signal: undefined });
    const hostedId = 'hf.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF:Q8_0';
    expect(await inspectStoredAudioModel({ modelId: hostedId, signal: undefined })).toMatchObject({ status: 'detected' });
    expect(storage.resolve).toHaveBeenCalledWith({ modelId: hostedId, signal: undefined });
    const hostModelId = 'host/MyModels1/owner/Voice-GGUF:Q8_0';
    expect(await inspectStoredAudioModel({ modelId: hostModelId, signal: undefined })).toMatchObject({ status: 'detected' });
    expect(storage.resolve).toHaveBeenCalledWith({ modelId: hostModelId, signal: undefined });
    storage.resolve.mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await inspectStoredAudioModel({ modelId: 'user/voice', signal: undefined })).toMatchObject({ status: 'unverified' });
  });
});

const detected: AudioModelDetection = { status: 'detected', pipeline: 'qwen3-tts', reference: 'optional' };

function model({ modelId, size }: { modelId: string, size: number }): LocalModel {
  return { modelId, size, importedAt: 1 };
}

describe('default candidate selection', () => {
  it('prefers no-reference use, then smaller stored size, with deterministic ID ties', () => {
    const models = [model({ modelId: 'chat', size: 1 }), model({ modelId: 'pocket', size: 10 }), model({ modelId: 'qwen-big', size: 200 }), model({ modelId: 'qwen-b', size: 100 }), model({ modelId: 'qwen-a', size: 100 })];
    const detections = new Map<string, AudioModelDetection>([['pocket', { status: 'detected', pipeline: 'pocket-tts', reference: 'required' }], ...models.filter(m => m.modelId.startsWith('qwen')).map(m => [m.modelId, detected] as const)]);
    expect(preferredAudioModel({ models, detections })).toBe('qwen-a');
    expect(preferredAudioModel({ models: [...models].reverse(), detections })).toBe('qwen-a');
    expect(models[0]!.modelId).toBe('chat');
  });

  it('does not pick an unverified chat model when detection fails', () => {
    expect(preferredAudioModel({ models: [model({ modelId: 'chat', size: 1 })], detections: new Map() })).toBeUndefined();
  });
});
