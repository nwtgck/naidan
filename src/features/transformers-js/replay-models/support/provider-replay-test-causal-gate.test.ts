// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseProviderReplayTextEvidence, replayRecordedText } from './provider-replay-test-causal-gate';

// Synthetic mechanics only; these tests are not model compatibility coverage.
function recording() {
  return parseProviderReplayTextEvidence({ value: {
    schemaVersion: 1,
    identity: { modelId: 'example/model', resolvedRevision: 'a'.repeat(40), investigationRunId: 'synthetic', transformersJsVersion: 'test-fixture' },
    scenario: {
      id: 'synthetic-prefix', messages: [{ role: 'user', content: 'Synthetic' }], tools: [],
      lmParameters: { temperature: 0, topP: 1, maxCompletionTokens: 2 },
      boundary: { kind: 'natural-prefix', lengthRelation: 'equals-requested-budget', stopCause: 'not-recorded' },
    },
    inputContract: {
      inputTokenIds: [10, 20], inputTensorFacts: [
        { name: 'attention_mask', dtype: 'int64', dims: [1, 2], location: 'cpu' },
        { name: 'input_ids', dtype: 'int64', dims: [1, 2], location: 'cpu' },
      ], effectiveGenerationConfig: { maxNewTokens: 2, temperature: 0, topP: 1, doSample: false },
    },
    modelReplay: {
      source: 'production-lane', sourceInputTokenIds: [10, 20],
      sourceInputSha256: createHash('sha256').update('[10,20]').digest('hex'),
      generatedTokenIds: [30, 40], generatedSequenceTokenIds: [10, 20, 30, 40], generatedText: 'Synthetic output',
    },
    expectedProviderSemantic: { basis: 'production-positive-control', captureScope: 'prefix', visibleContent: 'Synthetic output' },
  } });
}

function nativeOptions() {
  const put = vi.fn();
  const end = vi.fn();
  const options: Record<string, unknown> = {
    input_ids: { type: 'int64', dims: [1, 2], data: BigInt64Array.of(10n, 20n), location: 'cpu' },
    attention_mask: { type: 'int64', dims: [1, 2], data: BigInt64Array.of(1n, 1n), location: 'cpu' },
    max_new_tokens: 2, temperature: 0, top_p: 1, do_sample: false,
    past_key_values: undefined, return_dict_in_generate: true, streamer: { put, end },
    stopping_criteria: () => [false],
  };
  return { options, put, end };
}

function endedRecording() {
  const evidence = recording();
  return parseProviderReplayTextEvidence({ value: {
    ...evidence,
    scenario: {
      ...evidence.scenario, lmParameters: { ...evidence.scenario.lmParameters, maxCompletionTokens: 3 },
      boundary: { kind: 'recorded-ending', lengthRelation: 'below-requested-budget', lastTokenId: 40, stopCause: 'not-recorded' },
    },
    inputContract: { ...evidence.inputContract, effectiveGenerationConfig: { ...evidence.inputContract.effectiveGenerationConfig, maxNewTokens: 3 } },
    expectedProviderSemantic: { ...evidence.expectedProviderSemantic, captureScope: 'recorded-output' },
  } });
}

