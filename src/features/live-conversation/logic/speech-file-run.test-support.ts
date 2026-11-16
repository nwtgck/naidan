import { vi } from 'vitest';
import { createSpeechSession } from '@/features/speech-cpp-browser/runtime/session';
import type { SpeechDialoguePort, SpeechModelPort } from '@/features/speech-cpp-browser/types';
import { createSpeechFileRun, type SpeechInputPacing } from './speech-file-run';
import type { decodeLiveAudioFile } from './audio-file';
import type { SpeechInputLevelSettings } from './audio-level';

export async function speechFileRunFixture({ pcm, tailSeconds, maxSeconds, inputPacing, inputLevel, maximumRetainedAudioBytes }: { pcm: Float32Array<ArrayBuffer>, tailSeconds: number, maxSeconds: number, inputPacing: SpeechInputPacing, inputLevel: SpeechInputLevelSettings, maximumRetainedAudioBytes: number }) {
  const blobs: Blob[] = [];
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    blobs.push(blob as Blob);
    return `blob:speech-file-${blobs.length}`;
  });
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const borrowed = new Float32Array(3200);
  let frame = 0;
  let callback: Parameters<SpeechModelPort['start']>[0]['onFrame'] | undefined;
  function emit(): void {
    borrowed.fill(++frame / 100);
    callback?.({ samples: borrowed, text: frame === 1 ? 'Initial' : ' response' });
    borrowed.fill(0);
  }
  const push = vi.fn<SpeechDialoguePort['push']>(async () => {
    emit();
    return { kind: 'continue' };
  });
  const end = vi.fn(async () => {});
  const releaseDialogue = vi.fn(async () => {});
  const model: SpeechModelPort = {
    info: { name: 'Haru test', bytes: 1, architecture: 'haru', task: 'dialogue', sampleRate: 24000, frameSamples: 3200, requiredVersion: '0.11.0' },
    start: vi.fn(async ({ onFrame }) => {
      callback = onFrame;
      frame = 0;
      emit();
      return { push, end, release: releaseDialogue };
    }),
    cancel: vi.fn(),
    release: vi.fn(async () => {}),
  };
  const client = createSpeechSession({
    openModel: async () => model,
    maxQueuedSeconds: 2,
    observers: {
      onFrame: ({ frame }) => runner?.onFrame({ frame }),
      onState: () => runner?.onState(),
    },
  });
  const decodeFile = vi.fn<typeof decodeLiveAudioFile>(async () => pcm);
  const onChange = vi.fn<Parameters<typeof createSpeechFileRun>[0]['onChange']>();
  const runner = createSpeechFileRun({ client, file: new File(['audio'], 'greeting.wav'), options: { inputSampleRate: 24000, maxSeconds, language: 'ja', persona: undefined, name: undefined, seed: 0 }, tailSeconds, inputPacing, inputLevel, maximumRetainedAudioBytes, decodeFile, onChange });
  await client.loadModel({ file: new File(['model'], 'haru.gguf') });
  return {
    runner,
    client,
    model,
    push,
    end,
    releaseDialogue,
    decodeFile,
    onChange,
    blobs,
    createUrl,
    revokeUrl,
    async [Symbol.asyncDispose]() {
      await runner?.stop({ mode: 'cancel' });
      runner?.clear();
      await client.dispose();
      createUrl.mockRestore();
      revokeUrl.mockRestore();
    },
  };
}

export async function readSpeechWave({ blob }: { blob: Blob }): Promise<DataView> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => reader.result instanceof ArrayBuffer ? resolve(new DataView(reader.result)) : reject(new Error('Not bytes'));
    reader.readAsArrayBuffer(blob);
  });
}

export function speechReplayVisibility({ initial }: { initial: DocumentVisibilityState }) {
  let state = initial;
  const document = new EventTarget();
  Object.defineProperty(document, 'visibilityState', { get: () => state });
  const added = vi.spyOn(document, 'addEventListener'), removed = vi.spyOn(document, 'removeEventListener');
  vi.stubGlobal('document', document);
  return {
    added,
    removed,
    change({ value }: { value: DocumentVisibilityState }): void {
      state = value;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    [Symbol.dispose]() {
      added.mockRestore();
      removed.mockRestore();
      vi.unstubAllGlobals();
    },
  };
}

export const TEST_ONLY = {
};
