import { z } from 'zod';
import { postWorkerNotification } from '@/utils/worker-transport';
import type { SpeechInvestigationEvent, SpeechInvestigationJson, SpeechInvestigationObserver } from '@/features/speech-cpp-browser/investigation/types';
import { speechFailureSchema } from './protocol';
import { speechInvestigationContextSchema, type SpeechInvestigationContext } from './investigation-context';

export { speechInvestigationContextSchema, type SpeechInvestigationContext };
export type SpeechInvestigationWireObserver = ({ context, event }: { context: SpeechInvestigationContext, event: SpeechInvestigationEvent }) => void;

const boundedText = z.string().max(64 * 1024), count = z.number().int().nonnegative().safe();
const json: z.ZodType<SpeechInvestigationJson> = z.lazy(() => z.union([boundedText, z.number().finite(), z.boolean(), z.undefined(), z.array(json).max(256), z.record(z.string().max(128), json).refine(value => Object.keys(value).length <= 128)]));
const details = z.record(z.string().max(128), json).refine(value => Object.keys(value).length <= 128).optional();

function observation<T extends z.ZodType>({ value }: { value: T }) {
  return z.union([z.object({ status: z.literal('observed'), value, source: z.string().max(256) }), z.object({ status: z.enum(['unknown', 'unavailable', 'not_applicable', 'unset']), reason: boundedText })]);
}

const stringObservation = observation({ value: boundedText });
const eventSchema: z.ZodType<SpeechInvestigationEvent> = z.union([
  z.object({ kind: z.literal('native_log'), level: z.string().max(64), message: z.string().max(8192) }),
  z.object({ kind: z.literal('native_log_batch'), lines: z.array(z.object({ level: z.string().max(64), text: z.string().max(8192) })).max(16), dropped: count }),
  z.object({ kind: z.literal('stage'), stage: z.string().max(128), state: z.enum(['started', 'completed', 'cancelled', 'failed']), durationMilliseconds: z.number().nonnegative().finite().optional(), heapBytes: count.optional(), details }).transform(({ kind, stage, state, durationMilliseconds, heapBytes, details }) => ({ kind, stage, state, durationMilliseconds, heapBytes, details })),
  z.object({ kind: z.literal('progress'), stage: z.string().max(128), value: z.number().finite(), total: z.number().finite().optional(), unit: z.enum(['bytes', 'fraction', 'samples', 'estimated_work']), provenance: z.enum(['observed', 'estimated']), details }).transform(({ kind, stage, value, total, unit, provenance, details }) => ({ kind, stage, value, total, unit, provenance, details })),
  z.object({ kind: z.literal('model_info'), rawJson: boundedText, device: stringObservation, threads: observation({ value: count }), weightType: stringObservation, weightBytes: stringObservation }),
  z.object({ kind: z.literal('devices'), devices: z.array(z.object({ name: z.string().max(4096), description: z.string().max(4096), kind: z.string().max(64), totalBytes: stringObservation, freeBytes: stringObservation })).max(32) }),
  z.object({ kind: z.literal('read_summary'), calls: count, totalBytes: count, uniqueBytes: observation({ value: count }), maximumChunkBytes: count, smallReads: count, elapsedMilliseconds: z.number().nonnegative().finite().optional() }).transform(({ kind, calls, totalBytes, uniqueBytes, maximumChunkBytes, smallReads, elapsedMilliseconds }) => ({ kind, calls, totalBytes, uniqueBytes, maximumChunkBytes, smallReads, elapsedMilliseconds })),
  z.object({ kind: z.literal('wasm_heap'), capacityBytes: count }),
  z.object({ kind: z.literal('result'), nativeStatus: z.number().int().optional(), stop: observation({ value: z.union([boundedText, z.number().finite()]) }), seed: stringObservation, details }).transform(({ kind, nativeStatus, stop, seed, details }) => ({ kind, nativeStatus, stop, seed, details })),
  z.object({ kind: z.literal('cancel'), state: z.enum(['requested', 'settled']), reason: boundedText }),
  z.object({ kind: z.literal('failure'), stage: z.string().max(128), failure: speechFailureSchema.transform(({ code, message, nativeStatus, nativeInput }) => ({ code, message, nativeStatus, nativeInput })) }),
]);
export const speechInvestigationEnvelopeSchema = z.object({ type: z.literal('naidan_speech_investigation_v1'), context: speechInvestigationContextSchema, event: eventSchema });

/** Callback stays inside this Worker. Only bounded typed data crosses IPC. */
export function createWorkerSpeechInvestigationObserver({ context }: { context: SpeechInvestigationContext | undefined }): SpeechInvestigationObserver | undefined {
  if (context === undefined) {
    return undefined;
  }
  return ({ event }) => postWorkerNotification({ endpoint: undefined, schema: speechInvestigationEnvelopeSchema, value: { type: 'naidan_speech_investigation_v1', context, event } });
}

export const TEST_ONLY = {
};
