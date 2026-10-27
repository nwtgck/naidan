import type { GenerationMetrics } from '@/01-models/generation-metrics';
import { MIN_OBSERVED_INTERVAL_MS } from '@/logic/generation-metrics/measurement';
import { readOpenAiMetrics, readOpenAiNativeTiming, readOpenAiUsage, type OpenAiNativeTiming } from './generation-metrics';

/** Per model call, not per endpoint. Native time never mixes with request latency. */
export function createOpenAiGenerationMetricsReader() {
  let nativeSeen = false;
  let lastCount: number | undefined;
  let lastDuration: number | undefined;
  let firstRateAt: number | undefined;

  function regressed({ reading }: { reading: OpenAiNativeTiming }): boolean {
    return (reading.nOutputTokens !== undefined && lastCount !== undefined && reading.nOutputTokens < lastCount)
      || (reading.durationMs !== undefined && lastDuration !== undefined && reading.durationMs < lastDuration);
  }

  return {
    hasNativeTiming(): boolean {
      return nativeSeen;
    },
    live({ value, now }: { value: unknown, now: number }): GenerationMetrics | undefined {
      const reading = readOpenAiNativeTiming({ value });
      if (reading === undefined) {
        return undefined;
      }
      // Even a first-token/zero-rate reading establishes native telemetry. Do not
      // oscillate through characters while waiting for a measurable decode span.
      nativeSeen = true;
      if (!Number.isFinite(now) || reading.metrics === undefined || regressed({ reading })) {
        return undefined;
      }
      // Only usable samples advance the high-water marks. A malformed rate with
      // huge counters must not poison all later otherwise valid observations.
      const duplicate = reading.nOutputTokens !== undefined && reading.durationMs !== undefined
        && reading.nOutputTokens === lastCount && reading.durationMs === lastDuration;
      if (reading.nOutputTokens !== undefined) {
        lastCount = reading.nOutputTokens;
      }
      if (reading.durationMs !== undefined) {
        lastDuration = reading.durationMs;
      }
      if (duplicate) {
        return undefined;
      }
      if (reading.durationMs !== undefined) {
        return reading.durationMs >= MIN_OBSERVED_INTERVAL_MS ? reading.metrics : undefined;
      }
      // A rate-only extension cannot expose a native interval. Gate its display
      // across observations, but never use this clock to manufacture that interval.
      if (firstRateAt === undefined) {
        firstRateAt = now;
        return undefined;
      }
      return now - firstRateAt >= MIN_OBSERVED_INTERVAL_MS ? reading.metrics : undefined;
    },
    final({ value, requestDurationMs }: { value: unknown, requestDurationMs: number }): GenerationMetrics | null | undefined {
      const reading = readOpenAiNativeTiming({ value });
      if (reading !== undefined) {
        nativeSeen = true;
        // null clears a provisional total; undefined means no new metadata.
        // Short completed spans are valid even when no live value was published.
        return regressed({ reading }) ? null : reading.metrics ?? null;
      }
      if (nativeSeen) {
        const nCompleted = readOpenAiUsage({ value })?.completion_tokens;
        // Metadata-only streams can report timings before final usage. A later
        // different count invalidates that provisional total, not its live sample.
        return nCompleted !== undefined && lastCount !== undefined && nCompleted !== lastCount ? null : undefined;
      }
      return readOpenAiMetrics({ value, requestDurationMs });
    },
  };
}

export const TEST_ONLY = {
};
