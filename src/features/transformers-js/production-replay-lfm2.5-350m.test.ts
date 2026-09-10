// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';
import inputJson from './production-replay-lfm2.5-350m.input.evidence.json';
import toolInputJson from './production-replay-lfm2.5-350m.tool-input.evidence.json';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from './download-verification/fixtures/raw-download-replay/synthetic-session-oracle';
import evidenceJson from './production-replay-lfm2.5-350m.evidence.json';
import continuityJson from './production-replay-lfm2.5-350m.continuity.evidence.json';
import { parseProductionReplayTextEvidence, replayRecordedText } from './production-replay-test-causal-gate';
import { createProductionReplayTestRuntime, type ProductionReplayGenerate } from './production-replay-test-runtime';

const evidence = parseProductionReplayTextEvidence({ value: evidenceJson });
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

const continuity = parseProductionReplayTextEvidence({ value: continuityJson });

describe('LFM2.5 350M captured Production Provider replay', () => {
  it('preserves the recorded first user input without supplying any output tokens', async () => {
    const source = evidence;
    expect(source.identity.resolvedRevision).toBe('d11593fd9eb408e322667926656598896c2d5ff9');
    expect(source.scenario.messages).toEqual([{ role: 'user', content: 'Template probe user message.' }]);
    expect(source.scenario.tools).toEqual([]);
    const stop = 'lfm2.5-350m first Production input verified; no output tokens supplied';
    let verifiedInputs = 0;
    const harness = await createProductionReplayTestRuntime({
      modelId: 'LiquidAI/LFM2.5-350M-ONNX', expectedRevision: source.identity.resolvedRevision, imagePlatform: undefined,
      // Identifiable synthetic bodies replace native weight execution only.
      artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: 'LiquidAI/LFM2.5-350M-ONNX', revision: source.identity.resolvedRevision, path }),
      })),
      generate: async ({ options, tokenizer, runtime }) => {
        expect(runtime.env.version).toBe(source.identity.transformersJsVersion);
        expect(tokenizer).toBeInstanceOf(runtime.PreTrainedTokenizer);
        expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'))
          .toBe('013eed60546434b6967e3483153d8c5c37abcb1d667f8b1f914683f2a9411531');
        expect(Object.keys(options).sort()).toEqual([
          'attention_mask', 'do_sample', 'input_ids', 'max_new_tokens', 'past_key_values',
          'return_dict_in_generate', 'stopping_criteria', 'streamer', 'temperature', 'top_p',
        ].sort());
        if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) {
          throw new Error('Expected actual first-input Tensor instances');
        }
        const tensors = { input_ids: options.input_ids, attention_mask: options.attention_mask };
        for (const fact of source.inputContract.inputTensorFacts) {
          const tensor = tensors[fact.name];
          expect({ name: fact.name, dtype: tensor.type, dims: tensor.dims, location: tensor.location }).toEqual(fact);
          expect(tensor.data).toBeInstanceOf(BigInt64Array);
        }
        const actualIds = Array.from(options.input_ids.data, Number);
        expect(options.input_ids.dims).toEqual([1, 14]);
        expect(actualIds).toEqual(source.inputContract.inputTokenIds);
        expect(actualIds).toEqual(source.modelReplay.sourceInputTokenIds);
        expect(createHash('sha256').update(JSON.stringify(actualIds)).digest('hex')).toBe(source.modelReplay.sourceInputSha256);
        expect(Array.from(options.attention_mask.data, BigInt)).toEqual(source.modelReplay.sourceInputTokenIds.map(() => 1n));
        // The source records these four requested settings, not every merged
        // GenerationConfig default or native GPU state.
        expect({
          maxNewTokens: options.max_new_tokens, temperature: options.temperature,
          topP: options.top_p, doSample: options.do_sample,
        }).toEqual(source.inputContract.effectiveGenerationConfig);
        expect(options.past_key_values).toBeNull();
        expect(options.return_dict_in_generate).toBe(true);
        expect(options.streamer).toBeInstanceOf(runtime.TextStreamer);
        expect(typeof options.stopping_criteria).toBe('function');
        ++verifiedInputs;
        // Never call replayRecordedText, streamer.put/end or return sequences.
        // This positive input test remains independent of callback delivery.
        throw new Error(stop);
      },
    });
    try {
      const chunks: string[] = [];
      const onToolCall = vi.fn();
      const onToolEvent = vi.fn();
      const onToolResult = vi.fn();
      await expect(harness.provider.chat({
        model: source.identity.modelId, messages: source.scenario.messages, tools: [],
        parameters: {
          ...source.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined,
          stop: undefined, reasoning: { effort: undefined },
        },
        onChunk: ({ chunk }) => chunks.push(chunk), onToolCall, onToolEvent, onToolResult,
      })).rejects.toThrow(stop);
      expect(verifiedInputs).toBe(1);
      expect(chunks).toEqual([]);
      expect(onToolCall).not.toHaveBeenCalled();
      expect(onToolEvent).not.toHaveBeenCalled();
      expect(onToolResult).not.toHaveBeenCalled();
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.ortCalls).toHaveLength(1);
      expect(harness.observations.processors).toHaveLength(0);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});

