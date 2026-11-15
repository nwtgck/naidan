import { vi } from 'vitest';
import { ggufFixture, ggufInteger, textMetadata } from '@/features/audio-generation/test-utils/gguf.test-support';
import { initialSpeechRecognitionState, type SpeechRecognitionClient, type SpeechRecognitionModelInfo, type SpeechRecognitionObservers, type SpeechRecognitionResult, type SpeechRecognitionState } from './types';
import type { SpeechInvestigationContext } from '@/features/speech-cpp-browser/worker/investigation-context';
import type { SpeechInvestigationEvent } from '@/features/speech-cpp-browser/investigation/types';

export const recognitionInfo: SpeechRecognitionModelInfo = { name: 'recognizer.gguf', bytes: 128, architecture: 'qwen3-asr', task: 'recognition', sampleRate: 16000, requiredVersion: '0.11.0', languages: ['ja', 'en'], languageSelection: 'supported' };

export async function recognitionFile({ architecture, task, sampleRate }: { architecture: string, task: string, sampleRate: number }): Promise<File> {
  const blob = ggufFixture({ entries: [textMetadata({ key: 'general.architecture', value: architecture }), textMetadata({ key: 'speech.task', value: task }), textMetadata({ key: 'speech.requires', value: '0.11.0' }), { key: 'speech.sample_rate', type: 4, value: ggufInteger({ value: sampleRate, bytes: 4 }) }, { key: 'speech.layout', type: 4, value: ggufInteger({ value: 1, bytes: 4 }) }] });
  return new File([await blob.arrayBuffer()], 'arbitrary-name.gguf');
}

export function recognitionClientFixture({ observers }: { observers: SpeechRecognitionObservers }) {
  let state = initialSpeechRecognitionState();
  const transcribe = vi.fn<SpeechRecognitionClient['transcribe']>(async () => ({ text: 'こんにちは', languages: ['ja'], status: 'complete' }));
  const releaseModel = vi.fn(async () => {
    state = initialSpeechRecognitionState();
    observers.onState({ state });
  });
  const cancel = vi.fn(async () => {});
  const client: SpeechRecognitionClient = {
    capability: { kind: 'available' },
    getState: () => state,
    async loadModel() {
      state = { ...state, phase: 'ready', model: recognitionInfo };
      observers.onState({ state });
    },
    transcribe,
    releaseModel,
    cancel,
    async dispose() {
      state = { ...initialSpeechRecognitionState(), phase: 'disposed' };
      observers.onState({ state });
    },
  };
  return {
    client,
    transcribe,
    releaseModel,
    cancel,
    complete({ result }: { result: SpeechRecognitionResult }) {
      transcribe.mockResolvedValue(result);
    },
    change({ state: next }: { state: Partial<SpeechRecognitionState> }): void {
      state = { ...state, ...next };
      observers.onState({ state });
    },
    observe({ context, event }: { context: SpeechInvestigationContext, event: SpeechInvestigationEvent }): void {
      observers.onInvestigation?.({ context, event });
    },
  };
}

export const TEST_ONLY = {
};
