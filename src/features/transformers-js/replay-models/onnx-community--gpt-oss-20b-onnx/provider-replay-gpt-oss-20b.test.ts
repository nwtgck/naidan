// @vitest-environment node
import { providerReplayCatalog } from './provider-evidence-catalog';
import { captureProviderChat, type ProviderChatCapture } from '@/features/transformers-js/replay-models/support/capture-provider-chat';
import { assembleProviderSequenceEvidence, type ProviderReplayCatalog } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';
import { createProviderRequestReplay, createProviderRequestReplayWithOwnedCacheControl, type ProviderRequestNativeController } from '@/features/transformers-js/replay-models/support/provider-replay-request';
import { parseCapturedFullReplay, replayCapturedFullInvocation, replayCapturedFullInvocationWithOwnedCache, verifyCapturedFullReplay, type OwnedReplayCacheControl } from '@/features/transformers-js/replay-models/support/provider-replay-test-captured-full';
import ownedMinimal from './provider-natural-tool-minimal-owned-cache.evidence.json';
import ownedRepresentative from './provider-natural-tool-representative-owned-cache.evidence.json';
import independentToolHistory from './provider-structured-tool-history-independent.evidence.json';
import ownedProvenance from './provider-owned-tools-provenance.evidence.json';
import ownedSequence from './provider-owned-tools-sequence.evidence.json';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';
import evidenceJson from './provider-prefix-output.evidence.json';
import inputJson from './provider-template-inputs.evidence.json';
import toolInputJson from './provider-template-tool-inputs.evidence.json';
import { parseProviderReplayTextEvidence, replayRecordedText } from '@/features/transformers-js/replay-models/support/provider-replay-test-causal-gate';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';

// New complete requests retain their own source pins. Historical suffix-only
// outputs and their rejection tests remain in the original catalog unchanged.
const ownedToolCatalog = {
  context: providerReplayCatalog.context, provenance: ownedProvenance, sequence: ownedSequence,
  cases: { 'natural-tool-minimal': ownedMinimal, 'natural-tool-representative': ownedRepresentative, 'structured-tool-history': independentToolHistory },
} satisfies ProviderReplayCatalog;
const ownedToolArtifacts = ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data',
  'onnx/model_q4f16.onnx_data_1', 'onnx/model_q4f16.onnx_data_2', 'onnx/model_q4f16.onnx_data_3',
  'onnx/model_q4f16.onnx_data_4', 'onnx/model_q4f16.onnx_data_5', 'onnx/model_q4f16.onnx_data_6'];

function createOwnedToolControl({ mutations, boundaries }: {
  mutations: 'verify' | 'none'; boundaries: string[];
}): ProviderRequestNativeController {
  const controls = new Map<string, OwnedReplayCacheControl>();
  return {
    cacheForInvocation({ caseId, localOrdinal, call }) {
      boundaries.push(`${caseId}/${localOrdinal}`);
      if (localOrdinal === 1) {
        expect(call.options.past_key_values, `${caseId}/fresh public request`).toBeNull();
        if (caseId === 'structured-tool-history') {
          const previous = controls.get('natural-tool-representative');
          if (previous === undefined) throw new Error('Independent tool history requires the preceding completed tool request');
          expect(call.options.past_key_values).not.toBe(previous.pastKeyValues);
          expect(call.invocation.settings.budget.pastTokenCount).toBe(0);
        }
        return undefined;
      }
      expect(localOrdinal).toBe(2);
      const control = controls.get(caseId);
      if (control === undefined) throw new Error('Missing this request\'s actual preceding native result');
      expect(call.options.past_key_values).toBe(control.pastKeyValues);
      if (mutations === 'verify') {
        if (!call.options.streamer) throw new Error('Missing actual native streamer');
        const put = vi.spyOn(call.options.streamer, 'put');
        const end = vi.spyOn(call.options.streamer, 'end');
        try {
          const verifyRejection = ({ value, reason }: { value: OwnedReplayCacheControl; reason: string }) => {
            expect(() => replayCapturedFullInvocationWithOwnedCache({ ...call, cacheControl: value })).toThrow(reason);
            expect(put, reason).not.toHaveBeenCalled(); expect(end, reason).not.toHaveBeenCalled();
          };
          verifyRejection({ value: { ...control, pastKeyValues: new call.runtime.DynamicCache() }, reason: 'owned cache identity' });
          const previous = BigInt64Array.from(control.previousSequence.data, BigInt); previous[0] = 999n;
          verifyRejection({ value: { ...control, previousSequence: new call.runtime.Tensor('int64', previous, control.previousSequence.dims) }, reason: 'previous returned sequence prefix' });
          const length = control.pastKeyValues.get_seq_length();
          vi.mocked(control.pastKeyValues.get_seq_length).mockReturnValue(length + 1);
          try {
            verifyRejection({ value: control, reason: 'owned cache length' });
          } finally {
            vi.mocked(control.pastKeyValues.get_seq_length).mockReturnValue(length);
          }
          const budget = call.invocation.settings.budget;
          expect(() => replayCapturedFullInvocationWithOwnedCache({ ...call, cacheControl: control,
            invocation: { ...call.invocation, settings: { ...call.invocation.settings, budget: { ...budget, usedContextTokenCount: budget.promptTokenCount + length } } },
          })).toThrow('independent budget');
          expect(() => replayCapturedFullInvocation(call)).toThrow('past-token-count');
          expect(put).not.toHaveBeenCalled(); expect(end).not.toHaveBeenCalled();
          boundaries.push(`${caseId}/rejected-identity-length-prefix-double-count`);
        } finally {
          put.mockRestore(); end.mockRestore();
        }
      }
      return control;
    },
    completeResult({ caseId, localOrdinal, result, runtime }) {
      if (localOrdinal !== 1 || caseId === 'structured-tool-history') return result;
      expect(['natural-tool-minimal', 'natural-tool-representative']).toContain(caseId);
      // Source-derived synthetic KV only: the real returned Tensor supplies
      // the prefix, and this native cache object supplies identity and length.
      // No captured GPU KV bytes or GPU cache computation are being replayed.
      const cache = new runtime.DynamicCache();
      vi.spyOn(cache, 'get_seq_length').mockReturnValue(result.sequences.dims[1]! - 1);
      controls.set(caseId, { previousSequence: result.sequences, pastKeyValues: cache });
      return { ...result, past_key_values: cache };
    },
  };
}

const evidence = parseProviderReplayTextEvidence({ value: evidenceJson });
const inputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('9f571fe9df62978ab255cb7d50a2ea9ca1a2214058318a92ba1c267b321b95b4'),
  modelId: z.literal('onnx-community/gpt-oss-20b-ONNX'),
  revision: z.literal('6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7'),
  selectedTemplateSha256: z.literal('f8d9255777615591a7cc1a7c932f5a69e181128902295e1b81221d20d983cac7'),
  templateClockDate: z.literal('2026-09-05'),
  cases: z.array(z.object({
    caseId: z.enum(['user-generation', 'system-user-generation', 'multi-turn-generation']),
    messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()),
    addGenerationPrompt: z.literal(true), renderedText: z.string(),
    inputTokenIds: z.array(z.number().int().nonnegative()).min(1),
  }).strict()).length(3),
}).strict().parse(inputJson);

const toolUserSchema = z.object({ role: z.literal('user'), content: z.string() }).strict();
const toolAssistantSchema = z.object({
  role: z.literal('assistant'), content: z.literal(''),
  tool_calls: z.tuple([z.object({
    id: z.literal('call_template_probe_1'), type: z.literal('function'),
    function: z.object({ name: z.literal('lookup_weather'), arguments: z.literal('{"city":"Tokyo"}') }).strict(),
  }).strict()]),
}).strict();
const toolResultSchema = z.object({
  role: z.literal('tool'), tool_call_id: z.literal('call_template_probe_1'), content: z.string(),
}).strict();
const toolCaseSchema = z.object({
  tools: z.tuple([z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.literal('lookup_weather'), description: z.literal('Return deterministic weather fixture data.'),
      parameters: z.object({
        type: z.literal('object'), properties: z.object({ city: z.object({ type: z.literal('string') }).strict() }).strict(),
        required: z.tuple([z.literal('city')]),
      }).strict(),
    }).strict(),
  }).strict()]),
  addGenerationPrompt: z.literal(true), renderedText: z.string(),
  inputTokenIds: z.array(z.number().int().nonnegative().safe()).min(1),
}).strict();
const toolInputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('9f571fe9df62978ab255cb7d50a2ea9ca1a2214058318a92ba1c267b321b95b4'),
  modelId: z.literal('onnx-community/gpt-oss-20b-ONNX'),
  revision: z.literal('6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7'),
  selectedTemplateSha256: z.literal('f8d9255777615591a7cc1a7c932f5a69e181128902295e1b81221d20d983cac7'),
  templateClockDate: z.literal('2026-09-05'),
  cases: z.tuple([
    toolCaseSchema.extend({ caseId: z.literal('tools-generation'), messages: z.tuple([toolUserSchema]) }),
    toolCaseSchema.extend({ caseId: z.literal('tool-result-continuation'), messages: z.tuple([toolUserSchema, toolAssistantSchema, toolResultSchema]) }),
  ]),
}).strict().parse(toolInputJson);

