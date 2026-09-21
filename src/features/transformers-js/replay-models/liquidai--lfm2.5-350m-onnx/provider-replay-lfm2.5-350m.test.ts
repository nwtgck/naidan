// @vitest-environment node
import { providerReplayCatalog } from './provider-evidence-catalog';
import { contentToolProviderReplayCatalog } from './provider-content-tool-evidence-catalog';
import { assembleProviderSequenceEvidence } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';
import { createProviderRequestReplay } from '@/features/transformers-js/replay-models/support/provider-replay-request';
import { verifyCapturedFullReplay } from '@/features/transformers-js/replay-models/support/provider-replay-test-captured-full';
import { exactObject } from '@/utils/exact-object';
import { createChatMessageSnapshot } from '@/01-models/chat-message';
import { zodToJsonSchema } from '@/utils/lm-tools';
import { createHash } from 'node:crypto';
import { runProviderReplayTurn, createReplayImageAttachment, closeProviderReplayCaptures } from '@/features/transformers-js/replay-models/support/provider-replay-chat';
import { captureProviderChat, type ProviderChatCapture } from '@/features/transformers-js/replay-models/support/capture-provider-chat';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import inputJson from './provider-template-inputs.evidence.json';
import toolInputJson from './provider-template-tool-inputs.evidence.json';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import evidenceJson from './provider-prefix-output.evidence.json';
import continuityJson from './provider-supplied-history-prefix.evidence.json';
import { parseProviderReplayTextEvidence, replayRecordedText } from '@/features/transformers-js/replay-models/support/provider-replay-test-causal-gate';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';

const evidence = parseProviderReplayTextEvidence({ value: evidenceJson });
const inputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('4c4091ad7401dcf764c8aac2d8a122412d0fd97f01b1b1bc1820dc45eb8b4d91'),
  modelId: z.literal('LiquidAI/LFM2.5-350M-ONNX'), revision: z.literal('d11593fd9eb408e322667926656598896c2d5ff9'),
  cases: z.array(z.object({
    caseId: z.enum(['system-user-generation', 'multi-turn-generation']),
    messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()),
    addGenerationPrompt: z.literal(true),
    selectedTemplateSha256: z.literal('013eed60546434b6967e3483153d8c5c37abcb1d667f8b1f914683f2a9411531'),
    renderedText: z.string(), inputTokenIds: z.array(z.number().int().nonnegative()).min(1),
  }).strict()).length(2),
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
const nativeToolsSchema = z.tuple([z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.literal('lookup_weather'), description: z.literal('Return deterministic weather fixture data.'),
    parameters: z.object({
      type: z.literal('object'), properties: z.object({ city: z.object({ type: z.literal('string') }).strict() }).strict(),
      required: z.tuple([z.literal('city')]),
    }).strict(),
  }).strict(),
}).strict()]);

const nativeToolCaseSchema = z.object({
  tools: nativeToolsSchema, addGenerationPrompt: z.literal(true), status: z.literal('passed'),
  selectedTemplateSha256: z.literal('013eed60546434b6967e3483153d8c5c37abcb1d667f8b1f914683f2a9411531'),
  renderedText: z.string(), inputTokenIds: z.array(z.number().int().nonnegative().safe()).min(1),
}).strict();
const toolInputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('4c4091ad7401dcf764c8aac2d8a122412d0fd97f01b1b1bc1820dc45eb8b4d91'),
  modelId: z.literal('LiquidAI/LFM2.5-350M-ONNX'), revision: z.literal('d11593fd9eb408e322667926656598896c2d5ff9'),
  cases: z.tuple([
    nativeToolCaseSchema.extend({ caseId: z.literal('tools-generation'), messages: z.tuple([toolUserSchema]) }),
    nativeToolCaseSchema.extend({ caseId: z.literal('tool-result-continuation'), messages: z.tuple([toolUserSchema, toolAssistantSchema, toolResultSchema]) }),
  ]),
}).strict().parse(toolInputJson);
const observedToolMessagesSchema = z.array(z.object({
  role: z.enum(['user', 'assistant', 'tool']), content: z.string(),
  tool_calls: toolAssistantSchema.shape.tool_calls.optional(), tool_call_id: z.string().optional(),
}).strict());

const continuity = parseProviderReplayTextEvidence({ value: continuityJson });

describe('LFM2.5 350M Provider / basic', () => {
  it('preserves the recorded first user input without supplying any output tokens', async () => {
    const captures: ProviderChatCapture[] = [];
    const source = evidence;
    expect(source.identity.resolvedRevision).toBe('d11593fd9eb408e322667926656598896c2d5ff9');
    expect(source.scenario.messages).toEqual([{ role: 'user', content: 'Template probe user message.' }]);
    expect(source.scenario.tools).toEqual([]);
    const stop = 'lfm2.5-350m first Production input verified; no output tokens supplied';
    const nativeInputs: Array<{
      input: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      mask: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      past: unknown; version: string; tokenizerInstance: boolean; templateSha: string; optionKeys: string[];
      config: { maxNewTokens: unknown; temperature: unknown; topP: unknown; doSample: unknown };
      returnDict: unknown; streamerInstance: boolean; stoppingType: string;
    }> = [];
    const harness = await createProviderReplayTestRuntime({
      modelId: 'LiquidAI/LFM2.5-350M-ONNX',
      expectedRevision: source.identity.resolvedRevision,
      cacheRevision: source.identity.resolvedRevision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      // Identifiable synthetic bodies replace native weight execution only.
      artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: 'LiquidAI/LFM2.5-350M-ONNX', revision: source.identity.resolvedRevision, path }),
      })),
      generate: async ({ options, tokenizer, runtime }) => {
        nativeInputs.push({
          input: options.input_ids instanceof runtime.Tensor ? { type: options.input_ids.type, location: options.input_ids.location, dims: [...options.input_ids.dims], data: structuredClone(options.input_ids.data) } : undefined,
          mask: options.attention_mask instanceof runtime.Tensor ? { type: options.attention_mask.type, location: options.attention_mask.location, dims: [...options.attention_mask.dims], data: structuredClone(options.attention_mask.data) } : undefined,
          past: options.past_key_values, version: runtime.env.version, tokenizerInstance: tokenizer instanceof runtime.PreTrainedTokenizer,
          templateSha: createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'), optionKeys: Object.keys(options).sort(),
          config: { maxNewTokens: options.max_new_tokens, temperature: options.temperature, topP: options.top_p, doSample: options.do_sample },
          returnDict: options.return_dict_in_generate, streamerInstance: options.streamer instanceof runtime.TextStreamer, stoppingType: typeof options.stopping_criteria,
        });
        // Never call replayRecordedText, streamer.put/end or return sequences.
        // This positive input test remains independent of callback delivery.
        throw new Error(stop);
      },
    });
    try {
      const capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/LiquidAI/LFM2.5-350M-ONNX",
          messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
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
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined,
        },
      });
      captures.push(capture);
      await capture.completion;
      expect(capture.snapshot().result).toMatchObject({ type: 'error', error: { message: stop } });
      expect(capture.snapshot().parts).toEqual([]);
      expect(nativeInputs).toHaveLength(1);
      const observed = nativeInputs[0]!;
      expect(observed.version).toBe(source.identity.transformersJsVersion);
      expect(observed.tokenizerInstance).toBe(true);
      expect(observed.templateSha).toBe('013eed60546434b6967e3483153d8c5c37abcb1d667f8b1f914683f2a9411531');
      expect(observed.optionKeys).toEqual([
        'attention_mask', 'do_sample', 'input_ids', 'max_new_tokens', 'past_key_values',
        'return_dict_in_generate', 'stopping_criteria', 'streamer', 'temperature', 'top_p',
      ].sort());
      const tensors = { input_ids: observed.input, attention_mask: observed.mask };
      for (const fact of source.inputContract.inputTensorFacts) {
        const tensor = tensors[fact.name];
        expect({ name: fact.name, dtype: tensor?.type, dims: tensor?.dims, location: tensor?.location }).toEqual(fact);
        expect(tensor?.data).toBeInstanceOf(BigInt64Array);
      }
      const actualIds = Array.from(z.instanceof(BigInt64Array).parse(observed.input?.data), Number);
      expect(observed.input?.dims).toEqual([1, 14]);
      expect(actualIds).toEqual(source.inputContract.inputTokenIds);
      expect(actualIds).toEqual(source.modelReplay.sourceInputTokenIds);
      expect(createHash('sha256').update(JSON.stringify(actualIds)).digest('hex')).toBe(source.modelReplay.sourceInputSha256);
      expect(observed.mask?.data).toEqual(BigInt64Array.from(source.modelReplay.sourceInputTokenIds.map(() => 1n)));
      // Only the four recorded settings are claimed, not every merged default.
      expect(observed.config).toEqual(source.inputContract.effectiveGenerationConfig);
      expect(observed.past).toBeNull();
      expect(observed.returnDict).toBe(true);
      expect(observed.streamerInstance).toBe(true);
      expect(observed.stoppingType).toBe('function');
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.ortCalls).toHaveLength(1);
      expect(harness.observations.processors).toHaveLength(0);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => harness.close() });
    }
  }, 30_000);
  it('delivers the recorded first-turn stream exactly before Provider settlement', async () => {
    const captures: ProviderChatCapture[] = [];
    expect(evidence.identity).toEqual({
      "modelId": "hf.co/LiquidAI/LFM2.5-350M-ONNX",
      "resolvedRevision": "d11593fd9eb408e322667926656598896c2d5ff9",
      "investigationRunId": "bd78df41-cb6e-4384-9af3-7c69cce1012d",
      "transformersJsVersion": "4.2.0"
    });
    let releasedTokenCount = 0;
    const harness = await createProviderReplayTestRuntime({
      imagePlatform: undefined,
      modelId: 'LiquidAI/LFM2.5-350M-ONNX',
      expectedRevision: evidence.identity.resolvedRevision,
      cacheRevision: evidence.identity.resolvedRevision,
      metadataCache: "all-fixture",
      // Only native model bodies/inference are substituted. Repository paths,
      // original tokenizer/config, offline loading and Production streaming are real.
      artifacts: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"].map(path => ({ path, bytes: Uint8Array.of(1) })),
      generate: async ({ options, tokenizer, runtime }) => {
        expect(tokenizer.decode(evidence.modelReplay.generatedTokenIds, { skip_special_tokens: false }))
          .toBe(evidence.modelReplay.generatedText);
        const replay = replayRecordedText({ evidence, options });
        releasedTokenCount += replay.releasedTokenCount;
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
    });
    try {
      const capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/LiquidAI/LFM2.5-350M-ONNX",
          messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
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
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined,
        },
      });
      captures.push(capture);
      await capture.completion;
      const observed = capture.snapshot();
      // These segment expectations are selected original Production first-turn
      // observations, not manufactured decoding steps or a completed answer.
      expect(releasedTokenCount).toBe(16);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => item.operation.startsWith('writer') || item.operation.startsWith('create') || item.operation === 'remove')).toEqual([]);
      expect(observed.parts).toEqual([expect.objectContaining({
        type: 'text', partId: expect.any(String), index: 0, completeness: 'partial',
      })]);
      // Native framing may split a chunk differently; the entire ordered text
      // must still equal the immutable recorded callback stream.
      expect(observed.parts.filter(part => part.type === 'text').flatMap(part => part.chunks).join('')).toBe(
        ["Sure! ","Here’s ","an ","example ","of ","a ","**template** ","for ","a ","**user"].join(''),
      );
      expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => harness.close() });
    }
  }, 30_000);
  it('basic: delivers the recorded first-turn callbacks before settlement', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual(["Sure! Here’s an example of a **template** for a **user"]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => replay.close() });
    }
  }, 30_000);
});

