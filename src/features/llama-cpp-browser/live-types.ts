import { z } from 'zod';
import { generateInputSchema, toolCallSchema, type Progress } from './types';
import type { WorkerPrepareInput } from './worker/types';

// Limits apply before crossing the Worker boundary, independently of context capacity.
export const livePcmSchema = z.instanceof(Float32Array).refine(value => value.length > 0 && value.length <= 32000 && value.every(Number.isFinite), 'Invalid live PCM chunk');
const idSchema = z.string().min(1).max(128);
export const liveOutputSchema = z.enum(['text', 'audio', 'mixed']);
export const liveToolsSchema = generateInputSchema.shape.tools.unwrap().max(8);
const turn = { turnId: idSchema };
export const liveCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('begin'), ...turn, text: z.string().max(32768), transcription: z.enum(['on', 'off']), images: z.array(z.instanceof(Blob).refine(blob => blob.size <= 16 * 1024 * 1024)).max(4) }).strict(),
  z.object({ type: z.literal('audio'), ...turn, sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), pcm: livePcmSchema }).strict(),
  z.object({ type: z.literal('respond'), ...turn, output: liveOutputSchema, maxSteps: z.number().int().min(1).max(8192) }).strict(),
  z.object({ type: z.literal('tool-results'), ...turn, results: z.array(z.object({ id: idSchema, content: z.string().max(65536) }).strict()).min(1).max(8), output: liveOutputSchema, maxSteps: z.number().int().min(1).max(8192) }).strict(),
  z.object({ type: z.literal('transcribe'), ...turn }).strict(),
  z.object({ type: z.literal('rollback'), ...turn }).strict(),
  z.object({ type: z.literal('reset') }).strict(),
  z.object({ type: z.literal('close') }).strict(),
]);
export type LiveCommand = z.infer<typeof liveCommandSchema>;
export const liveControlSchema = z.object({ sessionId: idSchema, turnId: idSchema }).strict();
export const liveEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(131072) }).strict(),
  z.object({ type: z.literal('audio'), pcm: z.instanceof(Float32Array).refine(value => value.length > 0 && value.length <= 192000 && value.every(Number.isFinite)), sampleRate: z.number().int().min(8000).max(96000) }).strict(),
]);
export type LiveEvent = z.infer<typeof liveEventSchema>;
export const liveInfoSchema = z.object({
  type: z.literal('opened'),
  sessionId: idSchema,
  inputSampleRate: z.number().int().min(8000).max(96000),
  outputSampleRate: z.number().int().min(8000).max(96000),
  vision: z.enum(['available', 'unavailable']),
  contextTokens: z.number().int().positive(),
}).strict();
export type LiveInfo = z.infer<typeof liveInfoSchema>;
export const liveAnswerSchema = z.object({
  type: z.literal('answer'),
  turnId: idSchema,
  text: z.string().max(131072),
  toolCalls: z.array(toolCallSchema).max(8),
  finishReason: z.enum(['stop', 'limit', 'interrupted']),
}).strict();
export type LiveAnswer = z.infer<typeof liveAnswerSchema>;
export const liveResultSchema = z.discriminatedUnion('type', [liveInfoSchema, liveAnswerSchema, z.object({ type: z.literal('transcript'), turnId: idSchema, text: z.string().max(131072) }).strict(), z.object({ type: z.literal('accepted') }).strict()]);
export type LiveResult = z.infer<typeof liveResultSchema>;
export type LiveEventHandler = ({ event }: { event: LiveEvent }) => Promise<void>;
export type LiveOpen = { type: 'open', sessionId: string, prepare: WorkerPrepareInput, instructions: string, tools: z.infer<typeof liveToolsSchema> };
export type LiveRequest = LiveOpen | { type: 'command', sessionId: string, command: LiveCommand };
export interface LiveScope {
  readonly info: LiveInfo;
  request({ command, onEvent }: { command: LiveCommand, onEvent: LiveEventHandler }): Promise<LiveResult>;
  interrupt({ turnId }: { turnId: string }): Promise<void>;
}
export type LiveOperation = {
  modelId: string,
  instructions: string,
  tools: z.infer<typeof liveToolsSchema>,
  signal: AbortSignal,
  onProgress: ({ progress }: { progress: Progress }) => void,
  operation: ({ scope }: { scope: LiveScope }) => Promise<void>,
};
export const TEST_ONLY = {
};
