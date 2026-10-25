import { z } from 'zod';

const countSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const intervalSchema = z.object({ nUnits: countSchema.positive(), durationMs: z.number().positive() }).strict();
const speedFields = { perSecond: z.number().positive(), interval: intervalSchema.optional() };

/** Display telemetry, never a persisted message field. The interval is its actual numerator/denominator. */
export const generationMetricsSchema = z.object({
  nInputTokens: countSchema.optional(),
  nOutputTokens: countSchema.optional(),
  speed: z.discriminatedUnion('unit', [
    z.object({ unit: z.literal('tokens'), measurement: z.enum(['ollama_eval', 'llama_cpp_predicted', 'worker_sample_interval', 'client_request']), ...speedFields }).strict(),
    z.object({ unit: z.literal('characters'), measurement: z.literal('received_text'), ...speedFields }).strict(),
  ]),
}).strict().refine(metrics => {
  const { perSecond, interval } = metrics.speed;
  if (interval === undefined) {
    return true;
  }
  const calculated = interval.nUnits / interval.durationMs * 1000;
  return Number.isFinite(calculated) && calculated > 0 && Math.abs(perSecond - calculated) <= Math.max(1, calculated) * 1e-8;
});

export type GenerationMetrics = z.infer<typeof generationMetricsSchema>;
export type GenerationSpeed = GenerationMetrics['speed'];
export type GenerationMetricsObserver = ({ metrics }: { metrics: GenerationMetrics }) => void;

/** Untrusted optional telemetry must never invalidate otherwise valid generation data. */
export function parseGenerationMetrics({ value }: { value: unknown }): GenerationMetrics | undefined {
  const result = generationMetricsSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function reportGenerationMetrics({ observer, metrics }: { observer: GenerationMetricsObserver | undefined, metrics: GenerationMetrics | undefined }): void {
  if (metrics === undefined || observer === undefined) {
    return;
  }
  try {
    void Promise.resolve(observer({ metrics })).catch(() => {});
  } catch { /* Display observers must not change the inference outcome. */ }
}

export type GenerationMetricsPresentation = {
  runId: number,
  metrics: GenerationMetrics,
  live: boolean,
  updatedAt: number,
  scope: 'current' | 'turn' | 'last',
  /** Earlier calls evicted from the bounded detail history. */
  nOmittedCalls?: number,
  calls: readonly { metrics: GenerationMetrics | undefined }[],
};

export const TEST_ONLY = {
};
