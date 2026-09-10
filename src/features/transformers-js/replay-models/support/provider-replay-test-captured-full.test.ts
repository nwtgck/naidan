// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { providerReplayCatalog } from '@/features/transformers-js/replay-models/huggingfacetb--smollm2-135m-instruct/provider-evidence-catalog';
import { assembleProviderSequenceEvidence } from './provider-replay-evidence';
const source = assembleProviderSequenceEvidence({ catalog: providerReplayCatalog });
import { parseCapturedFullReplay, replayCapturedFullInvocation, verifyCapturedFullReplay, verifyCapturedGapInputs, verifyCapturedProviderPrefix, TEST_ONLY, type ReviewedProviderReplayContract } from './provider-replay-test-captured-full';
import type { ProductionProviderTraceEvent } from '@/features/transformers-js/model-support-investigation/logic/production-provider-trace';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from './provider-replay-test-runtime';

describe('reviewed public contracts remain separate from immutable capture', () => {
  const evidence = parseCapturedFullReplay({ value: source });
  const correction = { scenario: 'first-turn' as const, reason: 'Independently reviewed public delivery contract', expectedEvents: [{ kind: 'assistant-start' }] };
  const invalidated = { callOrdinal: 1, scenario: 'first-turn' as const, reason: 'Changed current input has no applicable recorded output', requestInput: {}, expectedEventsBeforeGap: [], verifyInput: vi.fn() };
  it('detaches explicit corrected events without modifying the captured source', () => {
    const before = structuredClone(evidence);
    const expectedEvents = [{ kind: 'assistant-start' }];
    const result = TEST_ONLY.validateReviewedProviderContract({ evidence, originalGaps: [], reviewedPublicContract: {
      correctedEvents: [{ ...correction, expectedEvents }], invalidatedOutputs: [],
    } });
    expectedEvents.push({ kind: 'mutation' });
    expect(result.correctedEvents.get('first-turn')).toEqual([{ kind: 'assistant-start' }]);
    expect(result.gaps).toEqual([]);
    expect(evidence).toEqual(before);
  });
  it.each([
    { name: 'unknown request', contract: { correctedEvents: [{ ...correction, scenario: 'unknown' as never }], invalidatedOutputs: [] }, error: 'one recorded request' },
    { name: 'duplicate correction', contract: { correctedEvents: [correction, correction], invalidatedOutputs: [] }, error: 'Duplicate' },
    { name: 'missing correction rationale', contract: { correctedEvents: [{ ...correction, reason: ' ' }], invalidatedOutputs: [] }, error: 'reason' },
    { name: 'gap-owned correction', contract: { correctedEvents: [correction], invalidatedOutputs: [invalidated] }, error: 'gap-owned' },
    { name: 'duplicate invalidation', contract: { correctedEvents: [], invalidatedOutputs: [invalidated, invalidated] }, error: 'Duplicate' },
    { name: 'unknown native output', contract: { correctedEvents: [], invalidatedOutputs: [{ ...invalidated, callOrdinal: 100 }] }, error: 'originally replayable' },
    { name: 'native output owned by another request', contract: { correctedEvents: [], invalidatedOutputs: [{ ...invalidated, scenario: 'system-user' as const }] }, error: 'originally replayable' },
    { name: 'missing invalidation rationale', contract: { correctedEvents: [], invalidatedOutputs: [{ ...invalidated, reason: '' }] }, error: 'reason' },
  ] satisfies Array<{ name: string; contract: ReviewedProviderReplayContract; error: string }>)('rejects $name', ({ contract, error }) => {
    expect(() => TEST_ONLY.validateReviewedProviderContract({ evidence, originalGaps: [], reviewedPublicContract: contract })).toThrow(error);
  });
  it('distinguishes a newly inapplicable captured output from an originally missing output', () => {
    const contract = { correctedEvents: [], invalidatedOutputs: [invalidated] };
    const result = TEST_ONLY.validateReviewedProviderContract({ evidence, originalGaps: [], reviewedPublicContract: contract });
    expect(result.gaps).toEqual([invalidated]);
    expect(evidence.unavailableRecordedCalls).toBeUndefined();
    expect(() => TEST_ONLY.validateReviewedProviderContract({ evidence: { ...evidence, unavailableRecordedCalls: [1] }, originalGaps: [], reviewedPublicContract: contract })).toThrow('originally replayable');
  });
  it('rejects unchanged public input as a waiver for still-applicable recorded output', () => {
    const original = evidence.requests.find(request => request.scenario === 'first-turn')!;
    expect(() => TEST_ONLY.validateReviewedProviderContract({ evidence, originalGaps: [], reviewedPublicContract: {
      correctedEvents: [], invalidatedOutputs: [{ ...invalidated, requestInput: structuredClone(original.input) }],
    } })).toThrow('changed public input');
  });
});

