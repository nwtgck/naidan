import { vi } from 'vitest';
import type { SpeechClient, SpeechObservers } from '@/features/speech-cpp-browser/worker/types';
import type { SpeechState } from '@/features/speech-cpp-browser/types';
import { createLiveSpeechController } from './speech-controller';
import type { openLiveCapture } from './audio-capture';
import type { createLivePlayback } from './audio-playback';

export function createLiveSpeechFixture() {
  let observers: SpeechObservers | undefined;
  let runtime: SpeechState = { phase: 'unloaded', model: undefined, completion: undefined, failure: undefined, queuedSamples: 0 };
  function change({ state }: { state: Partial<SpeechState> }): void {
    runtime = { ...runtime, ...state };
    observers?.onState({ state: runtime });
  }
  const client: SpeechClient = {
    capability: { kind: 'available' },
    getState: () => runtime,
    loadModel: vi.fn(async () => {
      change({ state: { phase: 'ready', model: { name: 'test', architecture: 'haru', task: 'dialogue', bytes: 1, sampleRate: 24000, frameSamples: 3200, requiredVersion: 'test' } } });
    }),
    start: vi.fn(async () => {
      change({ state: { phase: 'running', completion: undefined } });
    }),
    push: vi.fn<SpeechClient['push']>(() => ({ kind: 'accepted' })),
    stop: vi.fn(async ({ mode }) => {
      change({ state: { phase: 'completed', completion: mode === 'finish' ? 'finished' : 'cancelled' } });
    }),
    releaseModel: vi.fn(async () => {
      change({ state: { phase: 'unloaded', model: undefined } });
    }),
    dispose: vi.fn(async () => {
      change({ state: { phase: 'disposed', model: undefined } });
    }),
  };
  const createClient = vi.fn<Parameters<typeof createLiveSpeechController>[0]['createClient']>(({ observers: value }) => {
    observers = value;
    return client;
  });
  const finish = vi.fn(async () => {});
  const capture = vi.fn<typeof openLiveCapture>(async () => ({ finish }));
  const player = { activate: vi.fn(async () => {}), begin: vi.fn(), append: vi.fn(async () => {}), mute: vi.fn(), stop: vi.fn(), close: vi.fn(async () => {}) };
  const playback = vi.fn<typeof createLivePlayback>(() => player);
  const onChange = vi.fn<Parameters<typeof createLiveSpeechController>[0]['onChange']>();
  const controller = createLiveSpeechController({ createClient, capture, playback, onChange });
  return {
    controller,
    client,
    createClient,
    change,
    capture,
    finish,
    playback,
    player,
    onChange,
    frame({ text, samples }: { text: string, samples: Float32Array<ArrayBuffer> }): void {
      observers?.onFrame({ frame: { text, samples, sampleRate: 24000, sequence: 0 } });
    },
    pcm({ samples }: { samples: Float32Array }): void {
      capture.mock.calls.at(-1)?.[0].onPcm({ pcm: samples });
    },
    async [Symbol.asyncDispose]() {
      await controller.dispose();
    },
  };
}

export const TEST_ONLY = {
};
