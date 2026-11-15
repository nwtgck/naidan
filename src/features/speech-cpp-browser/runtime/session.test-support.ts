import { createSpeechSession } from './session';
import type { SpeechDialoguePort, SpeechFrame, SpeechModelPort, SpeechState } from '@/features/speech-cpp-browser/types';

export function speechSessionFixture({ push, start }: {
  push: SpeechDialoguePort['push'] | undefined,
  start: SpeechModelPort['start'] | undefined,
}) {
  const events: string[] = [], frames: SpeechFrame[] = [], states: SpeechState[] = [];
  const dialogue: SpeechDialoguePort = {
    async push({ samples }) {
      events.push('push');
      return push === undefined ? { kind: 'continue' } : push({ samples });
    },
    async end() {
      events.push('end');
    },
    async release() {
      events.push('dialogue_release');
    },
  };
  const model: SpeechModelPort = {
    info: { name: 'Haru.gguf', bytes: 100, architecture: 'haru', task: 'dialogue', sampleRate: 24000, frameSamples: 3200, requiredVersion: '0.11.0' },
    async start({ options, onFrame }) {
      events.push('start');
      return start === undefined ? dialogue : start({ options, onFrame });
    },
    cancel() {
      events.push('cancel');
    },
    async release() {
      events.push('model_release');
    },
  };
  const client = createSpeechSession({ openModel: async () => model, observers: { onFrame: ({ frame }) => frames.push(frame), onState: ({ state }) => states.push(state) }, maxQueuedSeconds: 0.001 });
  return {
    client,
    model,
    dialogue,
    events,
    frames,
    states,
    async [Symbol.asyncDispose]() {
      await client.dispose();
    },
  };
}

export const startOptions = { inputSampleRate: 24000, maxSeconds: 30, language: 'ja', persona: undefined, name: undefined, seed: undefined };
export const TEST_ONLY = {
};