describe('captured Full native inference gate', () => {
  it('rejects missing captured image input or settings even after direct input verification', () => {
    const bytes = new Uint8Array(Float32Array.of(0.25).buffer);
    const inputs = [{ name: 'pixel_values', value: { kind: 'tensor' as const, dtype: 'float32' as const, dims: [1], byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }];
    const originalSettings = parseCapturedFullReplay({ value: source }).invocations[0]!.settings;
    const settings = { ...originalSettings, kwargs: { ...originalSettings.kwargs, keys: { ...originalSettings.kwargs.keys, values: ['pixel_values'], totalCount: 1 } } };
    const expected = { preInputs: inputs, inputs, settings };
    const identity = { runId: 'gap-capture-control', requestId: 'image', workerEpoch: 1, generationCallId: 1, nativeInvocationOrdinal: 1 };
    const values = [{ name: 'pixel_values', snapshot: { status: 'captured' as const, dtype: 'float32' as const, dims: [1], byteLength: bytes.length, bytes } }];
    const events: Parameters<typeof verifyCapturedGapInputs>[0]['events'] = [
      { kind: 'inputs', identity, phase: 'pre-budget', values },
      { kind: 'settings', identity, value: settings },
      { kind: 'inputs', identity, phase: 'native-kwargs', values },
    ];
    verifyCapturedGapInputs({ events, expected });
    for (let dropped = 0; dropped < events.length; dropped++) {
      expect(() => verifyCapturedGapInputs({ events: events.filter((_event, index) => index !== dropped), expected }), `missing captured event ${dropped}`).toThrow();
    }
    for (const phase of ['pre-budget', 'native-kwargs'] as const) {
      expect(() => verifyCapturedGapInputs({ events: events.map(event => event.kind === 'inputs' && event.phase === phase ? { ...event, values: [] } : event), expected }), `missing captured ${phase} pixels`).toThrow();
    }
  });
  it('rejects dropped first-stage chunks or assistant starts even when tool callbacks survive', () => {
    const prefix: ProductionProviderTraceEvent[] = [
      { sequence: 0, phase: 'before-settlement', kind: 'assistant-start' },
      { sequence: 1, phase: 'before-settlement', kind: 'chunk', chunk: 'Thinking before the tool.' },
      { sequence: 2, phase: 'before-settlement', kind: 'tool-call', toolCallId: 'native-id', toolName: 'lookup_weather', modelVisibleArguments: '{"city":"Tokyo"}' },
      { sequence: 3, phase: 'before-settlement', kind: 'tool-success', toolCallId: 'native-id', content: '{"temperatureC":20,"condition":"clear"}' },
      { sequence: 4, phase: 'before-settlement', kind: 'assistant-start' },
    ];
    const expected = prefix.map(event => 'toolCallId' in event ? { ...event, toolCallId: 'tool-1' } : event);
    verifyCapturedProviderPrefix({ events: prefix, expected });
    for (const dropped of [0, 1, 4]) {
      const mutated = prefix.filter((_event, index) => index !== dropped).map((event, sequence) => ({ ...event, sequence }));
      expect(mutated.filter(event => event.kind.startsWith('tool-'))).toHaveLength(2);
      expect(() => verifyCapturedProviderPrefix({ events: mutated, expected }), `dropped prefix event ${dropped}`).toThrow('all callbacks before evidence gap');
    }
    const imageStart: ProductionProviderTraceEvent[] = [{ sequence: 0, phase: 'before-settlement', kind: 'assistant-start' }];
    expect(() => verifyCapturedProviderPrefix({ events: [], expected: imageStart })).toThrow('all callbacks before evidence gap');
  });
  it('rejects a missing metadata row before starting the native runtime', async () => {
    await expect(verifyCapturedFullReplay({ reviewedPublicContract: undefined, evidence: { ...source, metadata: source.metadata.slice(1) },
      artifactPaths: ['onnx/model_q4f16.onnx'], imagePlatform: undefined, unavailableOutputs: [], completeResult: undefined, expectedLoadReceipt: undefined,
    })).rejects.toThrow('complete source metadata path set');
  });
  it('rejects removed local metadata independently of the bounded seed projection', () => {
    expect(source.localMetadataPaths).toContain('generation_config.json');
    expect(() => parseCapturedFullReplay({ value: { ...source, localMetadataPaths: source.localMetadataPaths.filter(path => path !== 'generation_config.json') } })).toThrow('observed local metadata inventory');
  });
  it('refuses changed native tensor, settings and controls before releasing any recorded stream', async () => {
    const evidence = parseCapturedFullReplay({ value: source });
    const invocation = evidence.invocations[0]!;
    const parameters = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
    let verified = 0;
    const harness = await createProviderReplayTestRuntime({
      modelId: evidence.modelId, expectedRevision: evidence.metadataRevision, cacheRevision: evidence.metadataRevision, metadataCache: "all-fixture",
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: Uint8Array.of(1) }], imagePlatform: undefined,
      generate: async ({ options, runtime, model }) => {
        if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor) || !options.streamer) throw new Error('Missing actual native controls');
        const put = vi.spyOn(options.streamer, 'put');
        const end = vi.spyOn(options.streamer, 'end');
        expect(() => replayCapturedFullInvocation({
          invocation: { ...invocation, inputs: invocation.inputs.filter(input => input.name !== 'attention_mask') },
          options, runtime, modelConfig: model.config, parameters,
        }), 'missing input evidence must not release output').toThrow();
        expect(put).not.toHaveBeenCalled();
        expect(end).not.toHaveBeenCalled();
        const malformed = [
          { name: 'duplicate input', value: { ...invocation, inputs: [...invocation.inputs, invocation.inputs[0]!] } },
          { name: 'pre-budget digest', value: { ...invocation, preInputs: [] } },
          { name: 'sequence digest', value: { ...invocation, sequence: { ...invocation.sequence, sha256: '0'.repeat(64) } } },
          { name: 'stream group order', value: { ...invocation, stream: [invocation.stream[1]!, invocation.stream[0]!, ...invocation.stream.slice(2)] } },
          { name: 'after-end stream', value: { ...invocation, stream: [...invocation.stream, invocation.stream[1]!] } },
          { name: 'recorded requested budget', value: { ...invocation, settings: { ...invocation.settings, requested: { ...invocation.settings.requested, maxCompletionTokens: { status: 'value' as const, value: 1 } } } } },
          { name: 'recorded context', value: { ...invocation, settings: { ...invocation.settings, budget: { ...invocation.settings.budget, contextLimit: 8193 } } } },
          { name: 'later scenario input', value: evidence.invocations[12]! },
        ];
        for (const mutation of malformed) {
          expect(() => replayCapturedFullInvocation({ invocation: mutation.value, options, runtime, modelConfig: model.config, parameters }), mutation.name).toThrow();
          expect(put, mutation.name).not.toHaveBeenCalled();
          expect(end, mutation.name).not.toHaveBeenCalled();
        }
        expect(() => parseCapturedFullReplay({ value: { ...evidence, invocations: [evidence.invocations[1], invocation, ...evidence.invocations.slice(2)] } })).toThrow('recorded invocation order');
        expect(() => parseCapturedFullReplay({ value: { ...evidence, invocations: [...evidence.invocations, invocation] } })).toThrow('recorded invocation order');
        const wrongIds = BigInt64Array.from(options.input_ids.data, BigInt); wrongIds[0] = 999n;
        const wrongMask = BigInt64Array.from(options.attention_mask.data, BigInt); wrongMask[0] = 0n;
        type Options = Parameters<ProviderReplayGenerate>[0]['options'];
        const mutations: Array<{ name: string; value: Options }> = [
          { name: 'input token', value: { ...options, input_ids: new runtime.Tensor('int64', wrongIds, options.input_ids.dims) } },
          { name: 'attention', value: { ...options, attention_mask: new runtime.Tensor('int64', wrongMask, options.attention_mask.dims) } },
          { name: 'dimensions', value: { ...options, input_ids: new runtime.Tensor('int64', options.input_ids.data, [options.input_ids.data.length, 1]) } },
          { name: 'dtype', value: { ...options, input_ids: new runtime.Tensor('float32', Float32Array.from(options.input_ids.data, Number), options.input_ids.dims) } },
          { name: 'budget', value: { ...options, max_new_tokens: 15 } },
          { name: 'temperature', value: { ...options, temperature: 0.5 } },
          { name: 'top p', value: { ...options, top_p: 0.5 } },
          { name: 'sampling', value: { ...options, do_sample: true } },
          { name: 'return shape', value: { ...options, return_dict_in_generate: false } },
          { name: 'extra key', value: { ...options, unsupported_replay_option: 1 } },
          { name: 'KV', value: { ...options, past_key_values: new runtime.DynamicCache({ unrelated: options.input_ids }) } },
          { name: 'streamer', value: { ...options, streamer: undefined } },
          { name: 'stopping control', value: { ...options, stopping_criteria: undefined } },
        ];
        for (const mutation of mutations) {
          expect(() => replayCapturedFullInvocation({ invocation, options: mutation.value, runtime, modelConfig: model.config, parameters }), mutation.name).toThrow();
          expect(put, mutation.name).not.toHaveBeenCalled();
          expect(end, mutation.name).not.toHaveBeenCalled();
          verified++;
        }
        return replayCapturedFullInvocation({ invocation, options, runtime, modelConfig: model.config, parameters });
      },
    });
    try {
      const chunks: string[] = [];
      await harness.provider.chat({ model: evidence.modelId, messages: [{ role: 'user', content: 'Template probe user message.' }], tools: [],
        parameters,
        onChunk: ({ chunk }) => chunks.push(chunk),
      });
      expect(verified).toBe(13);
      expect(chunks.length).toBeGreaterThan(0);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});
