import { z } from 'zod';
import type { GenerationMetrics } from '@/01-models/generation-metrics';
import { createTokenMetrics, MIN_OBSERVED_INTERVAL_MS } from '@/logic/generation-metrics/measurement';

const optionalCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().catch(undefined);
const optionalTime = z.number().positive().optional().catch(undefined);
const ollamaMetricsSchema = z.object({ eval_count: optionalCount, eval_duration: optionalTime, prompt_eval_count: optionalCount });
const usageSchema = z.object({ prompt_tokens: optionalCount, completion_tokens: optionalCount }).optional().catch(undefined);
const openAiMetricsSchema = z.object({
  timings: z.object({ predicted_n: optionalCount, predicted_ms: optionalTime, predicted_per_second: optionalTime }).optional().catch(undefined),
  usage: usageSchema,
});

export function readOllamaMetrics({ value }: { value: unknown }): GenerationMetrics | undefined {
  const parsed = ollamaMetricsSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const { eval_count, eval_duration, prompt_eval_count } = parsed.data;
  return createTokenMetrics({ measurement: 'ollama_eval', nInputTokens: prompt_eval_count, nOutputTokens: eval_count, nMeasuredTokens: eval_count, durationMs: eval_duration === undefined ? undefined : eval_duration / 1e6 });
}

export function readOpenAiMetrics({ value, requestDurationMs }: { value: unknown, requestDurationMs?: number }): GenerationMetrics | undefined {
  const parsed = openAiMetricsSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const { timings, usage } = parsed.data;
  if (timings !== undefined) {
    const result = createTokenMetrics({ measurement: 'llama_cpp_predicted', nInputTokens: usage?.prompt_tokens, nOutputTokens: timings.predicted_n, nMeasuredTokens: timings.predicted_n, durationMs: timings.predicted_ms, perSecond: timings.predicted_per_second });
    if (result !== undefined) {
      return result;
    }
  }
  if (requestDurationMs !== undefined && requestDurationMs >= MIN_OBSERVED_INTERVAL_MS) {
    return createTokenMetrics({ measurement: 'client_request', nInputTokens: usage?.prompt_tokens, nOutputTokens: usage?.completion_tokens, nMeasuredTokens: usage?.completion_tokens, durationMs: requestDurationMs });
  }
  return undefined;
}

export const TEST_ONLY = {
};