describe('Captured text causal gate mechanics', () => {
  it('releases the prompt and separate token steps only after source checks', () => {
    const fixture = nativeOptions();
    expect(replayRecordedText({ evidence: recording(), options: fixture.options }))
      .toEqual({ sequenceTokenIds: [10n, 20n, 30n, 40n], releasedTokenCount: 2 });
    expect(fixture.put.mock.calls).toEqual([[[[10n, 20n]]], [[[30n]]], [[[40n]]]]);
    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it('rejects a different actual prompt without releasing any token', () => {
    const fixture = nativeOptions();
    fixture.options['input_ids'] = { type: 'int64', dims: [1, 2], data: BigInt64Array.of(10n, 21n), location: 'cpu' };
    expect(() => replayRecordedText({ evidence: recording(), options: fixture.options })).toThrow('actual source input');
    expect(fixture.put).not.toHaveBeenCalled();
    expect(fixture.end).not.toHaveBeenCalled();
  });

  it('rejects changed sampling before releasing the captured output', () => {
    const fixture = nativeOptions();
    fixture.options['temperature'] = 1;
    expect(() => replayRecordedText({ evidence: recording(), options: fixture.options })).toThrow('actual requested settings');
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('rejects altered attention even when the token IDs still match', () => {
    const fixture = nativeOptions();
    fixture.options['attention_mask'] = { type: 'int64', dims: [1, 2], data: BigInt64Array.of(1n, 0n), location: 'cpu' };
    expect(() => replayRecordedText({ evidence: recording(), options: fixture.options })).toThrow('unpadded attention mask');
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('rejects incorrect input dimensions even when all token values match', () => {
    const fixture = nativeOptions();
    fixture.options['input_ids'] = { type: 'int64', dims: [1, 3], data: BigInt64Array.of(10n, 20n), location: 'cpu' };
    expect(() => replayRecordedText({ evidence: recording(), options: fixture.options })).toThrow('actual tensor facts');
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('does not silently pretend captured stateless input describes a cached continuation', () => {
    const fixture = nativeOptions();
    fixture.options['past_key_values'] = { syntheticCache: true };
    expect(() => replayRecordedText({ evidence: recording(), options: fixture.options })).toThrow('Replay evidence gap: KV-cache input');
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('rejects a recorded output sequence whose input prefix was replaced', () => {
    const evidence = recording();
    evidence.modelReplay.generatedSequenceTokenIds = [11, 20, 30, 40];
    const fixture = nativeOptions();
    expect(() => replayRecordedText({ evidence, options: fixture.options })).toThrow('recorded decoder sequence');
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('does not ignore newly added generation options', () => {
    const fixture = nativeOptions();
    fixture.options['top_k'] = 5;
    expect(() => replayRecordedText({ evidence: recording(), options: fixture.options })).toThrow('unrecorded generation options');
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('rechecks source provenance for a mutated later invocation', () => {
    const evidence = recording();
    evidence.modelReplay.sourceInputSha256 = '0'.repeat(64);
    const fixture = nativeOptions();
    expect(() => replayRecordedText({ evidence, options: fixture.options })).toThrow('recorded source digest');
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('does not turn a prefix into an unsupported complete capture', () => {
    const evidence = recording();
    expect(() => parseProviderReplayTextEvidence({ value: {
      ...evidence, scenario: { ...evidence.scenario, boundary: { kind: 'natural-complete', termination: 'eos' } },
    } })).toThrow();
  });

  it('does not infer a native stop cause from a prefix whose length equals the request budget', () => {
    const evidence = recording();
    expect(evidence.modelReplay.generatedTokenIds).toHaveLength(evidence.scenario.lmParameters.maxCompletionTokens);
    expect(() => parseProviderReplayTextEvidence({ value: {
      ...evidence, scenario: { ...evidence.scenario, boundary: { ...evidence.scenario.boundary, stopCause: 'max-new-tokens' } },
    } })).toThrow();
  });

  it('stops token release when the supplied Production criterion interrupts', () => {
    const fixture = nativeOptions();
    fixture.options['stopping_criteria'] = () => [true];
    expect(replayRecordedText({ evidence: recording(), options: fixture.options }))
      .toEqual({ sequenceTokenIds: [10n, 20n, 30n], releasedTokenCount: 1 });
    expect(fixture.put.mock.calls).toEqual([[[[10n, 20n]]], [[[30n]]]]);
    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it('replays an observed ending below the budget without padding tokens or inferring a stop cause', () => {
    const fixture = nativeOptions();
    fixture.options['max_new_tokens'] = 3;
    expect(replayRecordedText({ evidence: endedRecording(), options: fixture.options }))
      .toEqual({ sequenceTokenIds: [10n, 20n, 30n, 40n], releasedTokenCount: 2 });
    expect(fixture.put.mock.calls).toEqual([[[[10n, 20n]]], [[[30n]]], [[[40n]]]]);
    expect(fixture.end).toHaveBeenCalledOnce();
  });

  it('rejects an ending whose recorded last token is not the actual sequence ending', () => {
    const evidence = endedRecording();
    if (evidence.scenario.boundary.kind !== 'recorded-ending') throw new Error('Expected ending fixture');
    evidence.scenario.boundary.lastTokenId = 41;
    const fixture = nativeOptions();
    fixture.options['max_new_tokens'] = 3;
    expect(() => replayRecordedText({ evidence, options: fixture.options })).toThrow('recorded last token');
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('rejects an ending labeled below budget when its count actually reaches that budget', () => {
    const evidence = endedRecording();
    evidence.scenario.lmParameters.maxCompletionTokens = 2;
    evidence.inputContract.effectiveGenerationConfig.maxNewTokens = 2;
    expect(() => parseProviderReplayTextEvidence({ value: evidence })).toThrow('ending must precede request budget');
  });

  it('does not relabel the shorter recorded output as a budget-length prefix', () => {
    const evidence = endedRecording();
    evidence.expectedProviderSemantic.captureScope = 'prefix';
    expect(() => parseProviderReplayTextEvidence({ value: evidence })).toThrow('recorded ending scope');
  });
});
