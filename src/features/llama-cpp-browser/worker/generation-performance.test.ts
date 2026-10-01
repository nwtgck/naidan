import { describe, expect, it, vi } from 'vitest';
import { diagnosticSchema, logDiagnostic } from '@/features/llama-cpp-browser/debug-log';
import { createGenerationPerformance } from './generation-performance';

const profile = 'cpu-wasm32' as const;

describe('bounded generation performance summaries', () => {
  it('performs no clock reads or reporting when disabled', () => {
    const now = vi.fn(() => 100);
    const metrics = createGenerationPerformance({ enabled: false, now });
    metrics.enter({ next: 'native-sample' }); metrics.sampled(); metrics.delivered();
    expect(metrics.finish({ outcome: 'completed', profile })).toBeUndefined();
    expect(now).not.toHaveBeenCalled();
  });
  it('measures exclusive stages including repeats and cleanup without keeping a token history', () => {
    let at = 10;
    const metrics = createGenerationPerformance({ enabled: true, now: () => at });
    at = 15; metrics.enter({ next: 'tokenize' }); metrics.counters.tokenizeCalls++;
    at = 19; metrics.enter({ next: 'native-sample' });
    at = 21; metrics.sampled(); metrics.enter({ next: 'stream-emit' });
    at = 25; metrics.delivered(); metrics.enter({ next: 'native-sample' });
    at = 28; metrics.sampled(); metrics.enter({ next: 'cleanup' });
    at = 30;
    const report = diagnosticSchema.parse(metrics.finish({ outcome: 'completed', profile }));
    expect(report.elapsedMs).toBe(20);
    expect(report.performance).toEqual({ version: 1, outcome: 'completed', input: 'unknown',
      sampledTokens: 2, decodedTokens: 0, prefillDecodedTokens: 0, prefillDecodeCalls: 0, maximumPrefillBatchTokens: 0, tokenizeCalls: 1, checkpointTokenizeCalls: 0,
      terminalDecodeDeferred: false, firstSampleMs: 11, firstDeliveryMs: 15,
      stages: [
        { stage: 'session', visits: 1, elapsedMs: 5 }, { stage: 'tokenize', visits: 1, elapsedMs: 4 },
        { stage: 'native-sample', visits: 2, elapsedMs: 5 }, { stage: 'stream-emit', visits: 1, elapsedMs: 4 },
        { stage: 'cleanup', visits: 1, elapsedMs: 2 },
      ],
    });
    expect(report.performance!.stages.reduce((sum, entry) => sum + entry.elapsedMs, 0)).toBe(report.elapsedMs);
    metrics.counters.decodedTokens = 99;
    metrics.enter({ next: 'native-sample' });
    expect(report.performance!.decodedTokens).toBe(0);
    expect(metrics.finish({ outcome: 'failed', profile })).toBeUndefined();
  });
  it.each(['aborted', 'failed'] as const)('reports %s without inventing a first token time', outcome => {
    const metrics = createGenerationPerformance({ enabled: true, now: () => 0 });
    const report = diagnosticSchema.parse(metrics.finish({ outcome, profile }));
    expect(report.performance!.outcome).toBe(outcome);
    expect(report.performance!.firstSampleMs).toBeUndefined();
    expect(report.performance!.firstDeliveryMs).toBeUndefined();
    expect(report.performance!.stages).toHaveLength(1);
  });
  it('keeps one aggregate per stage even after a long generation', () => {
    const metrics = createGenerationPerformance({ enabled: true, now: () => 0 });
    for (let i = 0; i < 10000; i++) {
      metrics.enter({ next: 'native-sample' }); metrics.sampled();
      metrics.enter({ next: 'generation-decode' }); metrics.counters.decodedTokens++;
    }
    const report = diagnosticSchema.parse(metrics.finish({ outcome: 'completed', profile }));
    expect(report.performance!.stages).toHaveLength(3);
    expect(report.performance!.sampledTokens).toBe(10000);
    expect(JSON.stringify(report).length).toBeLessThan(1500);
  });
  it('snapshots numeric settings without retaining a mutable sampling object', () => {
    const metrics = createGenerationPerformance({ enabled: true, now: () => 0 });
    const sampling = { temperature: 0.7, topP: 0.95, presencePenalty: -1, frequencyPenalty: 2, seed: 4294967295 };
    metrics.counters.sampling = sampling; metrics.counters.contextTokens = 4096; metrics.counters.maximumTokens = 128;
    const report = metrics.finish({ outcome: 'completed', profile })!;
    sampling.seed = 0;
    expect(report.performance!.sampling!.seed).toBe(4294967295);
    expect(diagnosticSchema.safeParse(report).success).toBe(true);
    expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, sampling: { ...sampling, prompt: 'private' } } }).success).toBe(false);
    expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, sampling: { ...sampling, seed: -1 } } }).success).toBe(false);
  });
  it('validates and publishes the summary without accepting nested content', () => {
    const metrics = createGenerationPerformance({ enabled: true, now: () => 0 });
    const report = metrics.finish({ outcome: 'completed', profile })!;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logDiagnostic({ diagnostic: report });
      expect(log).toHaveBeenCalledOnce();
      const untrusted = { ...report, performance: { ...report.performance!, prompt: 'private prompt', tokenIds: [123] } };
      expect(diagnosticSchema.safeParse(untrusted).success).toBe(false);
      logDiagnostic({ diagnostic: untrusted });
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain('private');
      expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!,
        stages: [{ stage: 'tokenize', visits: 1, elapsedMs: 2, tokenIds: [123] }] } }).success).toBe(false);
    } finally {
      log.mockRestore();
    }
  });
});

