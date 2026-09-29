import { describe, expect, it, vi, beforeEach } from 'vitest';
import { detectAudioModelFiles, inspectStoredAudioModel, preferredAudioModel, type AudioModelDetection } from './model-detection';
import { ggufFixture, textMetadata, boolMetadata } from './test-utils/gguf';
import type { LocalModel } from '@/features/llama-cpp-browser/types';
const storage = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('@/features/llama-cpp-browser/runtime/model-store', () => ({ storedModelDirectory: storage.resolve }));
beforeEach(() => {
  storage.resolve.mockReset();
});
function directory({ architecture = 'qwen3tts', projector = 'qwen3tts_gen', generates = true }: { architecture?: string, projector?: string, generates?: boolean } = {}) {
  return { modelPath: 'renamed-00001-of-00002.gguf', projectorPath: 'unusual-companion.gguf' as string | undefined, files: [
    { path: 'renamed-00001-of-00002.gguf', file: ggufFixture({ entries: [textMetadata({ key: 'general.architecture', value: architecture })] }) },
    { path: 'unusual-companion.gguf', file: ggufFixture({ entries: [boolMetadata({ key: 'clip.has_gen_audio_encoder', value: generates }), textMetadata({ key: 'clip.gen.audio.projector_type', value: projector })] }) },
  ] };
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
    const files = directory(); files.files.push({ path: 'wrong.gguf', file: ggufFixture({ entries: [] }) }); files.projectorPath = 'wrong.gguf';
    expect(await detectAudioModelFiles({ directory: files, signal: undefined })).toEqual({ status: 'unverified', reason: 'companion' });
    files.projectorPath = undefined;
    expect(await detectAudioModelFiles({ directory: files, signal: undefined })).toEqual({ status: 'unverified', reason: 'companion' });
  });
  it('returns unverified on read failure and does not convert cancellation to an ordinary result', async () => {
    const files = directory(); vi.spyOn(files.files[0]!.file, 'slice').mockImplementation(() => {
      throw new Error('deleted file');
    });
    expect(await detectAudioModelFiles({ directory: files, signal: undefined })).toEqual({ status: 'unverified', reason: 'metadata' });
    const controller = new AbortController(); controller.abort();
    await expect(detectAudioModelFiles({ directory: files, signal: controller.signal })).rejects.toThrow();
  });
  it('resolves stored user and Hugging Face IDs through the existing local loader', async () => {
    storage.resolve.mockResolvedValue(directory());
    expect(await inspectStoredAudioModel({ id: 'user/voice', signal: undefined })).toMatchObject({ status: 'detected' });
    expect(storage.resolve).toHaveBeenCalledWith({ name: 'user/voice' });
    const hostedId = 'hf.co/ggml-org/Qwen3-TTS-12Hz-1.7B-Base-GGUF:voice-Q8_0.gguf';
    expect(await inspectStoredAudioModel({ id: hostedId, signal: undefined })).toMatchObject({ status: 'detected' });
    expect(storage.resolve).toHaveBeenCalledWith({ name: hostedId });
    storage.resolve.mockRejectedValueOnce(new Error('storage unavailable'));
    expect(await inspectStoredAudioModel({ id: 'user/voice', signal: undefined })).toMatchObject({ status: 'unverified' });
  });
});
const detected: AudioModelDetection = { status: 'detected', pipeline: 'qwen3-tts', reference: 'optional' };
function model({ id, size }: { id: string, size: number }): LocalModel {
  return { id, size, name: id, importedAt: 1 };
}
describe('default candidate selection', () => {
  it('prefers no-reference use, then smaller stored size, with deterministic ID ties', () => {
    const models = [model({ id: 'chat', size: 1 }), model({ id: 'pocket', size: 10 }), model({ id: 'qwen-big', size: 200 }), model({ id: 'qwen-b', size: 100 }), model({ id: 'qwen-a', size: 100 })];
    const detections = new Map<string, AudioModelDetection>([['pocket', { status: 'detected', pipeline: 'pocket-tts', reference: 'required' }], ...models.filter(m => m.id.startsWith('qwen')).map(m => [m.id, detected] as const)]);
    expect(preferredAudioModel({ models, detections })).toBe('qwen-a');
    expect(preferredAudioModel({ models: [...models].reverse(), detections })).toBe('qwen-a');
    expect(models[0]!.id).toBe('chat');
  });
  it('does not pick an unverified chat model when detection fails', () => {
    expect(preferredAudioModel({ models: [model({ id: 'chat', size: 1 })], detections: new Map() })).toBeUndefined();
  });
});
