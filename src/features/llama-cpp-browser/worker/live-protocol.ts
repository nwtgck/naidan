import { z } from 'zod';
import { liveCommandSchema, liveToolsSchema } from '@/features/llama-cpp-browser/live-types';
import { workerPrepareInputSchema } from './types';
export const liveRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open'), sessionId: z.string().min(1).max(128), prepare: workerPrepareInputSchema, instructions: z.string().max(16384), tools: liveToolsSchema }).strict(),
  z.object({ type: z.literal('command'), sessionId: z.string().min(1).max(128), command: liveCommandSchema }).strict(),
]);
export const TEST_ONLY = {
};
