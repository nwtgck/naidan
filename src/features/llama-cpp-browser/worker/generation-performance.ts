import type { Diagnostic, DiagnosticStage } from '@/features/llama-cpp-browser/debug-log';
import type { LlamaCppProfile } from '@/features/llama-cpp-browser/types';
import { earlyGenerationTimingLimit, type EarlyGenerationTiming } from '@/features/llama-cpp-browser/performance/early-generation-timing-schema';

type PerformanceSummary = NonNullable<Diagnostic['performance']>;

function readClock({ now, state }: { now: () => number, state: { last: number, anomalies: number } }): number {
  try {
    const at = now();
    if (Number.isFinite(at) && at >= state.last) {
      state.last = at;
      return at;
    }
  } catch { /* Measurement must not interrupt generation or cleanup. */ }
  state.anomalies = Math.min(Number.MAX_SAFE_INTEGER, state.anomalies + 1);
  return state.last;
}

function sampleRate({ sampledTokens, elapsedMs }: { sampledTokens: number, elapsedMs: number }): NonNullable<PerformanceSummary['postFirstSample']> {
  const rate = sampledTokens > 0 && elapsedMs > 0 ? sampledTokens * 1000 / elapsedMs : undefined;
  // No rate exists without a post-first sample or a measurable interval.
  return { unit: 't/s', sampledTokens, elapsedMs, tokensPerSecond: rate !== undefined && Number.isFinite(rate) ? rate : undefined };
}

/** Bounded request-local counters; debug-only progress after 100 total samples
 * and at most every 3 seconds on a new sample, plus one final summary. No timer, native callbacks, token
 * unbounded histories, prompt bytes, token IDs or model names. Early stage and
 * sample timings reuse existing clocks and are allocated only when enabled. */