describe('streaming work counters', () => {
  it('snapshots the bounded counters and rejects extra content-bearing fields', () => {
    const metrics = createGenerationPerformance({ enabled: true, now: () => 0 });
    const streaming = { mode: 'coalesced' as const, partialParseCalls: 3, finalParseCalls: 1,
      parsedCodeUnits: 30, skippedPartialParses: 14, deliveredEvents: 2 };
    metrics.counters.streaming = streaming;
    const report = diagnosticSchema.parse(metrics.finish({ outcome: 'completed', profile }));
    streaming.partialParseCalls = 999;
    expect(report.performance!.streaming!.partialParseCalls).toBe(3);
    expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!,
      streaming: { ...streaming, output: 'private' } } }).success).toBe(false);
    expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!,
      streaming: { ...streaming, parsedCodeUnits: -1 } } }).success).toBe(false);
    // Additive version-1 compatibility: 012 summaries have no streaming field.
    expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, streaming: undefined } }).success).toBe(true);
  });
});


describe('token rendering work counters', () => {
  it('snapshots bounded counters without accepting cached bytes or token identifiers', () => {
    const metrics = createGenerationPerformance({ enabled: true, now: () => 0 });
    const tokenRendering = { cacheHits: 32, cacheMisses: 1, eogCalls: 1, pieceCalls: 1,
      evictions: 0, oversizedPieces: 0, peakEntries: 1, peakCachedBytes: 1 };
    metrics.counters.tokenRendering = tokenRendering;
    const report = diagnosticSchema.parse(metrics.finish({ outcome: 'completed', profile }));
    tokenRendering.cacheHits = 100;
    expect(report.performance!.tokenRendering!.cacheHits).toBe(32);
    for (const extra of [{ token: 123 }, { bytes: [65] }, { peakEntries: 1025 }, { peakCachedBytes: 262145 }, { cacheHits: -1 },
      { allocationFallbacks: -1 }, { allocationFallbacks: 0.5 }, { allocationFallbacks: 2 }]) {
      expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, tokenRendering: { ...tokenRendering, ...extra } } }).success).toBe(false);
    }
    for (const allocationFallbacks of [undefined, 0, 1]) {
      expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, tokenRendering: { ...tokenRendering, allocationFallbacks } } }).success).toBe(true);
    }
    expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, tokenRendering: undefined } }).success).toBe(true);
  });
});

describe('prefill output work counters', () => {
  it('snapshots requested outputs without accepting logits or token identities', () => {
    const metrics = createGenerationPerformance({ enabled: true, now: () => 0 });
    const prefillOutputs = { requestedLogits: 1, skippedLogits: 7, allocationFallbacks: 0 };
    metrics.counters.prefillOutputs = prefillOutputs;
    const report = diagnosticSchema.parse(metrics.finish({ outcome: 'completed', profile }));
    prefillOutputs.skippedLogits = 999;
    expect(report.performance!.prefillOutputs!.skippedLogits).toBe(7);
    for (const extra of [{ logits: [1] }, { tokens: [123] }, { skippedLogits: -1 }, { requestedLogits: 1.5 }, { allocationFallbacks: 2 }]) {
      expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, prefillOutputs: { ...prefillOutputs, ...extra } } }).success).toBe(false);
    }
    expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, prefillOutputs: undefined } }).success).toBe(true);
  });
});