describe('LFM2.5 350M Provider / system', () => {
  it('system: preserves instructions and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["system-user"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"],
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'system', parts: [{ id: 'text_0', type: 'text', text: "Template probe system instruction.", completeness: 'complete' }] }, { id: toMessageId({ raw: 'message_1' }), role: 'user', parts: [{ id: 'text_1', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual(["The"]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => replay.close() });
    }
  }, 30_000);
});

describe('LFM2.5 350M Provider / history', () => {
  it("system-user-generation preserves the recorded native input through Provider.chat", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases.find((item): boolean => item.caseId === "system-user-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'LFM2.5 350M input verified; no generation replay';
    const nativeInputs: Array<{
      input: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      mask: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      past: unknown;
    }> = [];
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId,
      expectedRevision: inputEvidence.revision,
      cacheRevision: inputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      // Only the native session body is synthetic; metadata and model loading
      // retain this model's own exact-revision repository and external-data paths.
      artifacts: [
        'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async ({ options, runtime }) => {
        nativeInputs.push({
          input: options.input_ids instanceof runtime.Tensor ? { type: options.input_ids.type, location: options.input_ids.location, dims: [...options.input_ids.dims], data: structuredClone(options.input_ids.data) } : undefined,
          mask: options.attention_mask instanceof runtime.Tensor ? { type: options.attention_mask.type, location: options.attention_mask.location, dims: [...options.attention_mask.dims], data: structuredClone(options.attention_mask.data) } : undefined,
          past: options.past_key_values,
        });
        // Supplied synthetic history does not imply that a previous Provider
        // generation completed. Never release tokens from a different prompt.
        throw new Error(boundary);
      },
    });
    try {
      // Verify the captured native control before exercising the public warm
      // Provider. Loading and this metadata lookup remain strictly offline.
      await harness.service.loadDownloadedModel({ modelId: inputEvidence.modelId });
      const tokenizer = await harness.runtime.AutoTokenizer.from_pretrained(inputEvidence.modelId, {
        revision: inputEvidence.revision, local_files_only: true,
      });
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(scenario.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: true })).toBe(scenario.renderedText);
      const native = tokenizer.apply_chat_template(scenario.messages, { add_generation_prompt: true, return_dict: true });
      expect(native.input_ids).toBeInstanceOf(harness.runtime.Tensor);
      expect(Array.from(native.input_ids.data, Number)).toEqual(scenario.inputTokenIds);

      const capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'system', parts: [{ id: 'text_0', type: 'text', text: "Template probe system instruction.", completeness: 'complete' }] }, { id: toMessageId({ raw: 'message_1' }), role: 'user', parts: [{ id: 'text_1', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
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
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined,
        },
      });
      captures.push(capture);
      await capture.completion;
      expect(capture.snapshot().result).toMatchObject({ type: 'error', error: { message: boundary } });
      const chunks = capture.snapshot().parts.filter(part => part.type === 'text').flatMap(part => part.chunks);
      expect(nativeInputs).toHaveLength(1);
      const observedInput = nativeInputs[0]!;
      expect(observedInput.input?.type).toBe('int64');
      expect(observedInput.input?.location).toBe('cpu');
      expect(observedInput.input?.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(observedInput.input?.data).toEqual(BigInt64Array.from(scenario.inputTokenIds, BigInt));
      expect(observedInput.mask?.type).toBe('int64');
      expect(observedInput.mask?.location).toBe('cpu');
      expect(observedInput.mask?.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(observedInput.mask?.data).toEqual(new BigInt64Array(scenario.inputTokenIds.length).fill(1n));
      expect(observedInput.past).toBeNull();
      expect(chunks).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => harness.close() });
    }
  }, 30_000);
  it("multi-turn-generation preserves the recorded native input through Provider.chat", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases.find((item): boolean => item.caseId === "multi-turn-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'LFM2.5 350M input verified; no generation replay';
    const nativeInputs: Array<{
      input: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      mask: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      past: unknown;
    }> = [];
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId,
      expectedRevision: inputEvidence.revision,
      cacheRevision: inputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      // Only the native session body is synthetic; metadata and model loading
      // retain this model's own exact-revision repository and external-data paths.
      artifacts: [
        'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async ({ options, runtime }) => {
        nativeInputs.push({
          input: options.input_ids instanceof runtime.Tensor ? { type: options.input_ids.type, location: options.input_ids.location, dims: [...options.input_ids.dims], data: structuredClone(options.input_ids.data) } : undefined,
          mask: options.attention_mask instanceof runtime.Tensor ? { type: options.attention_mask.type, location: options.attention_mask.location, dims: [...options.attention_mask.dims], data: structuredClone(options.attention_mask.data) } : undefined,
          past: options.past_key_values,
        });
        // Supplied synthetic history does not imply that a previous Provider
        // generation completed. Never release tokens from a different prompt.
        throw new Error(boundary);
      },
    });
    try {
      // Verify the captured native control before exercising the public warm
      // Provider. Loading and this metadata lookup remain strictly offline.
      await harness.service.loadDownloadedModel({ modelId: inputEvidence.modelId });
      const tokenizer = await harness.runtime.AutoTokenizer.from_pretrained(inputEvidence.modelId, {
        revision: inputEvidence.revision, local_files_only: true,
      });
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(scenario.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: true })).toBe(scenario.renderedText);
      const native = tokenizer.apply_chat_template(scenario.messages, { add_generation_prompt: true, return_dict: true });
      expect(native.input_ids).toBeInstanceOf(harness.runtime.Tensor);
      expect(Array.from(native.input_ids.data, Number)).toEqual(scenario.inputTokenIds);

      const capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe first user message.", completeness: 'complete' }] }, { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ id: 'text_1', type: 'text', text: "Template probe assistant response.", completeness: 'complete' }] }, { id: toMessageId({ raw: 'message_2' }), role: 'user', parts: [{ id: 'text_2', type: 'text', text: "Template probe second user message.", completeness: 'complete' }] }],
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
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined,
        },
      });
      captures.push(capture);
      await capture.completion;
      expect(capture.snapshot().result).toMatchObject({ type: 'error', error: { message: boundary } });
      const chunks = capture.snapshot().parts.filter(part => part.type === 'text').flatMap(part => part.chunks);
      expect(nativeInputs).toHaveLength(1);
      const observedInput = nativeInputs[0]!;
      expect(observedInput.input?.type).toBe('int64');
      expect(observedInput.input?.location).toBe('cpu');
      expect(observedInput.input?.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(observedInput.input?.data).toEqual(BigInt64Array.from(scenario.inputTokenIds, BigInt));
      expect(observedInput.mask?.type).toBe('int64');
      expect(observedInput.mask?.location).toBe('cpu');
      expect(observedInput.mask?.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(observedInput.mask?.data).toEqual(new BigInt64Array(scenario.inputTokenIds.length).fill(1n));
      expect(observedInput.past).toBeNull();
      expect(chunks).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => harness.close() });
    }
  }, 30_000);
  it('preserves the captured follow-up prefix with explicitly supplied assistant history', async () => {
    const captures: ProviderChatCapture[] = [];
    expect(continuity.identity).toEqual(evidence.identity);
    expect(continuity.scenario.messages).toEqual([
      { role: 'user', content: 'Template probe user message.' },
      { role: 'assistant', content: evidence.expectedProviderSemantic.visibleContent },
      { role: 'user', content: 'Continue with one short sentence.' },
    ]);
    let releasedTokenCount = 0;
    const harness = await createProviderReplayTestRuntime({
      imagePlatform: undefined,
      modelId: 'LiquidAI/LFM2.5-350M-ONNX',
      expectedRevision: continuity.identity.resolvedRevision,
      cacheRevision: continuity.identity.resolvedRevision,
      metadataCache: "all-fixture",
      artifacts: [
        { path: 'onnx/model_q4f16.onnx', bytes: Uint8Array.of(1) },
        { path: 'onnx/model_q4f16.onnx_data', bytes: Uint8Array.of(2) },
      ],
      generate: async ({ options, tokenizer, runtime }) => {
        expect(tokenizer.decode(continuity.modelReplay.generatedTokenIds, { skip_special_tokens: false }))
          .toBe(continuity.modelReplay.generatedText);
        const replay = replayRecordedText({ evidence: continuity, options });
        releasedTokenCount += replay.releasedTokenCount;
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
    });
    try {
      const capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/LiquidAI/LFM2.5-350M-ONNX",
          messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }, { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ id: 'text_1', type: 'text', text: "Sure! Here’s an example of a **template** for a **user", completeness: 'complete' }] }, { id: toMessageId({ raw: 'message_2' }), role: 'user', parts: [{ id: 'text_2', type: 'text', text: "Continue with one short sentence.", completeness: 'complete' }] }],
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
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined,
        },
      });
      captures.push(capture);
      await capture.completion;
      const chunks = capture.snapshot().parts.filter(part => part.type === 'text').flatMap(part => part.chunks);
      const settledChunks = [...chunks];
      expect(releasedTokenCount).toBe(16);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Preserve the original recorded text across the native framing change.
      // This supplied history does not assert KV reuse or a completed first answer.
      expect(settledChunks.join('')).toBe([
        'Sure! ', 'Here’s ', 'a ', `\
continuation:

`, '"Thank ', 'you ', 'for ', 'your ', 'feedback."',
      ].join(''));
      expect(capture.snapshot().result).toEqual({ type: 'interrupted', reason: 'unknown' });
      expect(capture.snapshot().parts.map(part => part.type === 'text' ? part.completeness : part.type)).toEqual(['partial']);
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => harness.close() });
    }
  }, 30_000);
  it('history: preserves supplied history and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["supplied-history"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"],
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe first user message.", completeness: 'complete' }] }, { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ id: 'text_1', type: 'text', text: "Template probe assistant response.", completeness: 'complete' }] }, { id: toMessageId({ raw: 'message_2' }), role: 'user', parts: [{ id: 'text_2', type: 'text', text: "Template probe second user message.", completeness: 'complete' }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual(["Template"]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => replay.close() });
    }
  }, 30_000);
});

