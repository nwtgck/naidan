import { z } from 'zod';
import { toToolCallId } from '@/01-models/ids';

const position = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

// Serializable inference protocol. Iterator/Promise ownership remains in the client.
export const inferenceGenerationEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('part_start'), index: position, kind: z.enum(['text', 'reasoning']) }),
  z.object({ type: z.literal('text_delta'), index: position, text: z.string() }),
  z.object({ type: z.literal('part_end'), index: position, completeness: z.enum(['complete', 'partial']) }),
  z.object({ type: z.literal('tool_start'), index: position }),
  z.object({
    type: z.literal('tool_call'), index: position,
    toolCall: z.object({
      id: z.string().transform(raw => toToolCallId({ raw })),
      type: z.literal('function'),
      function: z.object({ name: z.string().min(1), arguments: z.string() }),
    }),
  }),
  z.object({ type: z.literal('result'), result: z.discriminatedUnion('type', [
    z.object({ type: z.literal('finished'), next: z.enum(['user', 'tool_results']) }),
    z.object({ type: z.literal('interrupted'), reason: z.enum(['aborted', 'limit', 'unknown']) }),
  ]) }),
]);
export type InferenceGenerationEvent = z.infer<typeof inferenceGenerationEventSchema>;
export type InferenceGenerationCallback = ({ event }: { event: InferenceGenerationEvent }) => void | Promise<void>;

export const TEST_ONLY = {
};
