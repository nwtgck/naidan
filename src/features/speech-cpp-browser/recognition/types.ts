import type { SpeechCapability, SpeechFailure, SpeechLoadProgress } from '@/features/speech-cpp-browser/types';
import type { SpeechInvestigationContext } from '@/features/speech-cpp-browser/worker/investigation-context';
import type { SpeechInvestigationWireObserver } from '@/features/speech-cpp-browser/worker/investigation-protocol';
import type { SpeechInvestigationObserver } from '@/features/speech-cpp-browser/investigation/types';

export type SpeechRecognitionCandidateInfo = { name: string, bytes: number, architecture: 'qwen3-asr' | 'fastconformer', task: 'recognition', sampleRate: number, requiredVersion: string };
export type SpeechRecognitionModelInfo = SpeechRecognitionCandidateInfo & { languages: string[], languageSelection: 'supported' | 'unsupported' };
export type SpeechRecognitionResult = { text: string, languages: string[], status: 'complete' | 'cancelled' | 'model_limit' | 'max_seconds' };
export type SpeechRecognitionState = {
  phase: 'unloaded' | 'loading_model' | 'ready' | 'recognizing' | 'cancelling' | 'failed' | 'disposed',
  model: SpeechRecognitionModelInfo | undefined,
  loadProgress: SpeechLoadProgress | undefined,
  progress: number | undefined,
  failure: SpeechFailure | undefined,
};

export type SpeechRecognitionClient = {
  capability: SpeechCapability,
  getState(): SpeechRecognitionState,
  loadModel({ file, investigation }: { file: File, investigation?: SpeechInvestigationContext }): Promise<void>,
  /** Ownership of samples transfers to the Worker; callers must not reuse it. */
  transcribe({ samples, sampleRate, language, investigation }: { samples: Float32Array<ArrayBuffer>, sampleRate: number, language: string | undefined, investigation?: SpeechInvestigationContext }): Promise<SpeechRecognitionResult>,
  cancel(): Promise<void>,
  /** Physically terminate the Worker, releasing its Wasm heap high-water mark. */
  releaseModel(): Promise<void>,
  dispose(): Promise<void>,
};
export type SpeechRecognitionObservers = { onState: ({ state }: { state: SpeechRecognitionState }) => void, onInvestigation?: SpeechInvestigationWireObserver };
export type SpeechRecognitionModelPort = {
  info: SpeechRecognitionModelInfo,
  transcribe({ samples, sampleRate, language, onProgress, investigation }: { samples: Float32Array<ArrayBuffer>, sampleRate: number, language: string | undefined, onProgress: ({ progress }: { progress: number }) => void, investigation?: SpeechInvestigationObserver }): Promise<SpeechRecognitionResult>,
  cancel(): void,
  release(): Promise<void>,
};

export function initialSpeechRecognitionState(): SpeechRecognitionState {
  return { phase: 'unloaded', model: undefined, loadProgress: undefined, progress: undefined, failure: undefined };
}

export const TEST_ONLY = {
};