describe('LFM2.5 350M Provider / independent', () => {
  it('keeps an independent next input free of prior text in the same null-KV loaded runtime', async () => {
    const captures: ProviderChatCapture[] = [];
    const nextMessages: ChatMessage[] = [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: 'A separate synthetic conversation.', completeness: 'complete' }] }];
    const nextPrompt = `\
<|startoftext|><|im_start|>user
A separate synthetic conversation.<|im_end|>
<|im_start|>assistant
`;
    const stop = 'Independent LFM350 next input verified; no second output supplied';
    const contexts: Parameters<ProviderReplayGenerate>[0][] = [];
    let firstReleased = 0;
    const nativeInputs: Array<{
      input: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      mask: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      past: unknown; templateSha: string; rendered: unknown; expectedIds: number[];
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
          input: options.input_ids instanceof runtime.Tensor ? { type: options.input_ids.type, location: options.input_ids.location, dims: [...options.input_ids.dims], data: structuredClone(options.input_ids.data) } : undefined,
          mask: options.attention_mask instanceof runtime.Tensor ? { type: options.attention_mask.type, location: options.attention_mask.location, dims: [...options.attention_mask.dims], data: structuredClone(options.attention_mask.data) } : undefined,
          past: options.past_key_values, templateSha: createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'),
          rendered: tokenizer.apply_chat_template([{ role: 'user', content: 'A separate synthetic conversation.' }], { tokenize: false, add_generation_prompt: true }),
          expectedIds: tokenizer.encode(nextPrompt, { add_special_tokens: false }),
        });
        // No captured response exists for this changed input. This tests input
        // isolation with null KV, not native KV invalidation or generation.
        throw new Error(stop);
      },
    ];
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId,
      expectedRevision: inputEvidence.revision,
      cacheRevision: inputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async context => {
        const next = invocations.shift();
        if (!next) throw new Error('Unexpected extra inference in independent-input replay');
        return next(context);
      },
    });
    try {
      const firstCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/LiquidAI/LFM2.5-350M-ONNX",
          messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
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
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined,
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;

      const ortCountAfterFirst = harness.observations.ortCalls.length;

      const secondCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/LiquidAI/LFM2.5-350M-ONNX",
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
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined,
        },
      });
      captures.push(secondCapture);
      await secondCapture.completion;
      expect(secondCapture.snapshot().result).toMatchObject({ type: 'error', error: { message: stop } });

      expect(nativeInputs).toHaveLength(1);
      const observed = nativeInputs[0]!;
      expect(observed.templateSha).toBe('013eed60546434b6967e3483153d8c5c37abcb1d667f8b1f914683f2a9411531');
      expect(observed.rendered).toBe(nextPrompt);
      expect(observed.input?.type).toBe('int64');
      expect(observed.input?.location).toBe('cpu');
      expect(observed.input?.dims).toEqual([1, observed.expectedIds.length]);
      expect(observed.input?.data).toEqual(BigInt64Array.from(observed.expectedIds, BigInt));
      expect(observed.mask?.type).toBe('int64');
      expect(observed.mask?.location).toBe('cpu');
      expect(observed.mask?.dims).toEqual([1, observed.expectedIds.length]);
      expect(observed.mask?.data).toEqual(new BigInt64Array(observed.expectedIds.length).fill(1n));
      expect(observed.past).toBeNull();
      expect(firstReleased).toBe(16);
      expect(secondCapture.snapshot().parts.filter(part => part.type === 'text').flatMap(part => part.chunks)).toEqual([]);
      expect(contexts).toHaveLength(2);
      expect(contexts[1]!.model).toBe(contexts[0]!.model);
      expect(contexts[1]!.tokenizer).toBe(contexts[0]!.tokenizer);
      expect(contexts.map(context => context.options.past_key_values)).toEqual([null, null]);
      expect(invocations).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(ortCountAfterFirst).toBe(1);
      expect(harness.observations.ortCalls).toHaveLength(ortCountAfterFirst);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => harness.close() });
    }
  }, 30_000);
  it('independent: keeps a new conversation independent after settled requests in the same runtime', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn","continuity","independent-next-input"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
    let firstAssistant: Extract<ChatMessage, { role: 'assistant' }> | undefined;
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual(["Sure! Here’s an example of a **template** for a **user"]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);

        const { partId, type, chunks, completeness, index: _index, ...unhandled } = textParts[0]!;
        unhandled satisfies Record<PropertyKey, never>;
        if (completeness === 'pending') throw new Error('Expected a drained first text part');
        firstAssistant = exactObject<Extract<ChatMessage, { role: 'assistant' }>>()({
          id: toMessageId({ raw: 'message_1' }), role: 'assistant',
          parts: [{ id: partId, type, text: chunks.join(''), completeness }],
        });
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }, firstAssistant!, { id: toMessageId({ raw: 'message_2' }), role: 'user', parts: [{ id: 'text_2', type: 'text', text: "Continue the synthetic conversation with a short response.", completeness: 'complete' }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual([`\
Sure! Here’s a continuation of the synthetic conversation:

---

User`]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "A separate synthetic capture conversation.", completeness: 'complete' }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual(["S"]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);
      }
      replay.assertComplete({ requests: 3, nativeCalls: 3 });
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => replay.close() });
    }
  }, 30_000);
});