describe('generation task yield counters', () => {
  it('snapshots additive scheduling counts without accepting content or token histories', () => {
    const metrics = createGenerationPerformance({ enabled: true, now: () => 0 });
    const generationYield = { mode: 'coalesced' as const, checks: 32, requestedYields: 8,
      completedYields: 8, coalescedYields: 24, maximumDecodesBetweenYields: 4 };
    metrics.counters.generationYield = generationYield;
    const report = diagnosticSchema.parse(metrics.finish({ outcome: 'completed', profile }));
    generationYield.completedYields = 99;
    expect(report.performance!.generationYield!.completedYields).toBe(8);
    for (const extra of [{ content: 'private' }, { tokens: [1] }, { checks: -1 },
      { completedYields: 0.5 }, { mode: 'unknown' }, { maximumDecodesBetweenYields: 5 }]) {
      expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!,
        generationYield: { ...generationYield, ...extra } } }).success).toBe(false);
    }
    expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, generationYield: undefined } }).success).toBe(true);
  });
});

describe('initial memory reset counters', () => {
  it('snapshots the one-use counters and rejects private or invalid fields', () => {
    const metrics = createGenerationPerformance({ enabled: true, now: () => 0 });
    const memoryReset = { requestedClears: 0, skippedInitialClears: 1 };
    metrics.counters.memoryReset = memoryReset;
    const report = diagnosticSchema.parse(metrics.finish({ outcome: 'completed', profile }));
    memoryReset.skippedInitialClears = 0;
    expect(report.performance!.memoryReset).toEqual({ requestedClears: 0, skippedInitialClears: 1 });
    for (const extra of [{ skippedInitialClears: 2 }, { requestedClears: -1 }, { requestedClears: 0.5 }, { pointer: '123' }, { tokens: [1] }]) {
      expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, memoryReset: { ...memoryReset, ...extra } } }).success).toBe(false);
    }
    expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, memoryReset: undefined } }).success).toBe(true);
  });
});


describe('paired delivery and decode accounting', () => {
  it('keeps joint time exclusive and child waits explicitly overlapping', () => {
    let now = 0;
    const metrics = createGenerationPerformance({ enabled: true, now: () => now });
    const pair = { mode: 'overlap' as const, pairedSteps: 1, settledPairs: 1, serialSteps: 0,
      deliveryWaitMs: 20, decodeWaitMs: 30, jointWaitMs: 30 };
    metrics.counters.deliveryDecode = pair;
    metrics.enter({ next: 'generation-overlap' });
    now = 30; metrics.enter({ next: 'cleanup' }); now = 35;
    const report = diagnosticSchema.parse(metrics.finish({ outcome: 'completed', profile }));
    expect(report.performance!.stages.reduce((sum, item) => sum + item.elapsedMs, 0)).toBe(35);
    expect(report.performance!.deliveryDecode).toEqual(pair);
    pair.pairedSteps = 99;
    expect(report.performance!.deliveryDecode!.pairedSteps).toBe(1);
    for (const extra of [{ text: 'private' }, { token: 17 }, { pairedSteps: -1 }, { decodeWaitMs: Infinity }]) {
      expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, deliveryDecode: { ...pair, ...extra } } }).success).toBe(false);
    }
    expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, deliveryDecode: undefined } }).success).toBe(true);
  });
});


describe('session preparation measurements', () => {
  it.each(['absent', 'deferred', 'retained', 'loaded', 'reused'] as const)('snapshots the %s preparation outcome without private data', projector => {
    const measurements = createGenerationPerformance({ enabled: true, now: () => 0 });
    const preparation = { projector, releasedTextContext: false };
    measurements.counters.sessionPreparation = preparation;
    const report = measurements.finish({ outcome: 'completed', profile })!;
    preparation.releasedTextContext = true;
    expect(diagnosticSchema.parse(report).performance!.sessionPreparation).toEqual({ projector, releasedTextContext: false });
    expect(diagnosticSchema.safeParse({ ...report, performance: { ...report.performance!, sessionPreparation: { ...preparation, model: 'private' } } }).success).toBe(false);
  });
});
