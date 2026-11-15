import { z } from 'zod';

export const speechSampleRate = 24000;
export const speechFrameSamples = 3200;
export const speechUnavailableReasonSchema = z.enum(['artifact_unavailable', 'standalone', 'worker_unavailable', 'webgpu_unavailable', 'memory64_unavailable', 'jspi_unavailable']);
export type SpeechUnavailableReason = z.infer<typeof speechUnavailableReasonSchema>;
export type SpeechCapability = { kind: 'available' } | { kind: 'unavailable', reason: SpeechUnavailableReason };
export type SpeechPhase = 'unloaded' | 'loading_model' | 'ready' | 'starting' | 'running' | 'stopping' | 'completed' | 'failed' | 'disposed';
export type SpeechCompletionReason = 'finished' | 'cancelled' | 'max_seconds';
export type SpeechModelInfo = { name: string, bytes: number, architecture: 'haru', task: 'dialogue', sampleRate: 24000, frameSamples: 3200, requiredVersion: string };
export type SpeechFailure = { code: 'unavailable' | 'invalid_model' | 'invalid_audio' | 'queue_full' | 'invalid_state' | 'runtime_failed', message: string, nativeStatus: number | undefined, nativeInput: string | undefined };
export type SpeechState = { phase: SpeechPhase, model: SpeechModelInfo | undefined, queuedSamples: number, completion: SpeechCompletionReason | undefined, failure: SpeechFailure | undefined };
export type SpeechFrame = { samples: Float32Array<ArrayBuffer>, sampleRate: 24000, text: string, sequence: number };
export const speechDialogueLanguages = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt', 'ru', 'zh'] as const;
export type SpeechStartOptions = { inputSampleRate: number, maxSeconds: number, language: string, persona: string | undefined, name: string | undefined };
export type SpeechPushResult = { kind: 'accepted' } | { kind: 'backpressure' } | { kind: 'not_running' };

export class SpeechRuntimeError extends Error {
  readonly details: SpeechFailure;

  constructor({ details }: { details: SpeechFailure }) {
    super(details.message);
    this.name = 'SpeechRuntimeError';
    this.details = details;
  }
}

export function speechError({ code, message }: { code: SpeechFailure['code'], message: string }): SpeechRuntimeError {
  return new SpeechRuntimeError({ details: { code, message, nativeStatus: undefined, nativeInput: undefined } });
}

export function speechFailure({ error }: { error: unknown }): SpeechFailure {
  if (error instanceof SpeechRuntimeError) {
    return error.details;
  }
  return { code: 'runtime_failed', message: error instanceof Error ? error.message : String(error), nativeStatus: undefined, nativeInput: undefined };
}

/** Application-owned session operations implemented by the native adapter.
 * Generated C declarations remain the authority for the native ABI. */
export type SpeechDialoguePort = {
  push({ samples }: { samples: Float32Array<ArrayBuffer> }): Promise<{ kind: 'continue' } | { kind: 'completed', reason: SpeechCompletionReason }>;
  end(): Promise<void>;
  release(): Promise<void>;
};
export type SpeechModelPort = {
  info: SpeechModelInfo;
  start({ options, onFrame }: { options: SpeechStartOptions, onFrame: ({ samples, text }: { samples: Float32Array, text: string }) => 'continue' | 'stop' }): Promise<SpeechDialoguePort>;
  /** Synchronous control only. The SDK adapter must bypass its busy async gate
   * for a registered cancellation leaf; dialogue callbacks also observe it. */
  cancel(): void;
  release(): Promise<void>;
};

export const TEST_ONLY = {
};