beforeEach(() => {
  // The captured template includes 2026-09-05. Freeze only Date, not RPC or
  // timers. Exact token equality below verifies an equivalent template clock;
  // this is not a claim that the capture recorded its original timezone.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

async function createGptOssReplay() {
  expect(evidence.identity).toEqual({
    modelId: 'hf.co/onnx-community/gpt-oss-20b-ONNX',
    resolvedRevision: '6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7',
    investigationRunId: 'fcc765db-1f6f-4be5-b25d-cecb650bdebe',
    transformersJsVersion: '4.2.0',
  });
  let releasedTokenCount = 0;
  const harness = await createProviderReplayTestRuntime({
    imagePlatform: undefined,
    modelId: 'onnx-community/gpt-oss-20b-ONNX',
    expectedRevision: evidence.identity.resolvedRevision,
    cacheRevision: evidence.identity.resolvedRevision,
    metadataCache: "all-fixture",
    // Model-specific repository paths, with tiny native-inference substitutes.
    // Real tokenizer/config, cache selection and all Worker loading remain active.
    artifacts: [
      'onnx/model_q4f16.onnx',
      'onnx/model_q4f16.onnx_data',
      'onnx/model_q4f16.onnx_data_1',
      'onnx/model_q4f16.onnx_data_2',
      'onnx/model_q4f16.onnx_data_3',
      'onnx/model_q4f16.onnx_data_4',
      'onnx/model_q4f16.onnx_data_5',
      'onnx/model_q4f16.onnx_data_6',
    ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: 'onnx-community/gpt-oss-20b-ONNX', revision: evidence.identity.resolvedRevision, path }) })),
    generate: async ({ options, tokenizer, runtime }) => {
      expect(tokenizer.decode(evidence.modelReplay.generatedTokenIds, { skip_special_tokens: false }))
        .toBe(evidence.modelReplay.generatedText);
      const replay = replayRecordedText({ evidence, options });
      releasedTokenCount += replay.releasedTokenCount;
      return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
    },
  });
  return { harness, releasedTokenCount: () => releasedTokenCount };
}