describe('LFM2.5 350M Provider / reasoning', () => {
  it('reasoning: preserves the recorded none-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-none"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"],
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual(["S"]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => replay.close() });
    }
  }, 30_000);
  it('reasoning: preserves the recorded low-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-low"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"],
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual(["S"]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => replay.close() });
    }
  }, 30_000);
  it('reasoning: preserves the recorded medium-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-medium"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"],
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual(["S"]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => replay.close() });
    }
  }, 30_000);
  it('reasoning: preserves the recorded high-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-high"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"],
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual(["S"]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => replay.close() });
    }
  }, 30_000);
});

describe('LFM2.5 350M Provider / tools', () => {
  it("tools-generation retains public tool definitions and result content, but the native template omits call details", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = toolInputEvidence.cases.find((item): boolean => item.caseId === "tools-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'LFM350 tool input captured; no inference output supplied';
    let inference: Pick<Parameters<ProviderReplayGenerate>[0], 'tokenizer' | 'runtime'> | undefined;
    const nativeInputs: Array<{
      input: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      mask: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      past: unknown;
    }> = [];
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }));
    const publicTool: Tool = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    };
    const strictToolDefinitions = [{ type: 'function', function: {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false
      },
    } }];
    const harness = await createProviderReplayTestRuntime({
      modelId: toolInputEvidence.modelId,
      expectedRevision: toolInputEvidence.revision,
      cacheRevision: toolInputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, path }),
      })),
      generate: async context => {
        const { options, tokenizer, runtime } = context;
        inference = { tokenizer, runtime };
        nativeInputs.push({
          input: options.input_ids instanceof runtime.Tensor ? { type: options.input_ids.type, location: options.input_ids.location, dims: [...options.input_ids.dims], data: structuredClone(options.input_ids.data) } : undefined,
          mask: options.attention_mask instanceof runtime.Tensor ? { type: options.attention_mask.type, location: options.attention_mask.location, dims: [...options.attention_mask.dims], data: structuredClone(options.attention_mask.data) } : undefined,
          past: options.past_key_values,
        });
        // This native matrix supplies input, not an inference result. No
        // streamer tokens, return sequences or fabricated KV are released.
        throw new Error(boundary);
      },
    });
    const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
    try {
      const capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: toolInputEvidence.modelId,
          messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Use the weather tool for Tokyo.", completeness: 'complete' }] }],
          tools: [{ name: publicTool.name, description: publicTool.description, parameters: z.record(z.string(), z.json()).parse(zodToJsonSchema({ schema: publicTool.parametersSchema })) }],
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
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined,
        },
      });
      captures.push(capture);
      await capture.completion;
      expect(capture.snapshot().result).toMatchObject({ type: 'error', error: { message: boundary } });
      const chunks = capture.snapshot().parts.filter(part => part.type === 'text').flatMap(part => part.chunks);
      expect(chunks).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      // Observe Production before any oracle calls. The spy preserves the
      // inherited method and receiver; explicit tokenize:false calls are the
      // existing protocol/reasoning probes, not the actual input tokenization.
      const productionTokenizations = templateSpy.mock.calls.filter(([, options]) => options?.tokenize !== false);
      expect(productionTokenizations).toHaveLength(1);
      const productionCall = productionTokenizations[0];
      if (!productionCall) throw new Error('Expected Production template invocation');
      // Validate raw arguments first, then compare semantic values. An absent
      // optional field and an own undefined field are not different tool input.
      const observedMessages = observedToolMessagesSchema.parse(productionCall[0]).map(message => {
        const { role, content, tool_calls, tool_call_id, ...unhandled } = message;
        unhandled satisfies Record<PropertyKey, never>;
        return { role, content, tool_calls, tool_call_id };
      });
      expect(observedMessages).toStrictEqual(scenario.messages.map(message => ({
        role: message.role, content: message.content,
        tool_calls: 'tool_calls' in message ? message.tool_calls : undefined,
        tool_call_id: 'tool_call_id' in message ? message.tool_call_id : undefined,
      })));
      expect(productionCall[1]).toStrictEqual({ add_generation_prompt: true, return_dict: true, tools: strictToolDefinitions });
      if (!inference) throw new Error('Actual inference boundary was not reached');
      const { tokenizer, runtime } = inference;
      expect(nativeInputs).toHaveLength(1);
      const observedInput = nativeInputs[0]!;
      expect(createHash('sha256').update(tokenizer.get_chat_template({ tools: scenario.tools })).digest('hex')).toBe(scenario.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: scenario.tools,
      })).toBe(scenario.renderedText);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: true, return_dict: false, return_tensor: false, add_generation_prompt: true, tools: scenario.tools,
      })).toEqual(scenario.inputTokenIds);

      // Unlike Smol, this template serializes the schema. The reviewed public
      // additionalProperties:false changes the input legitimately; original
      // open-schema output would not be causally reusable for this prompt.
      expect(scenario.renderedText.split('"required": ["city"]')).toHaveLength(2);
      const strictPrompt = scenario.renderedText.replace('"required": ["city"]', '"required": ["city"], "additionalProperties": false');
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: strictToolDefinitions,
      })).toBe(strictPrompt);
      const nativeStrict = tokenizer(strictPrompt, { add_special_tokens: false });
      expect(nativeStrict.input_ids).toBeInstanceOf(runtime.Tensor);
      const strictIds = Array.from(nativeStrict.input_ids.data, Number);
      expect(strictIds).not.toEqual(scenario.inputTokenIds);
      expect(observedInput.input?.type).toBe('int64');
      expect(observedInput.input?.location).toBe('cpu');
      expect(observedInput.input?.dims).toEqual([1, strictIds.length]);
      expect(Array.from(z.instanceof(BigInt64Array).parse(observedInput.input?.data), Number)).toEqual(strictIds);
      expect(observedInput.mask?.type).toBe('int64');
      expect(observedInput.mask?.location).toBe('cpu');
      expect(observedInput.mask?.dims).toEqual([1, strictIds.length]);
      expect(Array.from(z.instanceof(BigInt64Array).parse(observedInput.mask?.data), BigInt)).toEqual(strictIds.map(() => 1n));
      expect(observedInput.past).toBeNull();

      // Native limitation: tool definitions affect input, but tool-call fields
      // and association IDs do not. Only the role/content survive rendering.
      const roleAndContent = scenario.messages.map(message => ({ role: message.role, content: message.content }));
      expect(tokenizer.apply_chat_template(roleAndContent, {
        tokenize: false, add_generation_prompt: true, tools: strictToolDefinitions,
      })).toBe(strictPrompt);
      const changed = roleAndContent.map(message => ({ ...message }));
      const last = changed.at(-1);
      if (!last) throw new Error('Expected a final fixture message');
      const originalContent = last.content;
      expect(originalContent).not.toBe('');
      expect(strictPrompt.split(originalContent)).toHaveLength(2);
      last.content = 'Changed synthetic final message.';
      expect(tokenizer.apply_chat_template(changed, {
        tokenize: false, add_generation_prompt: true, tools: strictToolDefinitions,
      })).toBe(strictPrompt.replace(originalContent, last.content));
      expect(harness.observations.ortCalls.map(([core, ortOptions]) => inspectSyntheticOrtSession({
        modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision,
        repositoryPaths: new Set(['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data']), core, options: ortOptions,
      }))).toEqual([{
        modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, corePath: 'onnx/model_q4f16.onnx',
        externalData: [{ path: 'model_q4f16.onnx_data', artifactPath: 'onnx/model_q4f16.onnx_data' }], executionProviders: ['webgpu'],
      }]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      templateSpy.mockRestore();
      await closeProviderReplayCaptures({ captures, close: () => harness.close() });
    }
  }, 30_000);
  it("tool-result-continuation preserves the call through verified content while retaining the original native-template input facts", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = toolInputEvidence.cases.find((item): boolean => item.caseId === "tool-result-continuation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'LFM350 tool input captured; no inference output supplied';
    let inference: Pick<Parameters<ProviderReplayGenerate>[0], 'tokenizer' | 'runtime'> | undefined;
    const nativeInputs: Array<{
      input: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      mask: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      past: unknown;
    }> = [];
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }));
    const publicTool: Tool = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    };
    const strictToolDefinitions = [{ type: 'function', function: {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
        additionalProperties: false
      },
    } }];
    const publicMessages: ChatMessage[] = [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Use the weather tool for Tokyo.", completeness: 'complete' }] }, { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ id: 'call_1_0', type: 'tool_call', toolCall: { id: toToolCallId({ raw: "call_template_probe_1" }), type: 'function', function: { name: "lookup_weather", arguments: "{\"city\":\"Tokyo\"}" } } }] }, { id: toMessageId({ raw: 'message_2' }), role: 'tool', parts: [{ id: 'result_2', type: 'tool_result', result: { toolCallId: toToolCallId({ raw: "call_template_probe_1" }), status: 'success', content: { type: 'text', text: "{\"temperatureC\":20,\"condition\":\"clear\"}" } } }] }];
    const harness = await createProviderReplayTestRuntime({
      modelId: toolInputEvidence.modelId,
      expectedRevision: toolInputEvidence.revision,
      cacheRevision: toolInputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, path }),
      })),
      generate: async context => {
        const { options, tokenizer, runtime } = context;
        inference = { tokenizer, runtime };
        nativeInputs.push({
          input: options.input_ids instanceof runtime.Tensor ? { type: options.input_ids.type, location: options.input_ids.location, dims: [...options.input_ids.dims], data: structuredClone(options.input_ids.data) } : undefined,
          mask: options.attention_mask instanceof runtime.Tensor ? { type: options.attention_mask.type, location: options.attention_mask.location, dims: [...options.attention_mask.dims], data: structuredClone(options.attention_mask.data) } : undefined,
          past: options.past_key_values,
        });
        // This native matrix supplies input, not an inference result. No
        // streamer tokens, return sequences or fabricated KV are released.
        throw new Error(boundary);
      },
    });
    const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
    try {
      const capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: toolInputEvidence.modelId,
          messages: publicMessages,
          tools: [{ name: publicTool.name, description: publicTool.description, parameters: z.record(z.string(), z.json()).parse(zodToJsonSchema({ schema: publicTool.parametersSchema })) }],
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
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined,
        },
      });
      captures.push(capture);
      await capture.completion;
      expect(capture.snapshot().result).toMatchObject({ type: 'error', error: { message: boundary } });
      const chunks = capture.snapshot().parts.filter(part => part.type === 'text').flatMap(part => part.chunks);
      expect(chunks).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      // Observe Production before any oracle calls. The spy preserves the
      // inherited method and receiver; explicit tokenize:false calls are the
      // existing protocol/reasoning probes, not the actual input tokenization.
      const productionTokenizations = templateSpy.mock.calls.filter(([, options]) => options?.tokenize !== false);
      expect(productionTokenizations).toHaveLength(1);
      const productionCall = productionTokenizations[0];
      if (!productionCall) throw new Error('Expected Production template invocation');
      // Validate raw arguments first, then compare semantic values. An absent
      // optional field and an own undefined field are not different tool input.
      const observedMessages = observedToolMessagesSchema.parse(productionCall[0]).map(message => {
        const { role, content, tool_calls, tool_call_id, ...unhandled } = message;
        unhandled satisfies Record<PropertyKey, never>;
        return { role, content, tool_calls, tool_call_id };
      });
      expect(observedMessages).toStrictEqual([
        { role: 'user', content: 'Use the weather tool for Tokyo.', tool_calls: undefined, tool_call_id: undefined },
        { role: 'assistant', content: '<|tool_call_start|>[lookup_weather(city="Tokyo")]<|tool_call_end|>', tool_calls: undefined, tool_call_id: undefined },
        { role: 'tool', content: '{"temperatureC":20,"condition":"clear"}', tool_calls: undefined, tool_call_id: 'call_template_probe_1' },
      ]);
      expect(productionCall[1]).toStrictEqual({ add_generation_prompt: true, return_dict: true, tools: strictToolDefinitions });
      if (!inference) throw new Error('Actual inference boundary was not reached');
      const { tokenizer, runtime } = inference;
      expect(nativeInputs).toHaveLength(1);
      const observedInput = nativeInputs[0]!;
      expect(createHash('sha256').update(tokenizer.get_chat_template({ tools: scenario.tools })).digest('hex')).toBe(scenario.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: scenario.tools,
      })).toBe(scenario.renderedText);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: true, return_dict: false, return_tensor: false, add_generation_prompt: true, tools: scenario.tools,
      })).toEqual(scenario.inputTokenIds);

      // Unlike Smol, this template serializes the schema. The reviewed public
      // additionalProperties:false changes the input legitimately; original
      // open-schema output would not be causally reusable for this prompt.
      expect(scenario.renderedText.split('"required": ["city"]')).toHaveLength(2);
      const strictPrompt = scenario.renderedText.replace('"required": ["city"]', '"required": ["city"], "additionalProperties": false');
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: strictToolDefinitions,
      })).toBe(strictPrompt);
      const nativeStrict = tokenizer(strictPrompt, { add_special_tokens: false });
      expect(nativeStrict.input_ids).toBeInstanceOf(runtime.Tensor);
      const strictIds = Array.from(nativeStrict.input_ids.data, Number);
      expect(strictIds).not.toEqual(scenario.inputTokenIds);
      // Source-derived corrected input, not a new inference recording. The
      // unchanged original template rendered an empty assistant turn; the
      // reviewed content route inserts this literal call frame exactly once.
      const emptyAssistant = `\
<|im_start|>assistant
<|im_end|>`;
      expect(strictPrompt.split(emptyAssistant)).toHaveLength(2);
      const productionPrompt = strictPrompt.replace(emptyAssistant, `\
<|im_start|>assistant
<|tool_call_start|>[lookup_weather(city="Tokyo")]<|tool_call_end|><|im_end|>`);
      const productionIds = Array.from(tokenizer(productionPrompt, { add_special_tokens: false }).input_ids.data, Number);
      expect(productionIds).not.toEqual(strictIds);
      expect(observedInput.input?.type).toBe('int64');
      expect(observedInput.input?.location).toBe('cpu');
      expect(observedInput.input?.dims).toEqual([1, productionIds.length]);
      expect(Array.from(z.instanceof(BigInt64Array).parse(observedInput.input?.data), Number)).toEqual(productionIds);
      expect(observedInput.mask?.type).toBe('int64');
      expect(observedInput.mask?.location).toBe('cpu');
      expect(observedInput.mask?.dims).toEqual([1, productionIds.length]);
      expect(Array.from(z.instanceof(BigInt64Array).parse(observedInput.mask?.data), BigInt)).toEqual(productionIds.map(() => 1n));
      expect(observedInput.past).toBeNull();

      // Native limitation: tool definitions affect input, but tool-call fields
      // and association IDs do not. Only the role/content survive rendering.
      const roleAndContent = scenario.messages.map(message => ({ role: message.role, content: message.content }));
      expect(tokenizer.apply_chat_template(roleAndContent, {
        tokenize: false, add_generation_prompt: true, tools: strictToolDefinitions,
      })).toBe(strictPrompt);
      const changed = roleAndContent.map(message => ({ ...message }));
      const last = changed.at(-1);
      if (!last) throw new Error('Expected a final fixture message');
      const originalContent = last.content;
      expect(originalContent).not.toBe('');
      expect(strictPrompt.split(originalContent)).toHaveLength(2);
      last.content = 'Changed synthetic final message.';
      expect(tokenizer.apply_chat_template(changed, {
        tokenize: false, add_generation_prompt: true, tools: strictToolDefinitions,
      })).toBe(strictPrompt.replace(originalContent, last.content));
      expect(harness.observations.ortCalls.map(([core, ortOptions]) => inspectSyntheticOrtSession({
        modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision,
        repositoryPaths: new Set(['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data']), core, options: ortOptions,
      }))).toEqual([{
        modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, corePath: 'onnx/model_q4f16.onnx',
        externalData: [{ path: 'model_q4f16.onnx_data', artifactPath: 'onnx/model_q4f16.onnx_data' }], executionProviders: ['webgpu'],
      }]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      templateSpy.mockRestore();
      await closeProviderReplayCaptures({ captures, close: () => harness.close() });
    }
  }, 30_000);
  it('recognizes historical native tool delimiters and stops before its unrecorded continuation output', async () => {
    // This earlier source lacks the second invocation. Keep its refusal gate;
    // the content-tool recording below independently covers a complete reply.
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ['natural-tool-minimal'],
      artifactPaths: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'],
      imagePlatform: undefined,
    });
    let turn: Awaited<ReturnType<typeof runProviderReplayTurn>> | undefined;
    let settled: typeof turn;
    const updates: (readonly ChatMessage[])[] = [];
    const executions: { args: unknown; prefix: readonly ChatMessage[] | undefined }[] = [];
    const templates = vi.spyOn(replay.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
    try {
      const parameters = {
        temperature: 0, topP: 1, maxCompletionTokens: 128,
        presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined,
        reasoning: { effort: undefined },
      };
      const messages: ChatMessage[] = [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [
        { id: 'text_0', type: 'text', text: 'Use the weather tool for Tokyo.', completeness: 'complete' },
      ] }];
      const originalMessages = structuredClone(messages);
      replay.beginNativeRequest({ caseId: 'natural-tool-minimal', parameters });
      turn = await runProviderReplayTurn({
        provider: replay.provider,
        onChange: ({ messages }) => {
          updates.push(messages);
        },
        abortController: new AbortController(),
        tools: [{
          name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
          parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args }) => {
            executions.push({ args: structuredClone(args), prefix: updates.at(-1) });
            return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
          },
        }],
        request: {
          model: 'LiquidAI/LFM2.5-350M-ONNX', messages, parameters,
          readBinaryObject: undefined, debug: undefined,
        },
      });
      // The first call/result are real; the inventory refuses to fabricate a second native output.
      expect(turn.outcome).toMatchObject({ status: 'rejected', error: { message: 'Unrecorded extra native invocation: natural-tool-minimal/2' } });
      expect(messages).toEqual(originalMessages);
      expect(turn.generated.map(node => node.role)).toEqual(['assistant', 'tool', 'assistant']);
      const calls = turn.generated.filter(node => node.role === 'assistant').flatMap(node => node.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall));
      const results = turn.generated.filter(node => node.role === 'tool').flatMap(node => node.parts.map(part => part.result));
      expect(calls).toEqual([{ id: expect.any(String), type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' } }]);
      expect(results).toEqual([{ toolCallId: calls[0]!.id, status: 'success', content: { type: 'text', text: '{"temperatureC":20,"condition":"clear"}' } }]);
      expect(executions.map(execution => execution.args)).toEqual([{ city: 'Tokyo' }]);
      const toolNode = turn.generated[1];
      if (toolNode?.role !== 'tool') throw new Error('Expected the caller-owned tool node');
      expect(executions[0]?.prefix).toEqual([
        createChatMessageSnapshot({ node: turn.generated[0]! }),
        { id: toolNode.id, role: 'tool', parts: [{ id: toolNode.parts[0]!.id, type: 'tool_result', result: { toolCallId: calls[0]!.id, status: 'executing' } }] },
      ]);
      expect(executions[0]?.prefix?.[0]?.parts.at(-1)?.type).toBe('tool_call');
      expect(turn.generated.filter(node => node.role === 'assistant').flatMap(node => node.parts.filter(part => part.type === 'text'))).toEqual([]);
      expect(turn.toolEvents).toEqual([]);
      expect(replay.observations.inferenceCalls).toHaveLength(2);
      // The new continuation has no recorded output, but it must actually keep
      // the executed call and result in the native template input.
      expect(templates.mock.calls.at(-1)?.[0]).toEqual([
        { role: 'user', content: 'Use the weather tool for Tokyo.', tool_call_id: undefined },
        { role: 'assistant', content: '<|tool_call_start|>[lookup_weather(city="Tokyo")]<|tool_call_end|>' },
        { role: 'tool', content: '{"temperatureC":20,"condition":"clear"}', tool_call_id: calls[0]?.id },
      ]);
      const continuation = z.object({ input_ids: z.instanceof(replay.runtime.Tensor), past_key_values: z.null(), max_new_tokens: z.literal(128) }).parse(replay.observations.inferenceCalls[1]);
      const continuationIds = Array.from(continuation.input_ids.data, Number);
      expect(continuationIds.filter(id => id === 10)).toHaveLength(1);
      expect(continuationIds.filter(id => id === 11)).toHaveLength(1);
      expect(continuationIds.indexOf(10)).toBeLessThan(continuationIds.indexOf(11));
      expect.soft(replay.observations.forbiddenTransport).toEqual([]);
      expect.soft(replay.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      settled = structuredClone(turn);
    } finally {
      templates.mockRestore();
      await replay.close();
    }
    expect(structuredClone(turn), 'through awaited Worker disposal').toEqual(settled);
  }, 30_000);
  it('tools: executes the recorded minimal Tokyo call once and continues with its result', async () => {
    const replay = await createProviderRequestReplay({
      catalog: contentToolProviderReplayCatalog, caseIds: ["natural-tool-minimal"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"], imagePlatform: undefined,
    });
    let turn: Awaited<ReturnType<typeof runProviderReplayTurn>> | undefined;
    let settled: typeof turn;
    const updates: (readonly ChatMessage[])[] = [];
    const executions: { args: unknown; signal: AbortSignal | undefined; prefix: readonly ChatMessage[] | undefined }[] = [];
    let turnSettled = false;
    try {
      const parameters = {
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
      const abortController = new AbortController();
      const tools: Tool[] = [{
        name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
        parametersSchema: z.object({ city: z.string() }),
        execute: async ({ args, signal }) => {
          expect(turnSettled).toBe(false);
          executions.push({ args: structuredClone(args), signal, prefix: updates.at(-1) });
          return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
        },
      }];
      const messages: ChatMessage[] = [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Use the weather tool for Tokyo.", completeness: 'complete' }] }];
      const originalMessages = structuredClone(messages);
      replay.beginNativeRequest({ caseId: "natural-tool-minimal", parameters });
      turn = await runProviderReplayTurn({
        provider: replay.provider,
        tools,
        abortController,
        onChange: ({ messages }) => {
          updates.push(messages);
        },
        request: {
          model: 'LiquidAI/LFM2.5-350M-ONNX', messages, parameters,
          readBinaryObject: undefined, debug: undefined,
        },
      });
      turnSettled = true;
      replay.endNativeRequest();
      expect(messages).toEqual(originalMessages);
      expect(turn.outcome).toEqual({ status: 'fulfilled', result: { type: 'finished', next: 'user' } });
      expect(turn.generated.map(node => node.role)).toEqual(['assistant', 'tool', 'assistant']);
      const assistants = turn.generated.filter(node => node.role === 'assistant');
      expect(assistants.map(node => node.parts.filter(part => part.type === 'text').map(part => part.text).join(''))).toEqual(["", "The current weather in Tokyo is clear with a temperature of 20°C."]);
      expect(assistants.flatMap(node => node.parts.filter(part => part.type === 'text').map(part => part.completeness))).toEqual(['complete']);
      const calls = assistants.flatMap(node => node.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall));
      const results = turn.generated.filter(node => node.role === 'tool').flatMap(node => node.parts.map(part => part.result));
      expect(turn.toolEvents).toEqual([]);
      expect(calls).toEqual([{ id: expect.any(String), type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' } }]);
      expect(calls[0]!.id).not.toBe('');
      expect(results).toEqual([{ toolCallId: calls[0]!.id, status: 'success', content: { type: 'text', text: '{"temperatureC":20,"condition":"clear"}' } }]);
      expect(executions.map(execution => execution.args)).toEqual([{ city: 'Tokyo' }]);
      const execution = executions[0]!;
      expect(execution.signal).toBeInstanceOf(AbortSignal);
      expect(execution.signal).not.toBe(abortController.signal);
      expect(execution.signal?.aborted).toBe(false);
      // The caller records an executing result after the completed call and before the follow-up.
      const toolNode = turn.generated[1];
      if (toolNode?.role !== 'tool') throw new Error('Expected the caller-owned tool node');
      expect(execution.prefix).toEqual([
        createChatMessageSnapshot({ node: turn.generated[0]! }),
        { id: toolNode.id, role: 'tool', parts: [{ id: toolNode.parts[0]!.id, type: 'tool_result', result: { toolCallId: calls[0]!.id, status: 'executing' } }] },
      ]);
      expect(execution.prefix?.[0]?.parts.at(-1)?.type).toBe('tool_call');
      replay.assertComplete({ requests: 1, nativeCalls: 2 });
      settled = structuredClone(turn);
    } finally {
      await replay.close();
    }
    expect(structuredClone(turn), 'through awaited Worker disposal').toEqual(settled);
  }, 30_000);
  it('tools: executes the recorded representative Tokyo call once and continues with its result', async () => {
    const replay = await createProviderRequestReplay({
      catalog: contentToolProviderReplayCatalog, caseIds: ["natural-tool-representative"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"], imagePlatform: undefined,
    });
    let turn: Awaited<ReturnType<typeof runProviderReplayTurn>> | undefined;
    let settled: typeof turn;
    const updates: (readonly ChatMessage[])[] = [];
    const executions: { args: unknown; signal: AbortSignal | undefined; prefix: readonly ChatMessage[] | undefined }[] = [];
    let turnSettled = false;
    try {
      const parameters = {
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
      const abortController = new AbortController();
      const tools: Tool[] = [{
        name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
        parametersSchema: z.object({ city: z.string() }),
        execute: async ({ args, signal }) => {
          expect(turnSettled).toBe(false);
          executions.push({ args: structuredClone(args), signal, prefix: updates.at(-1) });
          return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
        },
      }];
      const messages: ChatMessage[] = [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Use lookup_weather for Tokyo, then give a short answer based on the tool result.", completeness: 'complete' }] }];
      const originalMessages = structuredClone(messages);
      replay.beginNativeRequest({ caseId: "natural-tool-representative", parameters });
      turn = await runProviderReplayTurn({
        provider: replay.provider,
        tools,
        abortController,
        onChange: ({ messages }) => {
          updates.push(messages);
        },
        request: {
          model: 'LiquidAI/LFM2.5-350M-ONNX', messages, parameters,
          readBinaryObject: undefined, debug: undefined,
        },
      });
      turnSettled = true;
      replay.endNativeRequest();
      expect(messages).toEqual(originalMessages);
      expect(turn.outcome).toEqual({ status: 'fulfilled', result: { type: 'finished', next: 'user' } });
      expect(turn.generated.map(node => node.role)).toEqual(['assistant', 'tool', 'assistant']);
      const assistants = turn.generated.filter(node => node.role === 'assistant');
      expect(assistants.map(node => node.parts.filter(part => part.type === 'text').map(part => part.text).join(''))).toEqual(["", "The weather in Tokyo is clear with a temperature of 20°C."]);
      expect(assistants.flatMap(node => node.parts.filter(part => part.type === 'text').map(part => part.completeness))).toEqual(['complete']);
      const calls = assistants.flatMap(node => node.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall));
      const results = turn.generated.filter(node => node.role === 'tool').flatMap(node => node.parts.map(part => part.result));
      expect(turn.toolEvents).toEqual([]);
      expect(calls).toEqual([{ id: expect.any(String), type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' } }]);
      expect(calls[0]!.id).not.toBe('');
      expect(results).toEqual([{ toolCallId: calls[0]!.id, status: 'success', content: { type: 'text', text: '{"temperatureC":20,"condition":"clear"}' } }]);
      expect(executions.map(execution => execution.args)).toEqual([{ city: 'Tokyo' }]);
      const execution = executions[0]!;
      expect(execution.signal).toBeInstanceOf(AbortSignal);
      expect(execution.signal).not.toBe(abortController.signal);
      expect(execution.signal?.aborted).toBe(false);
      // The caller records an executing result after the completed call and before the follow-up.
      const toolNode = turn.generated[1];
      if (toolNode?.role !== 'tool') throw new Error('Expected the caller-owned tool node');
      expect(execution.prefix).toEqual([
        createChatMessageSnapshot({ node: turn.generated[0]! }),
        { id: toolNode.id, role: 'tool', parts: [{ id: toolNode.parts[0]!.id, type: 'tool_result', result: { toolCallId: calls[0]!.id, status: 'executing' } }] },
      ]);
      expect(execution.prefix?.[0]?.parts.at(-1)?.type).toBe('tool_call');
      replay.assertComplete({ requests: 1, nativeCalls: 2 });
      settled = structuredClone(turn);
    } finally {
      await replay.close();
    }
    expect(structuredClone(turn), 'through awaited Worker disposal').toEqual(settled);
  }, 30_000);
  it('tools: preserves structured caller history and the recorded response', async () => {
    const replay = await createProviderRequestReplay({
      catalog: contentToolProviderReplayCatalog, caseIds: ["structured-tool-history"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"], imagePlatform: undefined,
    });
    let turn: Awaited<ReturnType<typeof runProviderReplayTurn>> | undefined;
    let settled: typeof turn;
    const updates: (readonly ChatMessage[])[] = [];
    const executions: { args: unknown; signal: AbortSignal | undefined; prefix: readonly ChatMessage[] | undefined }[] = [];
    let turnSettled = false;
    try {
      const parameters = {
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
      const abortController = new AbortController();
      const tools: Tool[] = [{
        name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
        parametersSchema: z.object({ city: z.string() }),
        execute: async ({ args, signal }) => {
          expect(turnSettled).toBe(false);
          executions.push({ args: structuredClone(args), signal, prefix: updates.at(-1) });
          return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
        },
      }];
      const messages: ChatMessage[] = [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Use the weather tool for Tokyo.", completeness: 'complete' }] }, { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ id: 'call_1_0', type: 'tool_call', toolCall: { id: toToolCallId({ raw: "call_model_support_probe_1" }), type: 'function', function: { name: "lookup_weather", arguments: "{\"city\":\"Tokyo\"}" } } }] }, { id: toMessageId({ raw: 'message_2' }), role: 'tool', parts: [{ id: 'result_2', type: 'tool_result', result: { toolCallId: toToolCallId({ raw: "call_model_support_probe_1" }), status: 'success', content: { type: 'text', text: "{\"temperatureC\":20,\"condition\":\"clear\"}" } } }] }];
      const originalMessages = structuredClone(messages);
      replay.beginNativeRequest({ caseId: "structured-tool-history", parameters });
      turn = await runProviderReplayTurn({
        provider: replay.provider,
        tools,
        abortController,
        onChange: ({ messages }) => {
          updates.push(messages);
        },
        request: {
          model: 'LiquidAI/LFM2.5-350M-ONNX', messages, parameters,
          readBinaryObject: undefined, debug: undefined,
        },
      });
      turnSettled = true;
      replay.endNativeRequest();
      expect(messages).toEqual(originalMessages);
      expect(turn.outcome).toEqual({ status: 'fulfilled', result: { type: 'finished', next: 'user' } });
      expect(turn.generated.map(node => node.role)).toEqual(['assistant']);
      const assistants = turn.generated.filter(node => node.role === 'assistant');
      expect(assistants.map(node => node.parts.filter(part => part.type === 'text').map(part => part.text).join(''))).toEqual(["The current weather in Tokyo is clear with a temperature of 20°C."]);
      expect(assistants.flatMap(node => node.parts.filter(part => part.type === 'text').map(part => part.completeness))).toEqual(['complete']);
      const calls = assistants.flatMap(node => node.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall));
      const results = turn.generated.filter(node => node.role === 'tool').flatMap(node => node.parts.map(part => part.result));
      expect(turn.toolEvents).toEqual([]);
      expect(calls).toEqual([]);
      expect(results).toEqual([]);
      expect(executions).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
      settled = structuredClone(turn);
    } finally {
      await replay.close();
    }
    expect(structuredClone(turn), 'through awaited Worker disposal').toEqual(settled);
  }, 30_000);
});

describe('LFM2.5 350M Provider / images', () => {
  it('images: preserves the recorded text-only native handling of an image-bearing request', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["image"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"],
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0_0', type: 'text', text: "Describe the single synthetic image in one short phrase.", completeness: 'complete' }, { id: 'attachment_0_1', type: 'attachment', attachment: createReplayImageAttachment({ dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }) }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual(["It"]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => replay.close() });
    }
  }, 30_000);
});

describe('LFM2.5 350M Provider / sequences', () => {
  it('uses only the settled first callback text for a second request in the same loaded runtime', async () => {
    const captures: ProviderChatCapture[] = [];
    expect(continuity.identity).toEqual(evidence.identity);
    expect(continuity.scenario.messages).toEqual([
      ...evidence.scenario.messages,
      { role: 'assistant', content: evidence.expectedProviderSemantic.visibleContent },
      { role: 'user', content: 'Continue with one short sentence.' },
    ]);
    const contexts: Parameters<ProviderReplayGenerate>[0][] = [];
    const released: number[] = [];
    const invocations: ProviderReplayGenerate[] = [
      async context => {
        const { options, tokenizer, runtime } = context;
        contexts.push(context);
        expect(tokenizer.decode(evidence.modelReplay.generatedTokenIds, { skip_special_tokens: false })).toBe(evidence.modelReplay.generatedText);
        const replay = replayRecordedText({ evidence, options });
        released.push(replay.releasedTokenCount);
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
      async context => {
        const { options, tokenizer, runtime } = context;
        contexts.push(context);
        expect(tokenizer.decode(continuity.modelReplay.generatedTokenIds, { skip_special_tokens: false })).toBe(continuity.modelReplay.generatedText);
        // A missing first callback changes the real second input. The gate must
        // reject it BEFORE releasing any captured follow-up tokens. Never fill
        // the assistant message from the fixture to make this invocation pass.
        const replay = replayRecordedText({ evidence: continuity, options });
        released.push(replay.releasedTokenCount);
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
    ];
    const harness = await createProviderReplayTestRuntime({
      modelId: 'LiquidAI/LFM2.5-350M-ONNX',
      expectedRevision: evidence.identity.resolvedRevision,
      cacheRevision: evidence.identity.resolvedRevision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async context => {
        const next = invocations.shift();
        if (!next) throw new Error('Unexpected extra inference in two-turn replay');
        return next(context);
      },
    });
    try {
      const firstCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/LiquidAI/LFM2.5-350M-ONNX",
          messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
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
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined,
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;

      // Immutable at settlement: late first callbacks cannot rewrite the next
      // request. There is no timer, callback drain, or artificial callback ACK.
      const firstPart = firstCapture.snapshot().parts[0];
      if (firstPart?.type !== 'text' || firstPart.completeness === 'pending') throw new Error('Expected a drained first text part');
      const { partId, type, chunks, completeness, index: _index, ...unhandled } = firstPart;
      unhandled satisfies Record<PropertyKey, never>;
      const firstTextAtSettlement = chunks.join('');
      const secondMessages: ChatMessage[] = [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: 'Template probe user message.', completeness: 'complete' }] }, { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ id: partId, type, text: firstTextAtSettlement, completeness }] }, { id: toMessageId({ raw: 'message_2' }), role: 'user', parts: [{ id: 'text_2', type: 'text', text: 'Continue with one short sentence.', completeness: 'complete' }] }];
      const ortCountAfterFirst = harness.observations.ortCalls.length;

      let secondOutcome: { status: 'fulfilled' } | { status: 'rejected', error: unknown };
      const secondCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/LiquidAI/LFM2.5-350M-ONNX",
          messages: secondMessages,
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
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined,
        },
      });
      captures.push(secondCapture);
      try {
        await secondCapture.completion;

        secondOutcome = { status: 'fulfilled' };
      } catch (error) {
        secondOutcome = { status: 'rejected', error };
      }
      // Snapshot the observed completion, without a timer or callback drain.
      // The real Worker delivery tail acknowledges callbacks before settlement.
      const secondTextAtSettlement = secondCapture.snapshot().parts.filter(part => part.type === 'text').flatMap(part => part.chunks).join('');
      expect(contexts).toHaveLength(2);
      expect(contexts[1]!.model).toBe(contexts[0]!.model);
      expect(contexts[1]!.tokenizer).toBe(contexts[0]!.tokenizer);
      expect(contexts.map(context => context.options.past_key_values)).toEqual([null, null]);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(invocations).toEqual([]);
      expect(ortCountAfterFirst).toBe(1);
      expect(harness.observations.ortCalls).toHaveLength(ortCountAfterFirst);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Report the real rejection as well as both immutable callback snapshots.
      // This is a downstream consequence of the synchronous-native/Comlink
      // settlement counterexample, not a second independent generation defect.
      expect({ firstTextAtSettlement, secondOutcome, secondTextAtSettlement, released }).toEqual({
        firstTextAtSettlement: evidence.expectedProviderSemantic.visibleContent,
        secondOutcome: { status: 'fulfilled' },
        secondTextAtSettlement: continuity.expectedProviderSemantic.visibleContent,
        released: [16, 16],
      });
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => harness.close() });
    }
  }, 30_000);
  it('sequences: builds continuation from actually delivered first-request settlement', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn","continuity"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
    let firstAssistant: Extract<ChatMessage, { role: 'assistant' }> | undefined;
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual(["Sure! Here’s an example of a **template** for a **user"]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);

        const { partId, type, chunks, completeness, index: _index, ...unhandled } = textParts[0]!;
        unhandled satisfies Record<PropertyKey, never>;
        if (completeness === 'pending') throw new Error('Expected a drained first text part');
        firstAssistant = exactObject<Extract<ChatMessage, { role: 'assistant' }>>()({
          id: toMessageId({ raw: 'message_1' }), role: 'assistant',
          parts: [{ id: partId, type, text: chunks.join(''), completeness }],
        });
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
            model: "LiquidAI/LFM2.5-350M-ONNX",
            messages: [{ id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ id: 'text_0', type: 'text', text: "Template probe user message.", completeness: 'complete' }] }, firstAssistant!, { id: toMessageId({ raw: 'message_2' }), role: 'user', parts: [{ id: 'text_2', type: 'text', text: "Continue the synthetic conversation with a short response.", completeness: 'complete' }] }],
            parameters,
            tools: [],
            signal,
            readBinaryObject: undefined,
            debug: undefined,
          },
        });
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const textParts = observed.parts.filter(part => part.type === 'text');
        expect(observed.parts.map(part => part.type)).toEqual(['text']);
        expect(textParts.map(part => ({ partId: part.partId, index: part.index }))).toEqual([{ partId: expect.any(String), index: 0 }]);
        const calls = observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall);
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(textParts.map(part => part.completeness)).toEqual(['partial']);
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);

        expect(textParts.map(part => part.chunks.join(''))).toEqual([`\
Sure! Here’s a continuation of the synthetic conversation:

---

User`]);
        expect(order).toEqual(["part", "part-complete", "result", "settled"]);

        expect(calls).toEqual([]);
      }
      replay.assertComplete({ requests: 2, nativeCalls: 2 });
    } finally {
      await closeProviderReplayCaptures({ captures, close: () => replay.close() });
    }
  }, 30_000);
  it('preserves thirteen causal requests, native streams and settlements in one Load', async () => {
    // This entire sequence belongs to the post-repair recording. Earlier
    // source cases remain pinned in providerReplayCatalog, never mixed here.
    const fullEvidenceJson = assembleProviderSequenceEvidence({ catalog: contentToolProviderReplayCatalog });
    expect(fullEvidenceJson.modelId).toBe('LiquidAI/LFM2.5-350M-ONNX');
    expect(fullEvidenceJson.metadataRevision).toBe('d11593fd9eb408e322667926656598896c2d5ff9');
    expect(fullEvidenceJson.observedCacheRevision).toBe('main');
    expect(fullEvidenceJson.requests).toHaveLength(13);
    expect(fullEvidenceJson.invocations).toHaveLength(15);
    await verifyCapturedFullReplay({ reviewedPublicContract: undefined, unavailableOutputs: [], completeResult: undefined, expectedLoadReceipt: undefined, evidence: fullEvidenceJson, imagePlatform: undefined, artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data"] });
  }, 30_000);
});
