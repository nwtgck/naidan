import type { Diagnostic, DiagnosticStage } from '@/features/llama-cpp-browser/debug-log';
import type { LlamaCppProfile } from '@/features/llama-cpp-browser/types';

type PerformanceSummary = NonNullable<Diagnostic['performance']>;

function sampleRate({ sampledTokens, elapsedMs }: { sampledTokens: number, elapsedMs: number }): NonNullable<PerformanceSummary['postFirstSample']> {
  const rate = sampledTokens > 0 && elapsedMs > 0 ? sampledTokens * 1000 / elapsedMs : undefined;
  // No rate exists without a post-first sample or a measurable interval.
  return { unit: 't/s', sampledTokens, elapsedMs, tokensPerSecond: rate !== undefined && Number.isFinite(rate) ? rate : undefined };
}

/** Bounded request-local counters; debug-only progress after 100 total samples
 * and at most every 3 seconds on a new sample, plus one final summary. No timer, native callbacks, token
 * histories, prompt bytes, token IDs or model names. */
export function createGenerationPerformance({ enabled, now }: { enabled: boolean, now: () => number }) {
  const started = enabled ? now() : 0;
  let since = started;
  let stage: DiagnosticStage = 'session';
  let finished = false;
  const stages = new Map<DiagnosticStage, { stage: DiagnosticStage, visits: number, elapsedMs: number }>();
  if (enabled) stages.set(stage, { stage, visits: 1, elapsedMs: 0 });
  const counters = {
    input: 'unknown' as PerformanceSummary['input'],
    sessionPreparation: undefined as PerformanceSummary['sessionPreparation'],
    contextTokens: undefined as number | undefined,
    maximumTokens: undefined as number | undefined,
    sampling: undefined as PerformanceSummary['sampling'],
    sampledTokens: 0,
    decodedTokens: 0,
    prefillDecodedTokens: 0,
    prefillDecodeCalls: 0,
    maximumPrefillBatchTokens: 0,
    promptTokens: undefined as number | undefined,
    reusedTokens: undefined as number | undefined,
    tokenizeCalls: 0,
    checkpointTokenizeCalls: 0,
    terminalDecodeDeferred: false,
    streaming: undefined as PerformanceSummary['streaming'],
    tokenRendering: undefined as PerformanceSummary['tokenRendering'],
    prefillOutputs: undefined as PerformanceSummary['prefillOutputs'],
    generationYield: undefined as PerformanceSummary['generationYield'],
    memoryReset: undefined as PerformanceSummary['memoryReset'],
    deliveryDecode: undefined as PerformanceSummary['deliveryDecode'],
  };
  let firstSampleMs: number | undefined;
  let lastSampleMs: number | undefined;
  let progressSampleMs: number | undefined;
  let progressSampledTokens = 0;
  let firstDeliveryMs: number | undefined;
  const settle = ({ at }: { at: number }): void => {
    const current = stages.get(stage);
    if (current) current.elapsedMs += Math.max(0, at - since);
    since = at;
  };
  const postFirstSample = (): NonNullable<PerformanceSummary['postFirstSample']> => sampleRate({
    sampledTokens: Math.max(0, counters.sampledTokens - 1),
    elapsedMs: firstSampleMs === undefined || lastSampleMs === undefined ? 0 : Math.max(0, lastSampleMs - firstSampleMs),
  });
  return {
    counters,
    enter({ next }: { next: DiagnosticStage }): void {
      if (!enabled || finished) return;
      settle({ at: now() });
      stage = next;
      const current = stages.get(stage);
      if (current) current.visits++;
      else stages.set(stage, { stage, visits: 1, elapsedMs: 0 });
    },
    sampled(): Diagnostic | undefined {
      if (finished) return undefined;
      counters.sampledTokens++;
      if (!enabled) return undefined;
      lastSampleMs = Math.max(0, now() - started);
      firstSampleMs ??= lastSampleMs;
      if (progressSampleMs === undefined) {
        progressSampleMs = lastSampleMs;
        progressSampledTokens = counters.sampledTokens;
      }
      if (counters.sampledTokens < 100 || lastSampleMs - progressSampleMs < 3000) return undefined;
      const interval = sampleRate({ sampledTokens: counters.sampledTokens - progressSampledTokens, elapsedMs: lastSampleMs - progressSampleMs });
      progressSampleMs = lastSampleMs;
      progressSampledTokens = counters.sampledTokens;
      return {
        event: 'generation-progress',
        generationThroughput: {
          sampledTokens: counters.sampledTokens,
          firstSampleMs,
          postFirstSample: postFirstSample(),
          interval,
        },
      };
    },
    delivered(): void {
      if (enabled && !finished && firstDeliveryMs === undefined) firstDeliveryMs = Math.max(0, now() - started);
    },
    finish({ outcome, profile }: { outcome: PerformanceSummary['outcome'], profile: LlamaCppProfile }): Diagnostic | undefined {
      if (!enabled || finished) return undefined;
      finished = true;
      const ended = now();
      settle({ at: ended });
      return {
        event: 'generation-performance',
        profile,
        elapsedMs: Math.max(0, ended - started),
        performance: {
          version: 1,
          outcome,
          ...counters,
          postFirstSample: postFirstSample(),
          sampling: counters.sampling ? { ...counters.sampling } : undefined,
          sessionPreparation: counters.sessionPreparation ? { ...counters.sessionPreparation } : undefined,
          streaming: counters.streaming ? { ...counters.streaming } : undefined,
          tokenRendering: counters.tokenRendering ? { ...counters.tokenRendering } : undefined,
          memoryReset: counters.memoryReset ? { ...counters.memoryReset } : undefined,
          deliveryDecode: counters.deliveryDecode ? { ...counters.deliveryDecode } : undefined,
          prefillOutputs: counters.prefillOutputs ? { ...counters.prefillOutputs } : undefined,
          generationYield: counters.generationYield ? { ...counters.generationYield } : undefined,
          firstSampleMs,
          firstDeliveryMs,
          stages: Array.from(stages.values(), entry => ({ ...entry })),
        },
      };
    },
  };
}

export const TEST_ONLY = {
};