describe('GPT-OSS 20B Provider / basic', () => {
  it("user-generation preserves the exact captured native input through Provider.chat", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases.find((item): boolean => item.caseId === "user-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'GPT-OSS actual input verified; generation not replayed';
    const nativeInputs: Array<{
      templateSha256: string; rendered: unknown;
      input: { type: string; location: string; dims: number[]; data: number[] } | undefined;
      mask: { data: unknown } | undefined;
      past: unknown;
    }> = [];
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId,
      expectedRevision: inputEvidence.revision,
      cacheRevision: inputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      artifacts: [
        'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data',
        'onnx/model_q4f16.onnx_data_1', 'onnx/model_q4f16.onnx_data_2',
        'onnx/model_q4f16.onnx_data_3', 'onnx/model_q4f16.onnx_data_4',
        'onnx/model_q4f16.onnx_data_5', 'onnx/model_q4f16.onnx_data_6',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async ({ options, tokenizer, runtime }) => {
        nativeInputs.push({
          templateSha256: createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'), rendered: tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: true }),
          input: options.input_ids instanceof runtime.Tensor ? { type: options.input_ids.type, location: options.input_ids.location, dims: [...options.input_ids.dims], data: Array.from(options.input_ids.data, Number) } : undefined,
          mask: options.attention_mask instanceof runtime.Tensor ? { data: structuredClone(options.attention_mask.data) } : undefined,
          past: options.past_key_values,
        });
        // The assistant history is a captured synthetic template probe, not
        // a claim that a prior Provider turn or native reasoning completed.
        throw new Error(boundary);
      },
    });
    try {
      const capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [{ role: "user", content: "Template probe user message." }],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 1,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await expect(capture.completion).rejects.toThrow(boundary);
      const { chunks } = capture.snapshot();
      expect(nativeInputs).toHaveLength(1);
      const observedInput = nativeInputs[0]!;
      expect(observedInput.templateSha256).toBe(inputEvidence.selectedTemplateSha256);
      expect(observedInput.rendered).toBe(scenario.renderedText);
      expect(observedInput.input?.type).toBe('int64');
      expect(observedInput.input?.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(observedInput.input?.data).toEqual(scenario.inputTokenIds);
      expect(observedInput.mask?.data).toEqual(new BigInt64Array(scenario.inputTokenIds.length).fill(1n));
      expect(observedInput.past).toBeNull();
      expect(chunks).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it("system-user-generation preserves the exact captured native input through Provider.chat", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases.find((item): boolean => item.caseId === "system-user-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'GPT-OSS actual input verified; generation not replayed';
    const nativeInputs: Array<{
      templateSha256: string; rendered: unknown;
      input: { type: string; location: string; dims: number[]; data: number[] } | undefined;
      mask: { data: unknown } | undefined;
      past: unknown;
    }> = [];
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId,
      expectedRevision: inputEvidence.revision,
      cacheRevision: inputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      artifacts: [
        'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data',
        'onnx/model_q4f16.onnx_data_1', 'onnx/model_q4f16.onnx_data_2',
        'onnx/model_q4f16.onnx_data_3', 'onnx/model_q4f16.onnx_data_4',
        'onnx/model_q4f16.onnx_data_5', 'onnx/model_q4f16.onnx_data_6',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async ({ options, tokenizer, runtime }) => {
        nativeInputs.push({
          templateSha256: createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'), rendered: tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: true }),
          input: options.input_ids instanceof runtime.Tensor ? { type: options.input_ids.type, location: options.input_ids.location, dims: [...options.input_ids.dims], data: Array.from(options.input_ids.data, Number) } : undefined,
          mask: options.attention_mask instanceof runtime.Tensor ? { data: structuredClone(options.attention_mask.data) } : undefined,
          past: options.past_key_values,
        });
        // The assistant history is a captured synthetic template probe, not
        // a claim that a prior Provider turn or native reasoning completed.
        throw new Error(boundary);
      },
    });
    try {
      const capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [{ role: "system", content: "Template probe system instruction." }, { role: "user", content: "Template probe user message." }],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 1,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await expect(capture.completion).rejects.toThrow(boundary);
      const { chunks } = capture.snapshot();
      expect(nativeInputs).toHaveLength(1);
      const observedInput = nativeInputs[0]!;
      expect(observedInput.templateSha256).toBe(inputEvidence.selectedTemplateSha256);
      expect(observedInput.rendered).toBe(scenario.renderedText);
      expect(observedInput.input?.type).toBe('int64');
      expect(observedInput.input?.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(observedInput.input?.data).toEqual(scenario.inputTokenIds);
      expect(observedInput.mask?.data).toEqual(new BigInt64Array(scenario.inputTokenIds.length).fill(1n));
      expect(observedInput.past).toBeNull();
      expect(chunks).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it("multi-turn-generation preserves the exact captured native input through Provider.chat", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases.find((item): boolean => item.caseId === "multi-turn-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'GPT-OSS actual input verified; generation not replayed';
    const nativeInputs: Array<{
      templateSha256: string; rendered: unknown;
      input: { type: string; location: string; dims: number[]; data: number[] } | undefined;
      mask: { data: unknown } | undefined;
      past: unknown;
    }> = [];
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId,
      expectedRevision: inputEvidence.revision,
      cacheRevision: inputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      artifacts: [
        'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data',
        'onnx/model_q4f16.onnx_data_1', 'onnx/model_q4f16.onnx_data_2',
        'onnx/model_q4f16.onnx_data_3', 'onnx/model_q4f16.onnx_data_4',
        'onnx/model_q4f16.onnx_data_5', 'onnx/model_q4f16.onnx_data_6',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async ({ options, tokenizer, runtime }) => {
        nativeInputs.push({
          templateSha256: createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'), rendered: tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: true }),
          input: options.input_ids instanceof runtime.Tensor ? { type: options.input_ids.type, location: options.input_ids.location, dims: [...options.input_ids.dims], data: Array.from(options.input_ids.data, Number) } : undefined,
          mask: options.attention_mask instanceof runtime.Tensor ? { data: structuredClone(options.attention_mask.data) } : undefined,
          past: options.past_key_values,
        });
        // The assistant history is a captured synthetic template probe, not
        // a claim that a prior Provider turn or native reasoning completed.
        throw new Error(boundary);
      },
    });
    try {
      const capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [{ role: "user", content: "Template probe first user message." }, { role: "assistant", content: "Template probe assistant response." }, { role: "user", content: "Template probe second user message." }],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 1,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await expect(capture.completion).rejects.toThrow(boundary);
      const { chunks } = capture.snapshot();
      expect(nativeInputs).toHaveLength(1);
      const observedInput = nativeInputs[0]!;
      expect(observedInput.templateSha256).toBe(inputEvidence.selectedTemplateSha256);
      expect(observedInput.rendered).toBe(scenario.renderedText);
      expect(observedInput.input?.type).toBe('int64');
      expect(observedInput.input?.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(observedInput.input?.data).toEqual(scenario.inputTokenIds);
      expect(observedInput.mask?.data).toEqual(new BigInt64Array(scenario.inputTokenIds.length).fill(1n));
      expect(observedInput.past).toBeNull();
      expect(chunks).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('refuses the recorded answer when the public caller changes the input', async () => {
    const captures: ProviderChatCapture[] = [];
    const replay = await createGptOssReplay();
    try {
      const capture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: "hf.co/onnx-community/gpt-oss-20b-ONNX",
          messages: [{ role: 'user', content: 'Different synthetic replay input.' }],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 16,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await expect(capture.completion).rejects.toThrow('Replay causal mismatch: actual source input');
      const { chunks } = capture.snapshot();
      expect(replay.releasedTokenCount()).toBe(0);
      expect(chunks).toEqual([]);
      expect(replay.harness.observations.inferenceCalls).toHaveLength(1);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      await replay.harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('basic: delivers the recorded first-turn callbacks before settlement', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
      temperature: 0,
      topP: 1,
      maxCompletionTokens: 16,
      presencePenalty: undefined,
      frequencyPenalty: undefined,
      stop: undefined,
      reasoning: {
        effort: undefined,
      },
    };
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ['first-turn'],
      artifactPaths: ownedToolArtifacts,
      imagePlatform: undefined
    });
    let capture: ProviderChatCapture | undefined;
    try {
      replay.beginNativeRequest({ caseId: 'first-turn', parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: 'onnx-community/gpt-oss-20b-ONNX',
          messages: [{ role: 'user', content: 'Template probe user message.' }],
          parameters,
          tools: [],
          signal: new AbortController().signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses).toHaveLength(1);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(['assistant-start', 'settled']);
      expect(observed.chunks.join('')).toBe('<think>The user says "Template probe user message." This seems like a');
      expect(observed.preStartChunks).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(capture?.snapshot().lateEvents).toEqual([]);
    expect(capture?.snapshot().toolCalls).toEqual([]);
    expect(capture?.snapshot().toolResults).toEqual([]);
    expect(capture?.snapshot().toolEvents).toEqual([]);
  }, 30_000);
});

describe('GPT-OSS 20B Provider / system', () => {
  it('system: preserves instructions and delivers the recorded callbacks', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["system-user"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
    try {
      // system-user: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 1,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "system-user", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "system", content: "Template probe system instruction." }, { role: "user", content: "Template probe user message." }],
            parameters,
            tools: [],
            signal,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(responses.map(chunks => chunks.join(''))).toEqual([""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
});

describe('GPT-OSS 20B Provider / history', () => {
  it('renders recorded assistant history with absent tool_calls but rejects the own undefined property added by the adapter', async () => {
    const scenario = inputEvidence.cases.find(candidate => candidate.caseId === 'multi-turn-generation');
    if (!scenario) throw new Error('Missing captured GPT-OSS history input');
    const replay = await createGptOssReplay();
    try {
      await replay.harness.service.loadDownloadedModel({ modelId: inputEvidence.modelId });
      const tokenizer = await replay.harness.runtime.AutoTokenizer.from_pretrained(inputEvidence.modelId, {
        revision: inputEvidence.revision, local_files_only: true,
      });
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'))
        .toBe(inputEvidence.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: true }))
        .toBe(scenario.renderedText);
      const cleanInput = tokenizer.apply_chat_template(scenario.messages, { add_generation_prompt: true, return_dict: true });
      expect(cleanInput.input_ids).toBeInstanceOf(replay.harness.runtime.Tensor);
      expect(Array.from(cleanInput.input_ids.data, Number)).toEqual(scenario.inputTokenIds);

      // buildGptOssPromptMessages adds own tool_calls:undefined even when the
      // public message has no tools. The template uses membership, not truthiness:
      // the assistant enters message.tool_calls[0] instead of ordinary history.
      // Keep this isolated comparison alongside the public contract RED below;
      // never remove the real adapter's property in the replay harness.
      const withUndefinedToolCalls = scenario.messages.map(message => ({ ...message, tool_calls: undefined }));
      expect(Object.hasOwn(withUndefinedToolCalls[1]!, 'tool_calls')).toBe(true);
      expect(() => tokenizer.apply_chat_template(withUndefinedToolCalls, { tokenize: false, add_generation_prompt: true }))
        .toThrow('Cannot access property with non-string: got IntegerValue');
      expect(replay.releasedTokenCount()).toBe(0);
      expect(replay.harness.observations.inferenceCalls).toEqual([]);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
      expect(replay.harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await replay.harness.close();
    }
  }, 30_000);
  it('history: preserves supplied history and delivers the recorded callbacks', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["supplied-history"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
    try {
      // supplied-history: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 1,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "supplied-history", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Template probe first user message." }, { role: "assistant", content: "Template probe assistant response." }, { role: "user", content: "Template probe second user message." }],
            parameters,
            tools: [],
            signal,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(responses.map(chunks => chunks.join(''))).toEqual([""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
});

describe('GPT-OSS 20B Provider / independent', () => {
  it('keeps an independent next input free of prior analysis in the same null-KV loaded runtime', async () => {
    const captures: ProviderChatCapture[] = [];
    const firstInput = inputEvidence.cases.find(item => item.caseId === 'user-generation');
    if (!firstInput) throw new Error('Missing captured GPT-OSS user input');
    expect(firstInput.messages).toEqual([{ role: 'user', content: 'Template probe user message.' }]);
    expect(firstInput.renderedText.split('Template probe user message.')).toHaveLength(2);
    const nextMessages: ChatMessage[] = [{ role: 'user', content: 'A separate synthetic conversation.' }];
    // The fixed captured system/date scaffold is preserved; only this one user
    // literal changes. This is an independently specified input, not new output evidence.
    const nextPrompt = firstInput.renderedText.replace('Template probe user message.', 'A separate synthetic conversation.');
    const stop = 'Independent GPT-OSS next input verified; no second output supplied';
    const contexts: Parameters<ProviderReplayGenerate>[0][] = [];
    let firstReleased = 0;
    const nativeInputs: Array<{
      templateSha256: string; rendered: unknown; expectedIds: number[];
      input: { type: string; location: string; dims: number[]; data: number[] } | undefined;
      mask: { type: string; location: string; dims: number[]; data: bigint[] } | undefined;
      past: unknown; maxNewTokens: unknown; temperature: unknown; topP: unknown; doSample: unknown;
    }> = [];
    const invocations: ProviderReplayGenerate[] = [
      async context => {
        contexts.push(context);
        const { options, tokenizer, runtime } = context;
        expect(tokenizer.decode(evidence.modelReplay.generatedTokenIds, { skip_special_tokens: false })).toBe(evidence.modelReplay.generatedText);
        const replay = replayRecordedText({ evidence, options });
        firstReleased = replay.releasedTokenCount;
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
      async context => {
        contexts.push(context);
        const { options, tokenizer, runtime } = context;
        nativeInputs.push({
          templateSha256: createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'), rendered: tokenizer.apply_chat_template(nextMessages, { tokenize: false, add_generation_prompt: true }), expectedIds: tokenizer.encode(nextPrompt, { add_special_tokens: false }),
          input: options.input_ids instanceof runtime.Tensor ? { type: options.input_ids.type, location: options.input_ids.location, dims: [...options.input_ids.dims], data: Array.from(options.input_ids.data, Number) } : undefined,
          mask: options.attention_mask instanceof runtime.Tensor ? { type: options.attention_mask.type, location: options.attention_mask.location, dims: [...options.attention_mask.dims], data: Array.from(options.attention_mask.data, BigInt) } : undefined,
          past: options.past_key_values, maxNewTokens: options.max_new_tokens, temperature: options.temperature, topP: options.top_p, doSample: options.do_sample,
        });
        // No captured answer belongs to this changed input. A null native cache
        // cannot establish that real GPU KV reuse/invalidation works correctly.
        throw new Error(stop);
      },
    ];
    const externalPaths = [
      'model_q4f16.onnx_data', 'model_q4f16.onnx_data_1', 'model_q4f16.onnx_data_2',
      'model_q4f16.onnx_data_3', 'model_q4f16.onnx_data_4', 'model_q4f16.onnx_data_5', 'model_q4f16.onnx_data_6',
    ];
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId,
      expectedRevision: inputEvidence.revision,
      cacheRevision: inputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      artifacts: ['onnx/model_q4f16.onnx', ...externalPaths.map(path => `onnx/${path}`)].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }),
      })),
      generate: async context => {
        const next = invocations.shift();
        if (!next) throw new Error('Unexpected extra inference in independent GPT-OSS input replay');
        return next(context);
      },
    });
    try {
      const firstCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/onnx-community/gpt-oss-20b-ONNX",
          messages: [{ role: "user", content: "Template probe user message." }],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 16,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;

      const ortCountAfterFirst = harness.observations.ortCalls.length;

      const secondCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/onnx-community/gpt-oss-20b-ONNX",
          messages: nextMessages,
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 1,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(secondCapture);
      await expect(secondCapture.completion).rejects.toThrow(stop);

      expect(nativeInputs).toHaveLength(1);
      const observedInput = nativeInputs[0]!;
      expect(observedInput.templateSha256).toBe(inputEvidence.selectedTemplateSha256);
      expect(observedInput.rendered).toBe(nextPrompt);
      expect(observedInput.input?.type).toBe('int64');
      expect(observedInput.input?.location).toBe('cpu');
      expect(observedInput.input?.dims).toEqual([1, observedInput.expectedIds.length]);
      expect(observedInput.input?.data).toEqual(observedInput.expectedIds);
      expect(observedInput.mask?.type).toBe('int64');
      expect(observedInput.mask?.location).toBe('cpu');
      expect(observedInput.mask?.dims).toEqual([1, observedInput.expectedIds.length]);
      expect(observedInput.mask?.data).toEqual(observedInput.expectedIds.map(() => 1n));
      expect(observedInput.past).toBeNull();
      expect(observedInput.maxNewTokens).toBe(1);
      expect(observedInput.temperature).toBe(0);
      expect(observedInput.topP).toBe(1);
      expect(observedInput.doSample).toBe(false);
      expect(firstReleased).toBe(16);
      expect(secondCapture.snapshot().chunks).toEqual([]);
      expect(contexts).toHaveLength(2);
      expect(contexts[1]!.model).toBe(contexts[0]!.model);
      expect(contexts[1]!.tokenizer).toBe(contexts[0]!.tokenizer);
      expect(contexts.map(({ options }) => options.past_key_values)).toEqual([null, null]);
      expect(invocations).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(ortCountAfterFirst).toBe(1);
      expect(harness.observations.ortCalls).toHaveLength(ortCountAfterFirst);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('independent: keeps a new conversation independent after settled requests in the same runtime', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn","continuity","independent-next-input"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
    let firstResponse = '';
    try {
      // first-turn: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 16,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "first-turn", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }],
            parameters,
            tools: [],
            signal,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The user says \"Template probe user message.\" This seems like a"]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
        firstResponse = responses[0]!.join('');
      }
      // continuity: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 16,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "continuity", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }, { role: "assistant", content: firstResponse }, { role: "user", content: "Continue the synthetic conversation with a short response." }],
            parameters,
            tools: [],
            signal,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>We need to respond with a short response. Probably just a short"]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
      }
      // independent-next-input: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 1,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "independent-next-input", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "A separate synthetic capture conversation." }],
            parameters,
            tools: [],
            signal,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(responses.map(chunks => chunks.join(''))).toEqual([""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
      }
      replay.assertComplete({ requests: 3, nativeCalls: 3 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
});

describe('GPT-OSS 20B Provider / reasoning', () => {
  it('delivers the captured analysis prefix as thinking before Provider settlement', async () => {
    const captures: ProviderChatCapture[] = [];
    const replay = await createGptOssReplay();
    try {
      const capture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: "hf.co/onnx-community/gpt-oss-20b-ONNX",
          messages: [{ role: "user", content: "Template probe user message." }],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 16,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: {
              effort: undefined,
            },
          },
        },
      });
      captures.push(capture);
      await capture.completion;
      const { chunks, toolCalls, toolResults, toolEvents, responses } = capture.snapshot();
      const settled = {
        assistantStarts: responses.length,
        text: chunks.join(''),
        toolCalls: [...toolCalls],
        toolEvents: [...toolEvents],
        toolResults: [...toolResults]
      };
      expect(replay.releasedTokenCount()).toBe(16);
      expect(replay.harness.observations.inferenceCalls).toHaveLength(1);
      expect(replay.harness.observations.runtimeAssetFetchCalls).toEqual([replay.harness.observations.expectedRuntimeAssetUrl]);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
      // The ORT boundary is replaced, so independently verify what reached it.
      // Identifiable bodies detect a wrong core/revision or swapped data shard.
      const expectedExternalPaths = [
        'model_q4f16.onnx_data', 'model_q4f16.onnx_data_1', 'model_q4f16.onnx_data_2',
        'model_q4f16.onnx_data_3', 'model_q4f16.onnx_data_4', 'model_q4f16.onnx_data_5', 'model_q4f16.onnx_data_6',
      ];
      expect(replay.harness.observations.ortCalls.map(([core, options]) => inspectSyntheticOrtSession({
        modelId: 'onnx-community/gpt-oss-20b-ONNX', revision: evidence.identity.resolvedRevision,
        repositoryPaths: new Set(['onnx/model_q4f16.onnx', ...expectedExternalPaths.map(path => `onnx/${path}`)]),
        core, options,
      }))).toEqual([{
        modelId: 'onnx-community/gpt-oss-20b-ONNX', revision: evidence.identity.resolvedRevision,
        corePath: 'onnx/model_q4f16.onnx', executionProviders: ['webgpu'],
        externalData: expectedExternalPaths.map(path => ({ path, artifactPath: `onnx/${path}` })),
      }]);
      expect(replay.harness.observations.fs.activity.filter(item => item.operation.startsWith('writer') || item.operation.startsWith('create') || item.operation === 'remove')).toEqual([]);
      // A truncated analysis prefix is not a completed answer. Do not append a
      // fabricated </think> or wait for late callbacks to make this assertion pass.
      expect(settled).toEqual({
        assistantStarts: 1,
        text: '<think>The user says "Template probe user message." This seems like a',
        toolCalls: [], toolEvents: [], toolResults: [],
      });
    } finally {
      await replay.harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('reasoning: preserves the recorded none-effort request and callbacks', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-none"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
    try {
      // reasoning-none: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 1,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: "none",
          },
        };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "reasoning-none", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }],
            parameters,
            tools: [],
            signal,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(responses.map(chunks => chunks.join(''))).toEqual([""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('reasoning: preserves the recorded low-effort request and callbacks', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-low"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
    try {
      // reasoning-low: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 1,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: "low",
          },
        };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "reasoning-low", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }],
            parameters,
            tools: [],
            signal,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(responses.map(chunks => chunks.join(''))).toEqual([""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('reasoning: preserves the recorded medium-effort request and callbacks', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-medium"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
    try {
      // reasoning-medium: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 1,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: "medium",
          },
        };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "reasoning-medium", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }],
            parameters,
            tools: [],
            signal,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(responses.map(chunks => chunks.join(''))).toEqual([""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('reasoning: preserves the recorded high-effort request and callbacks', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-high"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
    try {
      // reasoning-high: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 1,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: "high",
          },
        };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "reasoning-high", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }],
            parameters,
            tools: [],
            signal,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(responses.map(chunks => chunks.join(''))).toEqual([""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
});

describe('GPT-OSS 20B Provider / tools', () => {
  it('tools: executes the recorded minimal Tokyo call once and delivers the owned-cache continuation', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const boundaries: string[] = [];
    const replay = await createProviderRequestReplayWithOwnedCacheControl({
      catalog: ownedToolCatalog,
      caseIds: ['natural-tool-minimal'],
      artifactPaths: ownedToolArtifacts,
      imagePlatform: undefined,
      createNativeController: () => createOwnedToolControl({ mutations: 'none', boundaries }),
    });
    const captures: ProviderChatCapture[] = [];
    const lateExecutions: string[] = [];
    try {
      // natural-tool-minimal: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 128,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        const captureRef: { current: ProviderChatCapture | undefined } = { current: undefined };
        const executions: { args: unknown; signal: AbortSignal | undefined; callbackPrefix: ReturnType<ProviderChatCapture['snapshot']> | undefined }[] = [];
        const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.",
          parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args, signal: receivedSignal }) => {
            const callbackPrefix = captureRef.current?.snapshot();
            executions.push({ args: structuredClone(args), signal: receivedSignal, callbackPrefix });
            if (callbackPrefix?.settlement.status !== 'pending') lateExecutions.push('execute');
            return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
          },
        }];
        replay.beginNativeRequest({ caseId: "natural-tool-minimal", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Use the weather tool for Tokyo." }],
            parameters,
            tools: tools,
            signal,
          },
        });
        captureRef.current = capture;
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        // Record the actual callback prefix at execute; do not wrap tools or infer their position.
        for (const execution of executions) {
          expect(execution.callbackPrefix?.settlement).toEqual({ status: 'pending' });
          expect(execution.callbackPrefix?.events.at(-1)?.kind).toBe('tool-call');
          expect(execution.callbackPrefix?.events).toEqual(observed.events.slice(0, execution.callbackPrefix?.events.length));
        }
        const detailedEvents = observed.events.flatMap((event, index) => [
          ...executions.filter(execution => execution.callbackPrefix?.events.length === index).map(() => ['execute']),
          event.kind === 'chunk' ? ['chunk', event.chunk] : [event.kind],
        ]);
        const order = detailedEvents.filter(event => event[0] !== 'chunk').map(event => event[0]);

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>We need to call the function.</think>", `\
Here’s the weather for Tokyo:

- **Temperature:** 20\u202f°C\u0020\u0020
- **Condition:** Clear

Let me know if you’d like more details or a forecast!`]);
        expect(order).toEqual(["assistant-start", "tool-call", "execute", "tool-result", "assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        // This complete source has no matching historical Full output: preserve its exact chunk/interleaving contract here.
        expect(detailedEvents).toEqual([["assistant-start"], ["chunk", "<think>"], ["chunk", "We "], ["chunk", "need "], ["chunk", "to "], ["chunk", "call "], ["chunk", "the "], ["chunk", "function."], ["chunk", "</think>"], ["tool-call"], ["execute"], ["tool-result"], ["assistant-start"], ["chunk", "Here’s "], ["chunk", "the "], ["chunk", "weather "], ["chunk", "for "], ["chunk", `\
Tokyo:

`], ["chunk", "- "], ["chunk", "**Temperature:** "], ["chunk", `\
20\u202f°C\u0020\u0020
`], ["chunk", "- "], ["chunk", "**Condition:** "], ["chunk", `\
Clear

`], ["chunk", "Let "], ["chunk", "me "], ["chunk", "know "], ["chunk", "if "], ["chunk", "you’d "], ["chunk", "like "], ["chunk", "more "], ["chunk", "details "], ["chunk", "or "], ["chunk", "a "], ["chunk", "forecast!"], ["settled"]]);
        expect(calls).toEqual([{ id: expect.any(String), toolName: 'lookup_weather', modelVisibleArguments: '{"city":"Tokyo"}' }]);
        expect(calls[0]!.id).not.toBe('');
        expect(results).toEqual([{ id: calls[0]!.id, result: { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' } }]);
        expect(executions.map(({ args }) => args)).toEqual([{ city: 'Tokyo' }]);
        expect(executions[0]!.signal).toBe(signal);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 2 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
    expect(lateExecutions).toEqual([]);
    expect(boundaries).toEqual(['natural-tool-minimal/1', 'natural-tool-minimal/2']);
  }, 30_000);
  it('tools: executes the recorded representative Tokyo call once and delivers the owned-cache continuation', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const boundaries: string[] = [];
    const replay = await createProviderRequestReplayWithOwnedCacheControl({
      catalog: ownedToolCatalog,
      caseIds: ['natural-tool-representative'],
      artifactPaths: ownedToolArtifacts,
      imagePlatform: undefined,
      createNativeController: () => createOwnedToolControl({ mutations: 'none', boundaries }),
    });
    const captures: ProviderChatCapture[] = [];
    const lateExecutions: string[] = [];
    try {
      // natural-tool-representative: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 128,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        const captureRef: { current: ProviderChatCapture | undefined } = { current: undefined };
        const executions: { args: unknown; signal: AbortSignal | undefined; callbackPrefix: ReturnType<ProviderChatCapture['snapshot']> | undefined }[] = [];
        const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.",
          parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args, signal: receivedSignal }) => {
            const callbackPrefix = captureRef.current?.snapshot();
            executions.push({ args: structuredClone(args), signal: receivedSignal, callbackPrefix });
            if (callbackPrefix?.settlement.status !== 'pending') lateExecutions.push('execute');
            return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
          },
        }];
        replay.beginNativeRequest({ caseId: "natural-tool-representative", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Use lookup_weather for Tokyo, then give a short answer based on the tool result." }],
            parameters,
            tools: tools,
            signal,
          },
        });
        captureRef.current = capture;
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        // Record the actual callback prefix at execute; do not wrap tools or infer their position.
        for (const execution of executions) {
          expect(execution.callbackPrefix?.settlement).toEqual({ status: 'pending' });
          expect(execution.callbackPrefix?.events.at(-1)?.kind).toBe('tool-call');
          expect(execution.callbackPrefix?.events).toEqual(observed.events.slice(0, execution.callbackPrefix?.events.length));
        }
        const detailedEvents = observed.events.flatMap((event, index) => [
          ...executions.filter(execution => execution.callbackPrefix?.events.length === index).map(() => ['execute']),
          event.kind === 'chunk' ? ['chunk', event.chunk] : [event.kind],
        ]);
        const order = detailedEvents.filter(event => event[0] !== 'chunk').map(event => event[0]);

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>We need to call the function lookup_weather with city \"Tokyo\".</think>", "Tokyo is clear with a comfortable temperature of about 20\u202f°C."]);
        expect(order).toEqual(["assistant-start", "tool-call", "execute", "tool-result", "assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        // This complete source has no matching historical Full output: preserve its exact chunk/interleaving contract here.
        expect(detailedEvents).toEqual([["assistant-start"], ["chunk", "<think>"], ["chunk", "We "], ["chunk", "need "], ["chunk", "to "], ["chunk", "call "], ["chunk", "the "], ["chunk", "function "], ["chunk", "lookup_weather "], ["chunk", "with "], ["chunk", "city "], ["chunk", "\"Tokyo\"."], ["chunk", "</think>"], ["tool-call"], ["execute"], ["tool-result"], ["assistant-start"], ["chunk", "Tokyo "], ["chunk", "is "], ["chunk", "clear "], ["chunk", "with "], ["chunk", "a "], ["chunk", "comfortable "], ["chunk", "temperature "], ["chunk", "of "], ["chunk", "about "], ["chunk", "20\u202f°C."], ["settled"]]);
        expect(calls).toEqual([{ id: expect.any(String), toolName: 'lookup_weather', modelVisibleArguments: '{"city":"Tokyo"}' }]);
        expect(calls[0]!.id).not.toBe('');
        expect(results).toEqual([{ id: calls[0]!.id, result: { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' } }]);
        expect(executions.map(({ args }) => args)).toEqual([{ city: 'Tokyo' }]);
        expect(executions[0]!.signal).toBe(signal);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 2 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
    expect(lateExecutions).toEqual([]);
    expect(boundaries).toEqual(['natural-tool-representative/1', 'natural-tool-representative/2']);
  }, 30_000);
  it('tools: rejects wrong cache identity, length, prefix and double-counted context before native output', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const boundaries: string[] = [];
    const replay = await createProviderRequestReplayWithOwnedCacheControl({
      catalog: ownedToolCatalog,
      caseIds: ['natural-tool-minimal'],
      artifactPaths: ownedToolArtifacts,
      imagePlatform: undefined,
      createNativeController: () => createOwnedToolControl({ mutations: 'verify', boundaries }),
    });
    const captures: ProviderChatCapture[] = [];
    const lateExecutions: string[] = [];
    try {
      // natural-tool-minimal: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 128,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        const captureRef: { current: ProviderChatCapture | undefined } = { current: undefined };
        const executions: { args: unknown; signal: AbortSignal | undefined; callbackPrefix: ReturnType<ProviderChatCapture['snapshot']> | undefined }[] = [];
        const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.",
          parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args, signal: receivedSignal }) => {
            const callbackPrefix = captureRef.current?.snapshot();
            executions.push({ args: structuredClone(args), signal: receivedSignal, callbackPrefix });
            if (callbackPrefix?.settlement.status !== 'pending') lateExecutions.push('execute');
            return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
          },
        }];
        replay.beginNativeRequest({ caseId: "natural-tool-minimal", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Use the weather tool for Tokyo." }],
            parameters,
            tools: tools,
            signal,
          },
        });
        captureRef.current = capture;
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        // Record the actual callback prefix at execute; do not wrap tools or infer their position.
        for (const execution of executions) {
          expect(execution.callbackPrefix?.settlement).toEqual({ status: 'pending' });
          expect(execution.callbackPrefix?.events.at(-1)?.kind).toBe('tool-call');
          expect(execution.callbackPrefix?.events).toEqual(observed.events.slice(0, execution.callbackPrefix?.events.length));
        }
        const detailedEvents = observed.events.flatMap((event, index) => [
          ...executions.filter(execution => execution.callbackPrefix?.events.length === index).map(() => ['execute']),
          event.kind === 'chunk' ? ['chunk', event.chunk] : [event.kind],
        ]);
        const order = detailedEvents.filter(event => event[0] !== 'chunk').map(event => event[0]);

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>We need to call the function.</think>", `\
Here’s the weather for Tokyo:

- **Temperature:** 20\u202f°C\u0020\u0020
- **Condition:** Clear

Let me know if you’d like more details or a forecast!`]);
        expect(order).toEqual(["assistant-start", "tool-call", "execute", "tool-result", "assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        // This complete source has no matching historical Full output: preserve its exact chunk/interleaving contract here.
        expect(detailedEvents).toEqual([["assistant-start"], ["chunk", "<think>"], ["chunk", "We "], ["chunk", "need "], ["chunk", "to "], ["chunk", "call "], ["chunk", "the "], ["chunk", "function."], ["chunk", "</think>"], ["tool-call"], ["execute"], ["tool-result"], ["assistant-start"], ["chunk", "Here’s "], ["chunk", "the "], ["chunk", "weather "], ["chunk", "for "], ["chunk", `\
Tokyo:

`], ["chunk", "- "], ["chunk", "**Temperature:** "], ["chunk", `\
20\u202f°C\u0020\u0020
`], ["chunk", "- "], ["chunk", "**Condition:** "], ["chunk", `\
Clear

`], ["chunk", "Let "], ["chunk", "me "], ["chunk", "know "], ["chunk", "if "], ["chunk", "you’d "], ["chunk", "like "], ["chunk", "more "], ["chunk", "details "], ["chunk", "or "], ["chunk", "a "], ["chunk", "forecast!"], ["settled"]]);
        expect(calls).toEqual([{ id: expect.any(String), toolName: 'lookup_weather', modelVisibleArguments: '{"city":"Tokyo"}' }]);
        expect(calls[0]!.id).not.toBe('');
        expect(results).toEqual([{ id: calls[0]!.id, result: { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' } }]);
        expect(executions.map(({ args }) => args)).toEqual([{ city: 'Tokyo' }]);
        expect(executions[0]!.signal).toBe(signal);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 2 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
    expect(lateExecutions).toEqual([]);
    expect(boundaries).toEqual(['natural-tool-minimal/1', 'natural-tool-minimal/2', 'natural-tool-minimal/rejected-identity-length-prefix-double-count']);
  }, 30_000);
  it("tools-generation characterizes the current developer-namespace projection without certifying native tool compatibility", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = toolInputEvidence.cases.find((item): boolean => item.caseId === "tools-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'GPT-OSS tool input inspected; no generated output supplied';
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }));
    const publicTool: Tool = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    };
    // This is the separately specified current Naidan projection, NOT a browser
    // capture or native-default parity claim. GPT-OSS deliberately renders tool
    // definitions as developer instructions rather than passing native tools.
    // Keep the original native tools control below so that difference is visible.
    // This projection also omits the native tool-channel instruction, not just
    // whitespace. Its semantic equivalence is UNPROVEN; this diagnostic must not
    // be counted as a passing natural-tool compatibility regression.
    const developerNamespace = `\
namespace functions {
// Return deterministic weather fixture data.
type lookup_weather = (_: {
  city: string,
}) => any;

} // namespace functions`;
    const userHeader = '<|start|>user<|message|>';
    const noToolsSource = inputEvidence.cases.find(item => item.caseId === 'user-generation');
    if (!noToolsSource) throw new Error('Missing captured native system scaffold');
    expect(noToolsSource.renderedText.split(userHeader)).toHaveLength(2);
    expect(scenario.renderedText.split(userHeader)).toHaveLength(2);
    const expectedRenderedText = noToolsSource.renderedText.split(userHeader)[0]
      + `<|start|>developer<|message|># Instructions\n\n${developerNamespace}<|end|>`
      + userHeader + scenario.renderedText.split(userHeader)[1];
    const nativeChannelInstruction = "Calls to these tools must go to the commentary channel: 'functions'.";
    expect(scenario.renderedText.split(nativeChannelInstruction)).toHaveLength(2);
    expect(expectedRenderedText.split(nativeChannelInstruction)).toHaveLength(1);
    // The source's arguments and result are JSON strings serialized again by
    // native tojson. Preserve that observation, but do not certify that this
    // representation is suitable for a naturally generated tool invocation.
    const nativeInputs: Array<{
      input: { type: string; location: string; dims: number[]; data: number[] } | undefined;
      mask: { type: string; location: string; dims: number[]; data: bigint[] } | undefined;
      past: unknown;
    }> = [];
    const repositoryPaths = [
      'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data',
      'onnx/model_q4f16.onnx_data_1', 'onnx/model_q4f16.onnx_data_2',
      'onnx/model_q4f16.onnx_data_3', 'onnx/model_q4f16.onnx_data_4',
      'onnx/model_q4f16.onnx_data_5', 'onnx/model_q4f16.onnx_data_6',
    ];
    const harness = await createProviderReplayTestRuntime({
      modelId: toolInputEvidence.modelId,
      expectedRevision: toolInputEvidence.revision,
      cacheRevision: toolInputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      artifacts: repositoryPaths.map(path => ({ path, bytes: createSyntheticModelBody({ modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, path }) })),
      generate: async ({ options, runtime }) => {
        nativeInputs.push({
          input: options.input_ids instanceof runtime.Tensor ? { type: options.input_ids.type, location: options.input_ids.location, dims: [...options.input_ids.dims], data: Array.from(options.input_ids.data, Number) } : undefined,
          mask: options.attention_mask instanceof runtime.Tensor ? { type: options.attention_mask.type, location: options.attention_mask.location, dims: [...options.attention_mask.dims], data: Array.from(options.attention_mask.data, BigInt) } : undefined,
          past: options.past_key_values,
        });
        // Supplied tool history is not a completed natural tool loop or KV reuse.
        throw new Error(boundary);
      },
    });
    try {
      await harness.service.loadDownloadedModel({ modelId: toolInputEvidence.modelId });
      const tokenizer = await harness.runtime.AutoTokenizer.from_pretrained(toolInputEvidence.modelId, {
        revision: toolInputEvidence.revision, local_files_only: true,
      });
      expect(createHash('sha256').update(tokenizer.get_chat_template({ tools: scenario.tools })).digest('hex'))
        .toBe(toolInputEvidence.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: scenario.tools,
      })).toBe(scenario.renderedText);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: true, return_tensor: false, return_dict: false, add_generation_prompt: true, tools: scenario.tools,
      })).toEqual(scenario.inputTokenIds);
      // The template does not render additionalProperties, so this explicit
      // public schema difference is not the source of the namespace difference.
      const strictTools = scenario.tools.map(tool => ({
        ...tool, function: { ...tool.function, parameters: {
          ...tool.function.parameters,
          additionalProperties: false
        } },
      }));
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: strictTools,
      })).toBe(scenario.renderedText);
      const expectedIds = tokenizer.encode(expectedRenderedText, { add_special_tokens: false });
      const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
      try {
        const capture = captureProviderChat({
          provider: harness.provider,
          request: {
            model: toolInputEvidence.modelId,
            messages: [{ role: "user", content: "Use the weather tool for Tokyo." }],
            tools: [publicTool],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: {
                effort: undefined,
              },
            },
          },
        });
        captures.push(capture);
        await expect(capture.completion).rejects.toThrow(boundary);
        const { chunks, toolCalls, toolResults } = capture.snapshot();
        const observedMessageSchema = z.object({
          role: z.string(), content: z.string(),
          tool_calls: toolAssistantSchema.shape.tool_calls.optional(),
          tool_call_id: z.literal('call_template_probe_1').optional(),
        }).strict();
        const observedTokenizations = templateSpy.mock.calls
          .filter(([, options]) => options?.tokenize !== false)
          .map(([rawMessages, options]) => [
            z.array(observedMessageSchema).parse(rawMessages).map(message => {
              const { role, content, tool_calls, tool_call_id, ...unhandled } = message;
              unhandled satisfies Record<PropertyKey, never>;
              return { role, content, tool_calls, tool_call_id };
            }), options,
          ]);
        // Compare semantic values after the real call, not property membership.
        // The separate history regression demonstrates why the real adapter's
        // own undefined property must be removable by a subsequent fix. Nothing
        // is normalized on the actual Production/tokenizer execution path.
        expect(observedTokenizations).toStrictEqual([[
          [
            { role: 'developer', content: developerNamespace, tool_calls: undefined, tool_call_id: undefined },
            ...scenario.messages.map(message => ({
              role: message.role, content: message.content,
              tool_calls: 'tool_calls' in message ? message.tool_calls : undefined,
              tool_call_id: 'tool_call_id' in message ? message.tool_call_id : undefined,
            })),
          ],
          { add_generation_prompt: true, return_dict: true },
        ]]);
        expect(nativeInputs).toHaveLength(1);
        const observedInput = nativeInputs[0]!;
        expect(observedInput.input?.data).toEqual(expectedIds);
        expect(observedInput.input?.type).toBe('int64');
        expect(observedInput.input?.location).toBe('cpu');
        expect(observedInput.input?.dims).toEqual([1, expectedIds.length]);
        expect(observedInput.mask?.type).toBe('int64');
        expect(observedInput.mask?.location).toBe('cpu');
        expect(observedInput.mask?.dims).toEqual([1, expectedIds.length]);
        expect(observedInput.mask?.data).toEqual(expectedIds.map(() => 1n));
        expect(observedInput.past).toBeNull();
        expect(chunks).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
        expect(toolCalls).toEqual([]);
        expect(toolResults).toEqual([]);
        expect(harness.observations.inferenceCalls).toHaveLength(1);
        expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
        expect(harness.observations.localImageFetchCalls).toEqual([]);
        expect(harness.observations.forbiddenTransport).toEqual([]);
        expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
        expect(harness.observations.ortCalls.map(([core, options]) => inspectSyntheticOrtSession({
          modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision,
          repositoryPaths: new Set(repositoryPaths), core, options,
        }))).toEqual([{
          modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, corePath: repositoryPaths[0], executionProviders: ['webgpu'],
          externalData: repositoryPaths.slice(1).map(artifactPath => ({ path: artifactPath.slice('onnx/'.length), artifactPath })),
        }]);
      } finally {
        templateSpy.mockRestore();
      }
    } finally {
      await harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it("tool-result-continuation characterizes the current developer-namespace projection without certifying native tool compatibility", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = toolInputEvidence.cases.find((item): boolean => item.caseId === "tool-result-continuation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'GPT-OSS tool input inspected; no generated output supplied';
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }));
    const publicTool: Tool = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    };
    const messages: ChatMessage[] = [{ role: "user", content: "Use the weather tool for Tokyo." }, { role: "assistant", content: "", tool_calls: [{ id: toToolCallId({ raw: "call_template_probe_1" }), type: "function", function: { name: "lookup_weather", arguments: "{\"city\":\"Tokyo\"}" } }] }, { role: "tool", tool_call_id: toToolCallId({ raw: "call_template_probe_1" }), content: "{\"temperatureC\":20,\"condition\":\"clear\"}" }];
    // This is the separately specified current Naidan projection, NOT a browser
    // capture or native-default parity claim. GPT-OSS deliberately renders tool
    // definitions as developer instructions rather than passing native tools.
    // Keep the original native tools control below so that difference is visible.
    // This projection also omits the native tool-channel instruction, not just
    // whitespace. Its semantic equivalence is UNPROVEN; this diagnostic must not
    // be counted as a passing natural-tool compatibility regression.
    const developerNamespace = `\
namespace functions {
// Return deterministic weather fixture data.
type lookup_weather = (_: {
  city: string,
}) => any;

} // namespace functions`;
    const userHeader = '<|start|>user<|message|>';
    const noToolsSource = inputEvidence.cases.find(item => item.caseId === 'user-generation');
    if (!noToolsSource) throw new Error('Missing captured native system scaffold');
    expect(noToolsSource.renderedText.split(userHeader)).toHaveLength(2);
    expect(scenario.renderedText.split(userHeader)).toHaveLength(2);
    const expectedRenderedText = noToolsSource.renderedText.split(userHeader)[0]
      + `<|start|>developer<|message|># Instructions\n\n${developerNamespace}<|end|>`
      + userHeader + scenario.renderedText.split(userHeader)[1];
    const nativeChannelInstruction = "Calls to these tools must go to the commentary channel: 'functions'.";
    expect(scenario.renderedText.split(nativeChannelInstruction)).toHaveLength(2);
    expect(expectedRenderedText.split(nativeChannelInstruction)).toHaveLength(1);
    // The source's arguments and result are JSON strings serialized again by
    // native tojson. Preserve that observation, but do not certify that this
    // representation is suitable for a naturally generated tool invocation.
    const nativeInputs: Array<{
      input: { type: string; location: string; dims: number[]; data: number[] } | undefined;
      mask: { type: string; location: string; dims: number[]; data: bigint[] } | undefined;
      past: unknown;
    }> = [];
    const repositoryPaths = [
      'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data',
      'onnx/model_q4f16.onnx_data_1', 'onnx/model_q4f16.onnx_data_2',
      'onnx/model_q4f16.onnx_data_3', 'onnx/model_q4f16.onnx_data_4',
      'onnx/model_q4f16.onnx_data_5', 'onnx/model_q4f16.onnx_data_6',
    ];
    const harness = await createProviderReplayTestRuntime({
      modelId: toolInputEvidence.modelId,
      expectedRevision: toolInputEvidence.revision,
      cacheRevision: toolInputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      artifacts: repositoryPaths.map(path => ({ path, bytes: createSyntheticModelBody({ modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, path }) })),
      generate: async ({ options, runtime }) => {
        nativeInputs.push({
          input: options.input_ids instanceof runtime.Tensor ? { type: options.input_ids.type, location: options.input_ids.location, dims: [...options.input_ids.dims], data: Array.from(options.input_ids.data, Number) } : undefined,
          mask: options.attention_mask instanceof runtime.Tensor ? { type: options.attention_mask.type, location: options.attention_mask.location, dims: [...options.attention_mask.dims], data: Array.from(options.attention_mask.data, BigInt) } : undefined,
          past: options.past_key_values,
        });
        // Supplied tool history is not a completed natural tool loop or KV reuse.
        throw new Error(boundary);
      },
    });
    try {
      await harness.service.loadDownloadedModel({ modelId: toolInputEvidence.modelId });
      const tokenizer = await harness.runtime.AutoTokenizer.from_pretrained(toolInputEvidence.modelId, {
        revision: toolInputEvidence.revision, local_files_only: true,
      });
      expect(createHash('sha256').update(tokenizer.get_chat_template({ tools: scenario.tools })).digest('hex'))
        .toBe(toolInputEvidence.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: scenario.tools,
      })).toBe(scenario.renderedText);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: true, return_tensor: false, return_dict: false, add_generation_prompt: true, tools: scenario.tools,
      })).toEqual(scenario.inputTokenIds);
      // The template does not render additionalProperties, so this explicit
      // public schema difference is not the source of the namespace difference.
      const strictTools = scenario.tools.map(tool => ({
        ...tool, function: { ...tool.function, parameters: {
          ...tool.function.parameters,
          additionalProperties: false
        } },
      }));
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: strictTools,
      })).toBe(scenario.renderedText);
      const expectedIds = tokenizer.encode(expectedRenderedText, { add_special_tokens: false });
      const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
      try {
        const capture = captureProviderChat({
          provider: harness.provider,
          request: {
            model: toolInputEvidence.modelId,
            messages,
            tools: [publicTool],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: {
                effort: undefined,
              },
            },
          },
        });
        captures.push(capture);
        await expect(capture.completion).rejects.toThrow(boundary);
        const { chunks, toolCalls, toolResults } = capture.snapshot();
        const observedMessageSchema = z.object({
          role: z.string(), content: z.string(),
          tool_calls: toolAssistantSchema.shape.tool_calls.optional(),
          tool_call_id: z.literal('call_template_probe_1').optional(),
        }).strict();
        const observedTokenizations = templateSpy.mock.calls
          .filter(([, options]) => options?.tokenize !== false)
          .map(([rawMessages, options]) => [
            z.array(observedMessageSchema).parse(rawMessages).map(message => {
              const { role, content, tool_calls, tool_call_id, ...unhandled } = message;
              unhandled satisfies Record<PropertyKey, never>;
              return { role, content, tool_calls, tool_call_id };
            }), options,
          ]);
        // Compare semantic values after the real call, not property membership.
        // The separate history regression demonstrates why the real adapter's
        // own undefined property must be removable by a subsequent fix. Nothing
        // is normalized on the actual Production/tokenizer execution path.
        expect(observedTokenizations).toStrictEqual([[
          [
            { role: 'developer', content: developerNamespace, tool_calls: undefined, tool_call_id: undefined },
            ...scenario.messages.map(message => ({
              role: message.role, content: message.content,
              tool_calls: 'tool_calls' in message ? message.tool_calls : undefined,
              tool_call_id: 'tool_call_id' in message ? message.tool_call_id : undefined,
            })),
          ],
          { add_generation_prompt: true, return_dict: true },
        ]]);
        expect(nativeInputs).toHaveLength(1);
        const observedInput = nativeInputs[0]!;
        expect(observedInput.input?.data).toEqual(expectedIds);
        expect(observedInput.input?.type).toBe('int64');
        expect(observedInput.input?.location).toBe('cpu');
        expect(observedInput.input?.dims).toEqual([1, expectedIds.length]);
        expect(observedInput.mask?.type).toBe('int64');
        expect(observedInput.mask?.location).toBe('cpu');
        expect(observedInput.mask?.dims).toEqual([1, expectedIds.length]);
        expect(observedInput.mask?.data).toEqual(expectedIds.map(() => 1n));
        expect(observedInput.past).toBeNull();
        expect(chunks).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
        expect(toolCalls).toEqual([]);
        expect(toolResults).toEqual([]);
        expect(harness.observations.inferenceCalls).toHaveLength(1);
        expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
        expect(harness.observations.localImageFetchCalls).toEqual([]);
        expect(harness.observations.forbiddenTransport).toEqual([]);
        expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
        expect(harness.observations.ortCalls.map(([core, options]) => inspectSyntheticOrtSession({
          modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision,
          repositoryPaths: new Set(repositoryPaths), core, options,
        }))).toEqual([{
          modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, corePath: repositoryPaths[0], executionProviders: ['webgpu'],
          externalData: repositoryPaths.slice(1).map(artifactPath => ({ path: artifactPath.slice('onnx/'.length), artifactPath })),
        }]);
      } finally {
        templateSpy.mockRestore();
      }
    } finally {
      await harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
});

