import { z } from 'zod';
import type { SpeechFrame, SpeechState, SpeechStartOptions } from '@/features/speech-cpp-browser/types';
import { speechArtifactSchema, type SpeechArtifact } from '@/features/speech-cpp-browser/artifacts';
import { exactObject } from '@/utils/exact-object';
import { speechInvestigationContextSchema, type SpeechInvestigationContext } from './investigation-context';

export const speechStartSchema = z.object({ inputSampleRate: z.number(), maxSeconds: z.number(), language: z.string(), persona: z.string().optional(), name: z.string().optional(), seed: z.number().optional() });

export function decodeSpeechStart({ value }: { value: unknown }): SpeechStartOptions {
  const { inputSampleRate, maxSeconds, language, persona, name, seed, ...unhandled } = speechStartSchema.parse(value);
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<SpeechStartOptions>()({ inputSampleRate, maxSeconds, language, persona, name, seed });
}

const pcmSchema = z.custom<Float32Array<ArrayBuffer>>((value: unknown) => value instanceof Float32Array && value.buffer instanceof ArrayBuffer);
export const speechAudioSchema = z.object({ samples: pcmSchema, sampleRate: z.number() });
export const speechStopSchema = z.object({ mode: z.enum(['finish', 'cancel']) });
export const speechLoadSchema = z.object({ file: z.custom<File>((value: unknown) => typeof File !== 'undefined' && value instanceof File), artifact: speechArtifactSchema, baseUrl: z.string(), investigation: speechInvestigationContextSchema.optional() });
export const speechStartRequestSchema = z.object({ options: speechStartSchema, investigation: speechInvestigationContextSchema.optional() });
export const speechFrameEnvelopeSchema = z.object({ type: z.literal('naidan_speech_frame_v1'), frame: z.object({ samples: pcmSchema.refine(value => value.length === 3200 && value.every(sample => Number.isFinite(sample) && sample >= -1 && sample <= 1)), sampleRate: z.literal(24000), text: z.string().max(16384), sequence: z.number().int().nonnegative() }) });
const modelSchema = z.object({ name: z.string(), bytes: z.number(), architecture: z.literal('haru'), task: z.literal('dialogue'), sampleRate: z.literal(24000), frameSamples: z.literal(3200), requiredVersion: z.string() });
export const speechFailureSchema = z.object({ code: z.enum(['unavailable', 'invalid_model', 'invalid_audio', 'queue_full', 'invalid_state', 'runtime_failed']), message: z.string(), nativeStatus: z.number().optional(), nativeInput: z.string().optional() });
const byteCount = z.number().int().nonnegative().safe();
export const speechLoadProgressSchema = z.discriminatedUnion('stage', [z.object({ stage: z.literal('preparing_runtime') }), z.object({ stage: z.literal('loading_runtime'), fetchedBytes: byteCount, decompressedBytes: byteCount, totalDecompressedBytes: byteCount.positive() }), z.object({ stage: z.literal('checking_model') }), z.object({ stage: z.literal('preparing_model') }), z.object({ stage: z.literal('reading_model'), readBytes: byteCount, totalBytes: byteCount.positive() }), z.object({ stage: z.literal('checking_loaded_model') })]);
export const speechStateEnvelopeSchema = z.object({ type: z.literal('naidan_speech_state_v1'), state: z.object({ phase: z.enum(['unloaded', 'loading_model', 'ready', 'starting', 'running', 'stopping', 'completed', 'failed', 'disposed']), model: modelSchema.optional(), queuedSamples: z.number().int().nonnegative(), completion: z.enum(['finished', 'cancelled', 'max_seconds']).optional(), failure: speechFailureSchema.optional(), loadProgress: speechLoadProgressSchema.optional() }) });

export function decodeSpeechState({ value }: { value: unknown }): SpeechState {
  const { phase, model, queuedSamples, completion, failure, loadProgress, ...unhandled } = speechStateEnvelopeSchema.shape.state.parse(value);
  unhandled satisfies Record<PropertyKey, never>;
  return exactObject<SpeechState>()({ phase, model, queuedSamples, completion, failure: failure === undefined ? undefined : { code: failure.code, message: failure.message, nativeStatus: failure.nativeStatus, nativeInput: failure.nativeInput }, loadProgress });
}

export type SpeechWorker = {
  loadModel({ file, artifact, baseUrl, investigation }: { file: File, artifact: SpeechArtifact, baseUrl: string, investigation?: SpeechInvestigationContext }): Promise<void>;
  start({ options, investigation }: { options: SpeechStartOptions, investigation?: SpeechInvestigationContext }): Promise<void>;
  push({ samples, sampleRate }: { samples: Float32Array<ArrayBuffer>, sampleRate: number }): Promise<void>;
  stop({ mode }: { mode: 'finish' | 'cancel' }): Promise<void>;
  cancel(): void;
  releaseModel(): Promise<void>;
};
export type SpeechNotification = { type: 'naidan_speech_frame_v1', frame: SpeechFrame } | { type: 'naidan_speech_state_v1', state: SpeechState };

export const TEST_ONLY = {
};
