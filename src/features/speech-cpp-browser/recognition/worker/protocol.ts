import { z } from 'zod';
import type { SpeechArtifact } from '@/features/speech-cpp-browser/artifacts';
import type { SpeechRecognitionModelInfo, SpeechRecognitionResult } from '@/features/speech-cpp-browser/recognition/types';
import { speechAudioSchema, speechLoadSchema, speechFailureSchema, speechLoadProgressSchema } from '@/features/speech-cpp-browser/worker/protocol';
import type { SpeechFailure } from '@/features/speech-cpp-browser/types';
import { speechInvestigationContextSchema, type SpeechInvestigationContext } from '@/features/speech-cpp-browser/worker/investigation-context';

export { speechLoadSchema };
export const recognitionAudioSchema = speechAudioSchema.extend({ language: z.string().optional(), investigation: speechInvestigationContextSchema.optional() });
export const recognitionModelSchema = z.object({ name: z.string(), bytes: z.number(), architecture: z.enum(['qwen3-asr', 'fastconformer']), task: z.literal('recognition'), sampleRate: z.number().int().min(8000).max(192000), requiredVersion: z.string(), languages: z.array(z.string()).max(256), languageSelection: z.enum(['supported', 'unsupported']) });
export const recognitionResultSchema = z.object({ text: z.string().max(4 * 1024 * 1024), languages: z.array(z.string()).max(256), status: z.enum(['complete', 'cancelled', 'model_limit', 'max_seconds']) });
export const recognitionLoadResultSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('loaded'), model: recognitionModelSchema }), z.object({ kind: z.literal('failed'), failure: speechFailureSchema })]);
export const recognitionTranscribeResultSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('recognized'), result: recognitionResultSchema }), z.object({ kind: z.literal('failed'), failure: speechFailureSchema })]);
export const recognitionCancelSchema = z.object({ type: z.literal('naidan_recognition_cancel_v1') });
export const recognitionProgressSchema = z.object({ type: z.literal('naidan_recognition_progress_v1'), progress: z.number().min(0).max(1) });
export const recognitionLoadProgressSchema = z.object({ type: z.literal('naidan_recognition_load_v1'), progress: speechLoadProgressSchema });

export type SpeechRecognitionWorker = {
  loadModel({ file, artifact, baseUrl, investigation }: { file: File, artifact: SpeechArtifact, baseUrl: string, investigation?: SpeechInvestigationContext }): Promise<{ kind: 'loaded', model: SpeechRecognitionModelInfo } | { kind: 'failed', failure: SpeechFailure }>,
  transcribe({ samples, sampleRate, language, investigation }: { samples: Float32Array<ArrayBuffer>, sampleRate: number, language: string | undefined, investigation?: SpeechInvestigationContext }): Promise<{ kind: 'recognized', result: SpeechRecognitionResult } | { kind: 'failed', failure: SpeechFailure }>,
  releaseModel(): Promise<void>,
};

export const TEST_ONLY = {
};