describe('GPT-OSS 20B Provider / images', () => {
  it('images: preserves the recorded text-only native handling of an image-bearing request', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["image"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
    try {
      // image: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 1,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "image", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: [{ type: "text", text: "Describe the single synthetic image in one short phrase." }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } }] }],
            parameters,
            tools: [],
            signal,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(responses.map(chunks => chunks.join(''))).toEqual([""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
});

describe('GPT-OSS 20B Provider / sequences', () => {
  it('sequences: keeps structured caller history independent after a completed cache-producing tool request', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const boundaries: string[] = [];
    const replay = await createProviderRequestReplayWithOwnedCacheControl({
      catalog: ownedToolCatalog,
      caseIds: ['natural-tool-representative', 'structured-tool-history'],
      artifactPaths: ownedToolArtifacts,
      imagePlatform: undefined,
      createNativeController: () => createOwnedToolControl({ mutations: 'none', boundaries }),
    });
    const captures: ProviderChatCapture[] = [];
    const lateExecutions: string[] = [];
    try {
      // natural-tool-representative: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 128,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        const captureRef: { current: ProviderChatCapture | undefined } = { current: undefined };
        const executions: { args: unknown; signal: AbortSignal | undefined; callbackPrefix: ReturnType<ProviderChatCapture['snapshot']> | undefined }[] = [];
        const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.",
          parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args, signal: receivedSignal }) => {
            const callbackPrefix = captureRef.current?.snapshot();
            executions.push({ args: structuredClone(args), signal: receivedSignal, callbackPrefix });
            if (callbackPrefix?.settlement.status !== 'pending') lateExecutions.push('execute');
            return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
          },
        }];
        replay.beginNativeRequest({ caseId: "natural-tool-representative", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Use lookup_weather for Tokyo, then give a short answer based on the tool result." }],
            parameters,
            tools: tools,
            signal,
          },
        });
        captureRef.current = capture;
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        // Record the actual callback prefix at execute; do not wrap tools or infer their position.
        for (const execution of executions) {
          expect(execution.callbackPrefix?.settlement).toEqual({ status: 'pending' });
          expect(execution.callbackPrefix?.events.at(-1)?.kind).toBe('tool-call');
          expect(execution.callbackPrefix?.events).toEqual(observed.events.slice(0, execution.callbackPrefix?.events.length));
        }
        const detailedEvents = observed.events.flatMap((event, index) => [
          ...executions.filter(execution => execution.callbackPrefix?.events.length === index).map(() => ['execute']),
          event.kind === 'chunk' ? ['chunk', event.chunk] : [event.kind],
        ]);
        const order = detailedEvents.filter(event => event[0] !== 'chunk').map(event => event[0]);

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>We need to call the function lookup_weather with city \"Tokyo\".</think>", "Tokyo is clear with a comfortable temperature of about 20\u202f°C."]);
        expect(order).toEqual(["assistant-start", "tool-call", "execute", "tool-result", "assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        // This complete source has no matching historical Full output: preserve its exact chunk/interleaving contract here.
        expect(detailedEvents).toEqual([["assistant-start"], ["chunk", "<think>"], ["chunk", "We "], ["chunk", "need "], ["chunk", "to "], ["chunk", "call "], ["chunk", "the "], ["chunk", "function "], ["chunk", "lookup_weather "], ["chunk", "with "], ["chunk", "city "], ["chunk", "\"Tokyo\"."], ["chunk", "</think>"], ["tool-call"], ["execute"], ["tool-result"], ["assistant-start"], ["chunk", "Tokyo "], ["chunk", "is "], ["chunk", "clear "], ["chunk", "with "], ["chunk", "a "], ["chunk", "comfortable "], ["chunk", "temperature "], ["chunk", "of "], ["chunk", "about "], ["chunk", "20\u202f°C."], ["settled"]]);
        expect(calls).toEqual([{ id: expect.any(String), toolName: 'lookup_weather', modelVisibleArguments: '{"city":"Tokyo"}' }]);
        expect(calls[0]!.id).not.toBe('');
        expect(results).toEqual([{ id: calls[0]!.id, result: { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' } }]);
        expect(executions.map(({ args }) => args)).toEqual([{ city: 'Tokyo' }]);
        expect(executions[0]!.signal).toBe(signal);
      }
      // structured-tool-history: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 128,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        const captureRef: { current: ProviderChatCapture | undefined } = { current: undefined };
        const executions: { args: unknown; signal: AbortSignal | undefined; callbackPrefix: ReturnType<ProviderChatCapture['snapshot']> | undefined }[] = [];
        const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.",
          parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args, signal: receivedSignal }) => {
            const callbackPrefix = captureRef.current?.snapshot();
            executions.push({ args: structuredClone(args), signal: receivedSignal, callbackPrefix });
            if (callbackPrefix?.settlement.status !== 'pending') lateExecutions.push('execute');
            return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
          },
        }];
        replay.beginNativeRequest({ caseId: "structured-tool-history", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Use the weather tool for Tokyo." }, { role: "assistant", content: "", tool_calls: [{ id: toToolCallId({ raw: "call_model_support_probe_1" }), type: "function", function: { name: "lookup_weather", arguments: "{\"city\":\"Tokyo\"}" } }] }, { role: "tool", content: "{\"temperatureC\":20,\"condition\":\"clear\"}", tool_call_id: toToolCallId({ raw: "call_model_support_probe_1" }) }],
            parameters,
            tools: tools,
            signal,
          },
        });
        captureRef.current = capture;
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        // Record the actual callback prefix at execute; do not wrap tools or infer their position.
        for (const execution of executions) {
          expect(execution.callbackPrefix?.settlement).toEqual({ status: 'pending' });
          expect(execution.callbackPrefix?.events.at(-1)?.kind).toBe('tool-call');
          expect(execution.callbackPrefix?.events).toEqual(observed.events.slice(0, execution.callbackPrefix?.events.length));
        }
        const detailedEvents = observed.events.flatMap((event, index) => [
          ...executions.filter(execution => execution.callbackPrefix?.events.length === index).map(() => ['execute']),
          event.kind === 'chunk' ? ['chunk', event.chunk] : [event.kind],
        ]);
        const order = detailedEvents.filter(event => event[0] !== 'chunk').map(event => event[0]);

        expect(responses.map(chunks => chunks.join(''))).toEqual([`\
<think>We need to respond to user: "Use the weather tool for Tokyo." We already used the tool. Now we should respond with the result. The tool returned JSON: {"temperatureC":20,"condition":"clear"}. We should present that to user.</think>Here’s the current weather in Tokyo:

- **Temperature:** 20\u202f°C\u0020\u0020
- **Condition:** Clear`]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        // This complete source has no matching historical Full output: preserve its exact chunk/interleaving contract here.
        expect(detailedEvents).toEqual([["assistant-start"], ["chunk", "<think>"], ["chunk", "We "], ["chunk", "need "], ["chunk", "to "], ["chunk", "respond "], ["chunk", "to "], ["chunk", "user: "], ["chunk", "\"Use "], ["chunk", "the "], ["chunk", "weather "], ["chunk", "tool "], ["chunk", "for "], ["chunk", "Tokyo.\" "], ["chunk", "We "], ["chunk", "already "], ["chunk", "used "], ["chunk", "the "], ["chunk", "tool. "], ["chunk", "Now "], ["chunk", "we "], ["chunk", "should "], ["chunk", "respond "], ["chunk", "with "], ["chunk", "the "], ["chunk", "result. "], ["chunk", "The "], ["chunk", "tool "], ["chunk", "returned "], ["chunk", "JSON: "], ["chunk", "{\"temperatureC\":20,\"condition\":\"clear\"}. "], ["chunk", "We "], ["chunk", "should "], ["chunk", "present "], ["chunk", "that "], ["chunk", "to "], ["chunk", "user."], ["chunk", "</think>"], ["chunk", "Here’s "], ["chunk", "the "], ["chunk", "current "], ["chunk", "weather "], ["chunk", "in "], ["chunk", `\
Tokyo:

`], ["chunk", "- "], ["chunk", "**Temperature:** "], ["chunk", `\
20\u202f°C\u0020\u0020
`], ["chunk", "- "], ["chunk", "**Condition:** "], ["chunk", "Clear"], ["settled"]]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
        expect(executions).toEqual([]);
      }
      replay.assertComplete({ requests: 2, nativeCalls: 3 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
    expect(lateExecutions).toEqual([]);
    expect(boundaries).toEqual(['natural-tool-representative/1', 'natural-tool-representative/2', 'structured-tool-history/1']);
  }, 30_000);
  it('sequences: builds continuation from actually delivered first-request settlement', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn","continuity"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
    let firstResponse = '';
    try {
      // first-turn: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 16,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "first-turn", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }],
            parameters,
            tools: [],
            signal,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The user says \"Template probe user message.\" This seems like a"]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
        firstResponse = responses[0]!.join('');
      }
      // continuity: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 16,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: {
            effort: undefined,
          },
        };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "continuity", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "onnx-community/gpt-oss-20b-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }, { role: "assistant", content: firstResponse }, { role: "user", content: "Continue the synthetic conversation with a short response." }],
            parameters,
            tools: [],
            signal,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents, lateEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>We need to respond with a short response. Probably just a short"]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
      }
      replay.assertComplete({ requests: 2, nativeCalls: 2 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('preserves recorded calls and the independent image request without replaying invalid cached continuations', async () => {
    const fullEvidenceJson = assembleProviderSequenceEvidence({ catalog: providerReplayCatalog });
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const recorded = parseCapturedFullReplay({ value: fullEvidenceJson });
    expect(recorded.modelId).toBe('onnx-community/gpt-oss-20b-ONNX');
    expect(recorded.metadataRevision).toBe('6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7');
    expect(recorded.observedCacheRevision).toBe('main');
    const caches = new Map<number, NonNullable<Parameters<ProviderReplayGenerate>[0]['options']['past_key_values']>>();
    await verifyCapturedFullReplay({ reviewedPublicContract: undefined, evidence: recorded, imagePlatform: undefined, expectedLoadReceipt: undefined,
      artifactPaths: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', ...Array.from({ length: 6 }, (_, index) => `onnx/model_q4f16.onnx_data_${index + 1}`)],
      completeResult: ({ callOrdinal, runtime, result }) => {
        if (callOrdinal !== 10 && callOrdinal !== 12) return result;
        // Source-derived control only: native KV bytes were not captured. The
        // actual cache class supplies identity; only observed length is synthetic.
        const cache = new runtime.DynamicCache();
        vi.spyOn(cache, 'get_seq_length').mockReturnValue(result.sequences.dims[1]! - 1);
        caches.set(callOrdinal, cache);
        return { ...result, past_key_values: cache };
      },
      unavailableOutputs: [11, 13, 14].map(callOrdinal => {
        const invocation = recorded.invocations[callOrdinal - 1]!;
        const request = recorded.requests.find(item => item.scenario === invocation.scenario)!;
        const starts = request.events.flatMap((event, index) => typeof event === 'object' && event !== null && !Array.isArray(event) && event.kind === 'assistant-start' ? [index] : []);
        // Retain every first-call chunk/thinking/tool callback and the second
        // assistant start, but never the old invalid second-call output.
        const expectedEventsBeforeGap = request.events.slice(0, (callOrdinal === 14 ? starts[0]! : starts[1]!) + 1);
        return { callOrdinal, scenario: invocation.scenario, requestInput: request.input, expectedEventsBeforeGap,
          verifyInput: ({ options, runtime, tokenizer, model }) => {
            if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor) || !options.streamer) throw new Error('Missing corrected GPT input');
            // Old calls 11/13 omitted an unconsumed terminal token; call 14
            // additionally belonged to another public chat. None is an oracle
            // for the corrected native input, even though the old run fulfilled.
            expect(() => replayCapturedFullInvocation({ invocation, options, runtime, modelConfig: model.config, parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 128
            } })).toThrow();
            // The real native capture verifies zero stream events. Do not
            // replace its owned streamer descriptors with test spies here.
            let expected: bigint[];
            if (callOrdinal === 14) {
              expect(options.past_key_values).toBeNull();
              // Independent source-derived canonical input, not an observed
              // post-fix output or a call to Naidan's formatter under test.
              const namespace = `\
namespace functions {
// Return deterministic weather fixture data.
type lookup_weather = (_: {
  city: string,
}) => any;

} // namespace functions`;
              const canonicalMessages = [
                { role: 'developer', content: namespace },
                { role: 'user', content: 'Use the weather tool for Tokyo.' },
                { role: 'assistant', content: '', tool_calls: [{ id: 'call_model_support_probe_1', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' } }] },
                { role: 'tool', content: '{"temperatureC":20,"condition":"clear"}', tool_call_id: 'call_model_support_probe_1' },
              ];
              const inputs = tokenizer.apply_chat_template(canonicalMessages, { add_generation_prompt: true, return_dict: true });
              const parsed = z.object({ input_ids: z.instanceof(runtime.Tensor) }).parse(inputs);
              expected = Array.from(parsed.input_ids.data, BigInt);
            } else {
              const previous = recorded.invocations[callOrdinal - 2]!;
              const suffix = tokenizer.encode('<|start|>lookup_weather to=assistant<|channel|>commentary<|message|>{"temperatureC":20,"condition":"clear"}<|end|>', { add_special_tokens: false });
              expected = [...previous.sequence.tokens.map(BigInt), ...suffix.map(BigInt)];
              expect(options.past_key_values).toBe(caches.get(callOrdinal - 1));
              expect(options.past_key_values?.get_seq_length()).toBe(previous.sequence.tokens.length - 1);
            }
            expect(options.input_ids.type).toBe('int64');
            expect(options.input_ids.dims).toEqual([1, expected.length]);
            expect(Array.from(options.input_ids.data, BigInt)).toEqual(expected);
            expect(options.attention_mask.dims).toEqual([1, expected.length]);
            expect(Array.from(options.attention_mask.data, BigInt)).toEqual(expected.map(() => 1n));
            expect(options.max_new_tokens).toBe(128);
          },
        };
      }),
    });
    expect([...caches.keys()]).toEqual([10, 12]);
  }, 30_000);
});