export function createGenerationPerformance({ enabled, now }: { enabled: boolean, now: () => number }) {
  const clock = enabled ? { now, state: { last: 0, anomalies: 0 } } : undefined;
  const started = clock ? readClock(clock) : 0;
  let since = started;
  let stage: DiagnosticStage = 'session';
  let finished = false;
  const stageIntervals: EarlyGenerationTiming['stageIntervals'] | undefined = enabled ? [] : undefined;
  const samples: EarlyGenerationTiming['samples'] | undefined = enabled ? [] : undefined;
  let sampleIntervals = 0;
  let decodeIntervals = 0;
  let intervalStage: EarlyGenerationTiming['stageIntervals'][number]['stage'] | undefined;
  let intervalOrdinal = 0;
  let intervalSampleCount = 0;
  let intervalsTruncated = false;
  let samplesTruncated = false;
  const stages = new Map<DiagnosticStage, { stage: DiagnosticStage, visits: number, elapsedMs: number }>();
  if (enabled) {
    stages.set(stage, { stage, visits: 1, elapsedMs: 0 });
  }
  const counters = {
    visionStorage: undefined as PerformanceSummary['visionStorage'],
    gpuProfile: undefined as PerformanceSummary['gpuProfile'],
    checkpoint: undefined as PerformanceSummary['checkpoint'],
    cacheReuse: undefined as PerformanceSummary['cacheReuse'],
    backendCensus: undefined as PerformanceSummary['backendCensus'],
    nativeGraphCounters: undefined as PerformanceSummary['nativeGraphCounters'],
    memoryObservation: undefined as PerformanceSummary['memoryObservation'],
    sampleWindows: enabled ? [] as NonNullable<PerformanceSummary['sampleWindows']> : undefined,
    input: 'unknown' as PerformanceSummary['input'],
    sessionPreparation: undefined as PerformanceSummary['sessionPreparation'],
    contextTokens: undefined as number | undefined,
    maximumTokens: undefined as number | undefined,
    sampling: undefined as PerformanceSummary['sampling'],
    sampledTokens: 0,
    nonEogTokens: 0,
    firstNonEogSampleMs: undefined as number | undefined,
    lastNonEogSampleMs: undefined as number | undefined,
    prefillBatchTokens: undefined as number | undefined,
    runtimeAssetBaseURL: undefined as string | undefined,
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
  const settle = ({ at, closedBy }: { at: number, closedBy: EarlyGenerationTiming['stageIntervals'][number]['closedBy'] }): void => {
    const elapsedMs = Math.max(0, at - since);
    const current = stages.get(stage);
    if (current) {
      current.elapsedMs += elapsedMs;
    }
    if (stageIntervals && intervalStage !== undefined) {
      if (intervalOrdinal <= earlyGenerationTimingLimit) {
        stageIntervals.push({ stage: intervalStage, ordinal: intervalOrdinal, sampleCountAtStart: intervalSampleCount, startMs: since - started, elapsedMs, closedBy });
      } else {
        intervalsTruncated = true;
      }
    }
    since = at;
  };
  const postFirstSample = (): NonNullable<PerformanceSummary['postFirstSample']> => sampleRate({
    sampledTokens: Math.max(0, counters.sampledTokens - 1),
    elapsedMs: firstSampleMs === undefined || lastSampleMs === undefined ? 0 : Math.max(0, lastSampleMs - firstSampleMs),
  });
  return {
    counters,
    enter({ next }: { next: DiagnosticStage }): void {
      if (!enabled || finished) {
        return;
      }
      settle({ at: readClock(clock!), closedBy: 'stage-transition' });
      stage = next;
      intervalStage = undefined;
      switch (stage) {
      case 'native-sample':
        intervalStage = stage;
        sampleIntervals = Math.min(earlyGenerationTimingLimit + 1, sampleIntervals + 1);
        intervalOrdinal = sampleIntervals;
        break;
      case 'generation-overlap': case 'generation-decode':
        intervalStage = stage;
        decodeIntervals = Math.min(earlyGenerationTimingLimit + 1, decodeIntervals + 1);
        intervalOrdinal = decodeIntervals;
        break;
      case 'audio-info': case 'audio-reference': case 'audio-input': case 'audio-prompt': case 'audio-frame': case 'audio-output':
      case 'media-encode': case 'media-decode': case 'model-resolve': case 'model-load': case 'projector-trace': case 'projector-load':
      case 'image-decode': case 'image-tokenize': case 'image-evaluate': case 'session': case 'cache-prepare': case 'cache-probe':
      case 'cache-checkpoint': case 'prefill': case 'template': case 'tokenize': case 'prefill-decode': case 'sampler-create':
      case 'reasoning-state': case 'grammar-switch': case 'reasoning-accept': case 'reasoning-replay':
      case 'token-render': case 'partial-parse': case 'stream-emit': case 'final-parse': case 'cleanup': case 'event-loop-yield':
      case 'worker-operation': case 'worker-callback': case 'worker-rpc': case 'worker-error': case 'worker-messageerror': break;
      default: {
        const exhaustive: never = stage;
        throw new Error(`Unhandled generation timing stage: ${exhaustive}`);
      }
      }
      intervalSampleCount = counters.sampledTokens;
      const current = stages.get(stage);
      if (current) {
        current.visits++;
      } else {
        stages.set(stage, { stage, visits: 1, elapsedMs: 0 });
      }
    },
    sampled(): Diagnostic | undefined {
      if (finished) {
        return undefined;
      }
      counters.sampledTokens++;
      if (!enabled) {
        return undefined;
      }
      lastSampleMs = Math.max(0, readClock(clock!) - started);
      if (samples && samples.length < earlyGenerationTimingLimit) {
        samples.push({ ordinal: counters.sampledTokens, atMs: lastSampleMs });
      } else {
        samplesTruncated = true;
      }
      firstSampleMs ??= lastSampleMs;
      if (progressSampleMs === undefined) {
        progressSampleMs = lastSampleMs;
        progressSampledTokens = counters.sampledTokens;
      }
      if (counters.sampledTokens < 100 || lastSampleMs - progressSampleMs < 3000) {
        return undefined;
      }
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
    rendered({ endOfGeneration }: { endOfGeneration: boolean }): void {
      if (endOfGeneration || !enabled || finished) {
        return;
      }
      counters.nonEogTokens++;
      counters.firstNonEogSampleMs ??= lastSampleMs;
      counters.lastNonEogSampleMs = lastSampleMs;
      const windows = counters.sampleWindows;
      if (windows && lastSampleMs !== undefined) {
        const current = windows.at(-1);
        if (!current || current.lastSample - current.firstSample >= 15) {
          if (windows.length < 256) {
            windows.push({ firstSample: counters.nonEogTokens, lastSample: counters.nonEogTokens, firstMs: lastSampleMs, lastMs: lastSampleMs });
          }
        } else {
          current.lastSample = counters.nonEogTokens;
          current.lastMs = lastSampleMs;
        }
      }
    },
    delivered(): void {
      if (enabled && !finished && firstDeliveryMs === undefined) {
        firstDeliveryMs = Math.max(0, readClock(clock!) - started);
      }
    },
    finish({ outcome, profile }: { outcome: PerformanceSummary['outcome'], profile: LlamaCppProfile }): Diagnostic | undefined {
      if (!enabled || finished) {
        return undefined;
      }
      finished = true;
      const ended = readClock(clock!);
      settle({ at: ended, closedBy: 'request-finish' });
      return {
        event: 'generation-performance',
        profile,
        elapsedMs: Math.max(0, ended - started),
        performance: {
          version: 1,
          outcome,
          ...counters,
          postFirstSample: postFirstSample(),
          nativeGraphCounters: counters.nativeGraphCounters ? {
            ...counters.nativeGraphCounters,
            before: counters.nativeGraphCounters.before ? { ...counters.nativeGraphCounters.before } : undefined,
            after: counters.nativeGraphCounters.after ? { ...counters.nativeGraphCounters.after } : undefined,
          } : undefined,
          memoryObservation: counters.memoryObservation ? { ...counters.memoryObservation } : undefined,
          sampleWindows: counters.sampleWindows?.map(window => ({ ...window })),
          earlyGenerationTiming: stageIntervals && samples ? {
            version: 1,
            limit: earlyGenerationTimingLimit,
            stageIntervals: stageIntervals.map(interval => ({ ...interval })),
            samples: samples.map(sample => ({ ...sample })),
            intervalsTruncated,
            samplesTruncated,
            clockAnomalies: clock!.state.anomalies,
          } : undefined,
          sampling: counters.sampling ? { ...counters.sampling } : undefined,
          sessionPreparation: counters.sessionPreparation ? { ...counters.sessionPreparation } : undefined,
          cacheReuse: counters.cacheReuse ? { ...counters.cacheReuse } : undefined,
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