describe('LFM2.5 350M real Production system and history input', () => {
  it.each(inputEvidence.cases)('$caseId preserves the recorded native input through Provider.chat', async scenario => {
    const boundary = 'LFM2.5 350M input verified; no generation replay';
    let verifiedInputs = 0;
    const harness = await createProductionReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, imagePlatform: undefined,
      // Only the native session body is synthetic; metadata and model loading
      // retain this model's own exact-revision repository and external-data paths.
      artifacts: [
        'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async ({ options, runtime }) => {
        if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) {
          throw new Error('Expected actual LFM2.5 350M input tensors');
        }
        expect(options.input_ids.type).toBe('int64');
        expect(options.input_ids.location).toBe('cpu');
        expect(options.input_ids.dims).toEqual([1, scenario.inputTokenIds.length]);
        expect(Array.from(options.input_ids.data, Number)).toEqual(scenario.inputTokenIds);
        expect(options.attention_mask.type).toBe('int64');
        expect(options.attention_mask.location).toBe('cpu');
        expect(options.attention_mask.dims).toEqual([1, scenario.inputTokenIds.length]);
        expect(options.attention_mask.data).toEqual(new BigInt64Array(scenario.inputTokenIds.length).fill(1n));
        expect(options.past_key_values).toBeNull();
        ++verifiedInputs;
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
      const chunks: string[] = [];
      await expect(harness.provider.chat({
        model: inputEvidence.modelId, messages: scenario.messages, tools: [],
        parameters: {
          temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined,
          frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined },
        },
        onChunk: ({ chunk }) => chunks.push(chunk),
      })).rejects.toThrow(boundary);
      expect(verifiedInputs).toBe(1);
      expect(chunks).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});

describe('LFM2.5 350M captured Production Provider replay', () => {
  it('delivers the recorded first-turn stream exactly before Provider settlement', async () => {
    expect(evidence.identity).toEqual({
      "modelId": "hf.co/LiquidAI/LFM2.5-350M-ONNX",
      "resolvedRevision": "d11593fd9eb408e322667926656598896c2d5ff9",
      "investigationRunId": "bd78df41-cb6e-4384-9af3-7c69cce1012d",
      "transformersJsVersion": "4.2.0"
    });
    let releasedTokenCount = 0;
    const harness = await createProductionReplayTestRuntime({
      imagePlatform: undefined,
      modelId: 'LiquidAI/LFM2.5-350M-ONNX', expectedRevision: evidence.identity.resolvedRevision,
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
      let assistantStarts = 0;
      const chunks: string[] = [];
      const toolCalls: unknown[] = [];
      const toolEvents: unknown[] = [];
      const toolResults: unknown[] = [];
      await harness.provider.chat({
        model: evidence.identity.modelId, messages: evidence.scenario.messages, tools: [],
        parameters: {
          ...evidence.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined,
          stop: undefined, reasoning: { effort: undefined },
        },
        onAssistantMessageStart: () => {
          assistantStarts += 1;
        },
        onChunk: ({ chunk }) => {
          chunks.push(chunk);
        },
        onToolCall: event => {
          toolCalls.push(event);
        },
        onToolEvent: event => {
          toolEvents.push(event);
        },
        onToolResult: event => {
          toolResults.push(event);
        },
      });
      // These segment expectations are selected original Production first-turn
      // observations, not manufactured decoding steps or a completed answer.
      const settled = { assistantStarts, chunks: [...chunks], toolCalls: [...toolCalls], toolEvents: [...toolEvents], toolResults: [...toolResults] };
      expect(releasedTokenCount).toBe(16);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => item.operation.startsWith('writer') || item.operation.startsWith('create') || item.operation === 'remove')).toEqual([]);
      expect(settled).toEqual({
        assistantStarts: 1,
        chunks: ["Sure! ","Here’s ","an ","example ","of ","a ","**template** ","for ","a ","**user"],
        toolCalls: [], toolEvents: [], toolResults: [],
      });
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('preserves the captured follow-up prefix with explicitly supplied assistant history', async () => {
    expect(continuity.identity).toEqual(evidence.identity);
    expect(continuity.scenario.messages).toEqual([
      { role: 'user', content: 'Template probe user message.' },
      { role: 'assistant', content: evidence.expectedProviderSemantic.visibleContent },
      { role: 'user', content: 'Continue with one short sentence.' },
    ]);
    let releasedTokenCount = 0;
    const harness = await createProductionReplayTestRuntime({
      imagePlatform: undefined,
      modelId: 'LiquidAI/LFM2.5-350M-ONNX', expectedRevision: continuity.identity.resolvedRevision,
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
      const chunks: string[] = [];
      await harness.provider.chat({
        model: continuity.identity.modelId, messages: continuity.scenario.messages, tools: [],
        parameters: {
          ...continuity.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined,
          stop: undefined, reasoning: { effort: undefined },
        },
        onChunk: ({ chunk }) => chunks.push(chunk),
      });
      const settledChunks = [...chunks];
      expect(releasedTokenCount).toBe(16);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Original segmentation, not a delayed callback drain. The supplied
      // history does not assert native KV reuse or prior callback completion.
      expect(settledChunks).toEqual([
        'Sure! ', 'Here’s ', 'a ', `\
continuation:

`, '"Thank ', 'you ', 'for ', 'your ', 'feedback."',
      ]);
    } finally {
      await harness.close();
    }
  }, 30_000);

  it('uses only the settled first callback text for a second request in the same loaded runtime', async () => {
    expect(continuity.identity).toEqual(evidence.identity);
    expect(continuity.scenario.messages).toEqual([
      ...evidence.scenario.messages,
      { role: 'assistant', content: evidence.expectedProviderSemantic.visibleContent },
      { role: 'user', content: 'Continue with one short sentence.' },
    ]);
    const contexts: Parameters<ProductionReplayGenerate>[0][] = [];
    const released: number[] = [];
    const invocations: ProductionReplayGenerate[] = [
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
    const harness = await createProductionReplayTestRuntime({
      modelId: 'LiquidAI/LFM2.5-350M-ONNX', expectedRevision: evidence.identity.resolvedRevision, imagePlatform: undefined,
      artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async context => {
        const next = invocations.shift();
        if (!next) throw new Error('Unexpected extra inference in two-turn replay');
        return next(context);
      },
    });
    try {
      const firstChunks: string[] = [];
      await harness.provider.chat({
        model: evidence.identity.modelId, messages: evidence.scenario.messages, tools: [],
        parameters: { ...evidence.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => firstChunks.push(chunk),
      });
      // Immutable at settlement: late first callbacks cannot rewrite the next
      // request. There is no timer, callback drain, or artificial callback ACK.
      const firstTextAtSettlement = firstChunks.join('');
      const secondMessages: ChatMessage[] = [
        ...evidence.scenario.messages,
        { role: 'assistant', content: firstTextAtSettlement },
        { role: 'user', content: 'Continue with one short sentence.' },
      ];
      const ortCountAfterFirst = harness.observations.ortCalls.length;
      const secondChunks: string[] = [];
      let secondOutcome: { status: 'fulfilled' } | { status: 'rejected', error: unknown };
      try {
        await harness.provider.chat({
          model: evidence.identity.modelId, messages: secondMessages, tools: [],
          parameters: { ...continuity.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
          onChunk: ({ chunk }) => secondChunks.push(chunk),
        });
        secondOutcome = { status: 'fulfilled' };
      } catch (error) {
        secondOutcome = { status: 'rejected', error };
      }
      // Direct await, as for turn one; wrapping the promise in another .then
      // would give late callbacks an extra reaction before this snapshot.
      const secondTextAtSettlement = secondChunks.join('');
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
      await harness.close();
    }
  }, 30_000);

  it('keeps an independent next input free of prior text in the same null-KV loaded runtime', async () => {
    const nextMessages: ChatMessage[] = [{ role: 'user', content: 'A separate synthetic conversation.' }];
    const nextPrompt = `\
<|startoftext|><|im_start|>user
A separate synthetic conversation.<|im_end|>
<|im_start|>assistant
`;
    const stop = 'Independent LFM350 next input verified; no second output supplied';
    const contexts: Parameters<ProductionReplayGenerate>[0][] = [];
    let firstReleased = 0;
    const invocations: ProductionReplayGenerate[] = [
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
        expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe('013eed60546434b6967e3483153d8c5c37abcb1d667f8b1f914683f2a9411531');
        expect(tokenizer.apply_chat_template(nextMessages, { tokenize: false, add_generation_prompt: true })).toBe(nextPrompt);
        const ids = tokenizer.encode(nextPrompt, { add_special_tokens: false });
        if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) throw new Error('Expected actual next-input tensors');
        expect(options.input_ids.type).toBe('int64');
        expect(options.input_ids.location).toBe('cpu');
        expect(options.input_ids.dims).toEqual([1, ids.length]);
        expect(Array.from(options.input_ids.data, Number)).toEqual(ids);
        expect(options.attention_mask.type).toBe('int64');
        expect(options.attention_mask.location).toBe('cpu');
        expect(options.attention_mask.dims).toEqual([1, ids.length]);
        expect(Array.from(options.attention_mask.data, BigInt)).toEqual(ids.map(() => 1n));
        expect(options.past_key_values).toBeNull();
        // No captured response exists for this changed input. This tests input
        // isolation with null KV, not native KV invalidation or generation.
        throw new Error(stop);
      },
    ];
    const harness = await createProductionReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, imagePlatform: undefined,
      artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async context => {
        const next = invocations.shift();
        if (!next) throw new Error('Unexpected extra inference in independent-input replay');
        return next(context);
      },
    });
    try {
      const firstChunks: string[] = [];
      await harness.provider.chat({
        model: evidence.identity.modelId, messages: evidence.scenario.messages, tools: [],
        parameters: { ...evidence.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => firstChunks.push(chunk),
      });
      const ortCountAfterFirst = harness.observations.ortCalls.length;
      const secondChunks: string[] = [];
      await expect(harness.provider.chat({
        model: evidence.identity.modelId, messages: nextMessages, tools: [],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => secondChunks.push(chunk),
      })).rejects.toThrow(stop);
      expect(firstReleased).toBe(16);
      expect(secondChunks).toEqual([]);
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
      await harness.close();
    }
  }, 30_000);
});

describe('LFM2.5 350M public strict-schema tool input', () => {
  it.each(toolInputEvidence.cases)('$caseId retains public tool definitions and result content, but the native template omits call details', async scenario => {
    const boundary = 'LFM350 tool input captured; no inference output supplied';
    let inference: Parameters<ProductionReplayGenerate>[0] | undefined;
    const execute = vi.fn<Tool['execute']>(async () => {
      throw new Error('No tool execution is permitted in this input-only fixture');
    });
    const publicTool: Tool = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    };
    const strictToolDefinitions = [{ type: 'function', function: {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
    } }];
    const publicMessages: ChatMessage[] = scenario.messages.map(message => {
      switch (message.role) {
      case 'user':
        return { role: 'user', content: message.content };
      case 'assistant':
        return {
          role: 'assistant', content: message.content,
          tool_calls: message.tool_calls.map(call => ({
            id: toToolCallId({ raw: call.id }), type: call.type,
            function: { name: call.function.name, arguments: call.function.arguments },
          })),
        };
      case 'tool':
        return { role: 'tool', content: message.content, tool_call_id: toToolCallId({ raw: message.tool_call_id }) };
      default: {
        const exhaustive: never = message;
        throw new Error(`Unexpected selected role: ${String(exhaustive)}`);
      }
      }
    });
    const harness = await createProductionReplayTestRuntime({
      modelId: toolInputEvidence.modelId, expectedRevision: toolInputEvidence.revision, imagePlatform: undefined,
      artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data'].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, path }),
      })),
      generate: async context => {
        inference = context;
        // This native matrix supplies input, not an inference result. No
        // streamer tokens, return sequences or fabricated KV are released.
        throw new Error(boundary);
      },
    });
    const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
    try {
      const chunks: string[] = [];
      await expect(harness.provider.chat({
        model: toolInputEvidence.modelId, messages: publicMessages, tools: [publicTool],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => chunks.push(chunk),
      })).rejects.toThrow(boundary);
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
      const { tokenizer, options, runtime } = inference;
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
      if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) {
        throw new Error('Expected actual LFM350 input tensors');
      }
      expect(options.input_ids.type).toBe('int64');
      expect(options.input_ids.location).toBe('cpu');
      expect(options.input_ids.dims).toEqual([1, strictIds.length]);
      expect(Array.from(options.input_ids.data, Number)).toEqual(strictIds);
      expect(options.attention_mask.type).toBe('int64');
      expect(options.attention_mask.location).toBe('cpu');
      expect(options.attention_mask.dims).toEqual([1, strictIds.length]);
      expect(Array.from(options.attention_mask.data, BigInt)).toEqual(strictIds.map(() => 1n));
      expect(options.past_key_values).toBeNull();

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
      await harness.close();
    }
  }, 30_000);
});
