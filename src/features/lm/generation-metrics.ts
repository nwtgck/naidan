import { z } from 'zod';
import { parseGenerationMetrics, type GenerationMetrics } from '@/01-models/generation-metrics';
import { createTokenMetrics, MIN_OBSERVED_INTERVAL_MS } from '@/logic/generation-metrics/measurement';

const optionalCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().catch(undefined);
const optionalTime = z.number().positive().optional().catch(undefined);
const ollamaMetricsSchema = z.object({ eval_count: optionalCount, eval_duration: optionalTime, prompt_eval_count: optionalCount });
const usageSchema = z.object({ prompt_tokens: optionalCount, completion_tokens: optionalCount }).optional().catch(undefined);
const openAiMetricsSchema = z.object({
  timings: z.object({
    predicted_n: optionalCount,
    predicted_ms: z.number().nonnegative().optional().catch(undefined),
    // Missing means a count-only extension. Zero means unmeasurable; null also
    // represents malformed supplied rates. Neither may fall back to N / time.
    predicted_per_second: z.number().nonnegative().nullable().optional().catch(null),
  }).optional().catch(undefined),
  usage: usageSchema,
});

export type OpenAiNativeTiming = {
  nOutputTokens: number | undefined,
  durationMs: number | undefined,
  metrics: GenerationMetrics | undefined,
};

export function readOllamaMetrics({ value }: { value: unknown }): GenerationMetrics | undefined {
  const parsed = ollamaMetricsSchema.safeParse(value);
  if (!parsed.success) {
    return undefined;
  }
  const { eval_count, eval_duration, prompt_eval_count } = parsed.data;
  return createTokenMetrics({ measurement: 'ollama_eval', nInputTokens: prompt_eval_count, nOutputTokens: eval_count, nMeasuredTokens: eval_count, durationMs: eval_duration === undefined ? undefined : eval_duration / 1e6 });
}

/** Preserve the provider's rate. A count is not necessarily its rate numerator. */
export function readOpenAiNativeTiming({ value }: { value: unknown }): OpenAiNativeTiming | undefined {
  const parsed = openAiMetricsSchema.safeParse(value);
  if (!parsed.success || parsed.data.timings === undefined) {
    return undefined;
  }
  const { timings, usage } = parsed.data;
  const { predicted_n: nOutputTokens, predicted_ms: durationMs, predicted_per_second: perSecond } = timings;
  const hasInterval = nOutputTokens !== undefined && durationMs !== undefined;
  if (!hasInterval && (perSecond === undefined || perSecond === null)) {
    return undefined;
  }
  const reading: OpenAiNativeTiming = { nOutputTokens, durationMs, metrics: undefined };
  if ((nOutputTokens !== undefined && nOutputTokens < 2) || durationMs === 0 || perSecond === 0 || perSecond === null) {
    return reading;
  }
  const nInputTokens = usage?.prompt_tokens;
  if (perSecond === undefined) {
    // No version/denominator evidence: preserve count-only compatible servers.
    // In particular, /props advertising timings_per_token does not imply N - 1.
    reading.metrics = createTokenMetrics({ measurement: 'llama_cpp_predicted', nInputTokens, nOutputTokens, nMeasuredTokens: nOutputTokens, durationMs });
    return reading;
  }
  const reported = createTokenMetrics({ measurement: 'llama_cpp_predicted', nInputTokens, nOutputTokens, perSecond });
  if (reported !== undefined && nOutputTokens !== undefined && durationMs !== undefined) {
    // Current llama.cpp excludes the first token; older/compatible producers may
    // count it. Attach only an unambiguous, schema-consistent measured interval.
    // Rounded or unfamiliar rates remain rate-only, never a fabricated interval.
    const candidates = [nOutputTokens - 1, nOutputTokens].map(nUnits => parseGenerationMetrics({
      value: { ...reported, speed: { ...reported.speed, interval: { nUnits, durationMs } } },
    })).filter(metrics => metrics !== undefined);
    if (candidates.length === 1) {
      reading.metrics = candidates[0];
      return reading;
    }
  }
  reading.metrics = reported;
  return reading;
}

export function readOpenAiUsage({ value }: { value: unknown }): z.infer<typeof usageSchema> {
  const parsed = openAiMetricsSchema.safeParse(value);
  return parsed.success ? parsed.data.usage : undefined;
}

export function readOpenAiMetrics({ value, requestDurationMs }: { value: unknown, requestDurationMs?: number }): GenerationMetrics | undefined {
  const native = readOpenAiNativeTiming({ value });
  if (native !== undefined) {
    // Do not reinterpret an explicit zero/native warm-up using a different clock.
    return native.metrics;
  }
  const usage = readOpenAiUsage({ value });
  if (requestDurationMs !== undefined && requestDurationMs >= MIN_OBSERVED_INTERVAL_MS) {
    return createTokenMetrics({ measurement: 'client_request', nInputTokens: usage?.prompt_tokens, nOutputTokens: usage?.completion_tokens, nMeasuredTokens: usage?.completion_tokens, durationMs: requestDurationMs });
  }
  return undefined;
}

export const TEST_ONLY = {
};
