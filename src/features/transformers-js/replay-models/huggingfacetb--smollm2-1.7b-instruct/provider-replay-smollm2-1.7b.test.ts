// @vitest-environment node
import { providerReplayCatalog } from './provider-evidence-catalog';
import { assembleProviderSequenceEvidence } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';
import { verifyProviderRequests } from '@/features/transformers-js/replay-models/support/provider-replay-request';
import { verifyCapturedFullReplay } from '@/features/transformers-js/replay-models/support/provider-replay-test-captured-full';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';
import evidenceJson from './provider-prefix-output.evidence.json';
import continuityJson from './provider-supplied-history-prefix.evidence.json';
import inputJson from './provider-template-inputs.evidence.json';
import toolInputJson from './provider-template-tool-inputs.evidence.json';
import { parseProviderReplayTextEvidence, replayRecordedText } from '@/features/transformers-js/replay-models/support/provider-replay-test-causal-gate';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';

const evidence = parseProviderReplayTextEvidence({ value: evidenceJson });
const continuity = parseProviderReplayTextEvidence({ value: continuityJson });
const inputCaseSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()),
  addGenerationPrompt: z.literal(true), renderedText: z.string(),
  inputTokenIds: z.array(z.number().int().nonnegative().safe()),
}).strict();
const inputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('1b4f3a08b7699d091506a31b9218238cfb5b7dc7c3ff0497b76e060bf7fbc169'),
  modelId: z.literal('HuggingFaceTB/SmolLM2-1.7B-Instruct'),
  revision: z.literal('31b70e2e869a7173562077fd711b654946d38674'),
  selectedTemplateSha256: z.literal('872be49dbb638044ad01b60388f48d469ff2980e5f0dccdc22ec907db54d0788'),
  cases: z.tuple([
    inputCaseSchema.extend({ caseId: z.literal('system-user-generation') }),
    inputCaseSchema.extend({ caseId: z.literal('multi-turn-generation') }),
  ]),
}).strict().parse(inputJson);

const toolUserMessageSchema = z.object({ role: z.literal('user'), content: z.string() }).strict();
const toolAssistantMessageSchema = z.object({
  role: z.literal('assistant'), content: z.literal(''),
  tool_calls: z.tuple([z.object({
    id: z.literal('call_template_probe_1'), type: z.literal('function'),
    function: z.object({ name: z.literal('lookup_weather'), arguments: z.literal('{"city":"Tokyo"}') }).strict(),
  }).strict()]),
}).strict();
const toolResultMessageSchema = z.object({
  role: z.literal('tool'), tool_call_id: z.literal('call_template_probe_1'), content: z.string(),
}).strict();
const toolInputCaseSchema = z.object({
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
  inputTokenIds: z.array(z.number().int().nonnegative().safe()),
}).strict();
const toolInputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('1b4f3a08b7699d091506a31b9218238cfb5b7dc7c3ff0497b76e060bf7fbc169'),
  modelId: z.literal('HuggingFaceTB/SmolLM2-1.7B-Instruct'),
  revision: z.literal('31b70e2e869a7173562077fd711b654946d38674'),
  selectedTemplateSha256: z.literal('872be49dbb638044ad01b60388f48d469ff2980e5f0dccdc22ec907db54d0788'),
  cases: z.tuple([
    toolInputCaseSchema.extend({ caseId: z.literal('tools-generation'), messages: z.tuple([toolUserMessageSchema]) }),
    toolInputCaseSchema.extend({ caseId: z.literal('tool-result-continuation'), messages: z.tuple([toolUserMessageSchema, toolAssistantMessageSchema, toolResultMessageSchema]) }),
  ]),
}).strict().parse(toolInputJson);

describe('SmolLM2 1.7B Provider / basic', () => {
  it('preserves the recorded first user input without supplying any output tokens', async () => {
    const source = evidence;
    expect(source.identity.resolvedRevision).toBe('31b70e2e869a7173562077fd711b654946d38674');
    expect(source.scenario.messages).toEqual([{ role: 'user', content: 'Template probe user message.' }]);
    expect(source.scenario.tools).toEqual([]);
    const stop = 'smollm2-1.7b first Production input verified; no output tokens supplied';
    let verifiedInputs = 0;
    const harness = await createProviderReplayTestRuntime({
      modelId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', expectedRevision: source.identity.resolvedRevision, cacheRevision: source.identity.resolvedRevision, metadataCache: "all-fixture", imagePlatform: undefined,
      // Identifiable synthetic bodies replace native weight execution only.
      artifacts: ['onnx/model_q4f16.onnx'].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', revision: source.identity.resolvedRevision, path }),
      })),
      generate: async ({ options, tokenizer, runtime }) => {
        expect(runtime.env.version).toBe(source.identity.transformersJsVersion);
        expect(tokenizer).toBeInstanceOf(runtime.PreTrainedTokenizer);
        expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'))
          .toBe('872be49dbb638044ad01b60388f48d469ff2980e5f0dccdc22ec907db54d0788');
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
        expect(options.input_ids.dims).toEqual([1, 35]);
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
  it('delivers the recorded first-turn stream exactly before Provider settlement', async () => {
    expect(evidence.identity).toEqual({
      "modelId": "hf.co/HuggingFaceTB/SmolLM2-1.7B-Instruct",
      "resolvedRevision": "31b70e2e869a7173562077fd711b654946d38674",
      "investigationRunId": "23685c03-b461-4e73-8cfb-14e6743cd84b",
      "transformersJsVersion": "4.2.0"
    });
    let releasedTokenCount = 0;
    const harness = await createProviderReplayTestRuntime({
      imagePlatform: undefined,
      modelId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', expectedRevision: evidence.identity.resolvedRevision, cacheRevision: evidence.identity.resolvedRevision, metadataCache: "all-fixture",
      // Native model bodies/inference and browser platform are substituted.
      // Original metadata, offline loading and Production streaming remain real.
      artifacts: ["onnx/model_q4f16.onnx"].map(path => ({ path, bytes: Uint8Array.of(1) })),
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
        chunks: ["Sure, ","here's ","a ","sample ","message ","for ","a ","template:\n","\n","\"Hello!"],
        toolCalls: [], toolEvents: [], toolResults: [],
      });
    } finally {
      await harness.close();
    }
  }, 30_000);
  it('basic: delivers the recorded first-turn callbacks before settlement', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["first-turn"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / system', () => {
  it('system: preserves instructions and delivers the recorded callbacks', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["system-user"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / history', () => {
  it.each(inputEvidence.cases)('$caseId matches the original native input through public Provider', async scenario => {
    const boundary = 'Smol1.7 native input verified; generation intentionally not replayed';
    let verifiedInputs = 0;
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      // Identifiable tiny bytes replace native weight execution only.
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path: 'onnx/model_q4f16.onnx' }) }],
      generate: async ({ options, tokenizer, runtime }) => {
        expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(inputEvidence.selectedTemplateSha256);
        expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: scenario.addGenerationPrompt })).toBe(scenario.renderedText);
        expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: true, add_generation_prompt: scenario.addGenerationPrompt, return_tensor: false, return_dict: false })).toEqual(scenario.inputTokenIds);
        if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) {
          throw new Error('Expected actual Smol1.7 tokenizer tensors');
        }
        expect(options.input_ids.type).toBe('int64');
        expect(options.input_ids.location).toBe('cpu');
        expect(options.input_ids.dims).toEqual([1, scenario.inputTokenIds.length]);
        expect(Array.from(options.input_ids.data, Number)).toEqual(scenario.inputTokenIds);
        expect(options.attention_mask.type).toBe('int64');
        expect(options.attention_mask.location).toBe('cpu');
        expect(options.attention_mask.dims).toEqual([1, scenario.inputTokenIds.length]);
        expect(Array.from(options.attention_mask.data, BigInt)).toEqual(scenario.inputTokenIds.map(() => 1n));
        ++verifiedInputs;
        // The matrix recorded input, not an inference result for these cases.
        // Never release another invocation's output or synthesize KV state.
        throw new Error(boundary);
      },
    });
    try {
      const chunks: string[] = [];
      await expect(harness.provider.chat({
        model: inputEvidence.modelId, messages: scenario.messages, tools: [],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => chunks.push(chunk),
      })).rejects.toThrow(boundary);
      expect(verifiedInputs).toBe(1);
      expect(chunks).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.ortCalls.map(([core, options]) => inspectSyntheticOrtSession({
        modelId: inputEvidence.modelId, revision: inputEvidence.revision,
        repositoryPaths: new Set(['onnx/model_q4f16.onnx']), core, options,
      }))).toEqual([{ modelId: inputEvidence.modelId, revision: inputEvidence.revision, corePath: 'onnx/model_q4f16.onnx', externalData: [], executionProviders: ['webgpu'] }]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
  it('preserves the recorded end-of-turn output with explicitly supplied assistant history', async () => {
    expect(continuity.identity).toEqual(evidence.identity);
    expect(continuity.scenario.messages).toEqual([
      { role: 'user', content: 'Template probe user message.' },
      { role: 'assistant', content: evidence.expectedProviderSemantic.visibleContent },
      { role: 'user', content: 'Continue with one short sentence.' },
    ]);
    expect(continuity.scenario.boundary).toEqual({
      kind: 'recorded-ending', lengthRelation: 'below-requested-budget', lastTokenId: 2, stopCause: 'not-recorded',
    });
    let releasedTokenCount = 0;
    const harness = await createProviderReplayTestRuntime({
      imagePlatform: undefined,
      modelId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', expectedRevision: continuity.identity.resolvedRevision, cacheRevision: continuity.identity.resolvedRevision, metadataCache: "all-fixture",
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: Uint8Array.of(1) }],
      generate: async ({ options, tokenizer, runtime }) => {
        expect(tokenizer.decode([2], { skip_special_tokens: false })).toBe('<|im_end|>');
        expect(tokenizer.decode(continuity.modelReplay.generatedTokenIds, { skip_special_tokens: false }))
          .toBe(continuity.modelReplay.generatedText);
        expect(tokenizer.decode(continuity.modelReplay.generatedTokenIds, { skip_special_tokens: true }))
          .toBe(continuity.expectedProviderSemantic.visibleContent);
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
      expect(releasedTokenCount).toBe(13);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Original visible chunks exclude the emitted end token. Supplying this
      // history does not prove first-turn callback delivery or KV-cache reuse.
      expect(settledChunks).toEqual([
        "I'm ", 'excited ', 'to ', 'help ', 'you ', 'with ', 'your ', 'project ', 'or ', 'idea.',
      ]);
    } finally {
      await harness.close();
    }
  }, 30_000);
  it('history: preserves supplied history and delivers the recorded callbacks', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["supplied-history"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / independent', () => {
  it('keeps an independent next input free of prior text in the same null-KV loaded runtime', async () => {
    const nextMessages: ChatMessage[] = [{ role: 'user', content: 'A separate synthetic conversation.' }];
    const nextPrompt = `\
<|im_start|>system
You are a helpful AI assistant named SmolLM, trained by Hugging Face<|im_end|>
<|im_start|>user
A separate synthetic conversation.<|im_end|>
<|im_start|>assistant
`;
    const stop = 'Independent Smol1.7B next input verified; no second output supplied';
    const contexts: Parameters<ProviderReplayGenerate>[0][] = [];
    let firstReleased = 0;
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
        expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(inputEvidence.selectedTemplateSha256);
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
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path: 'onnx/model_q4f16.onnx' }) }],
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
  it('independent: keeps a new conversation independent after settled requests in the same runtime', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["first-turn","continuity","independent-next-input"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / reasoning', () => {
  it('reasoning: preserves the recorded none-effort request and callbacks', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["reasoning-none"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
  it('reasoning: preserves the recorded low-effort request and callbacks', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["reasoning-low"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
  it('reasoning: preserves the recorded medium-effort request and callbacks', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["reasoning-medium"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
  it('reasoning: preserves the recorded high-effort request and callbacks', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["reasoning-high"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / tools', () => {
  it.each(toolInputEvidence.cases)('$caseId preserves arguments up to a template that does not render tool definitions or calls', async scenario => {
    const boundary = 'SmolLM2 1.7B tool input inspected; no inference output supplied';
    let actualTokenizer: Parameters<ProviderReplayGenerate>[0]['tokenizer'] | undefined;
    const execute = vi.fn<Tool['execute']>(async () => {
      throw new Error('Tool execution is outside this input-only fixture');
    });
    const publicTool: Tool = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    };
    // The native matrix recorded an open schema. This is the independently
    // expected public Tool serialization, not an expected value read from a spy.
    const strictToolDefinitions = [{
      type: 'function', function: {
        name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
        parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
      },
    }];
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
        throw new Error(`Unexpected selected tool message: ${String(exhaustive)}`);
      }
      }
    });
    const harness = await createProviderReplayTestRuntime({
      modelId: toolInputEvidence.modelId, expectedRevision: toolInputEvidence.revision, cacheRevision: toolInputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: createSyntheticModelBody({ modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, path: 'onnx/model_q4f16.onnx' }) }],
      generate: async ({ options, tokenizer, runtime }) => {
        actualTokenizer = tokenizer;
        if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) {
          throw new Error('Expected actual SmolLM2 1.7B tokenizer tensors');
        }
        expect(options.input_ids.type).toBe('int64');
        expect(options.input_ids.location).toBe('cpu');
        expect(options.input_ids.dims).toEqual([1, scenario.inputTokenIds.length]);
        expect(Array.from(options.input_ids.data, Number)).toEqual(scenario.inputTokenIds);
        expect(options.attention_mask.type).toBe('int64');
        expect(options.attention_mask.location).toBe('cpu');
        expect(options.attention_mask.dims).toEqual([1, scenario.inputTokenIds.length]);
        expect(Array.from(options.attention_mask.data, BigInt)).toEqual(scenario.inputTokenIds.map(() => 1n));
        // Nothing was generated in this matrix capture. Neither streamer tokens
        // nor fabricated return sequences/KV are released at this boundary.
        throw new Error(boundary);
      },
    });
    // A call-through spy observes the actual inherited method without replacing
    // its receiver, arguments, result, tokenizer instance or native tokenization.
    const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
    try {
      const chunks: string[] = [];
      const onToolCall = vi.fn();
      const onToolResult = vi.fn();
      await expect(harness.provider.chat({
        model: toolInputEvidence.modelId, messages: publicMessages, tools: [publicTool],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => chunks.push(chunk), onToolCall, onToolResult,
      })).rejects.toThrow(boundary);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(chunks).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(onToolCall).not.toHaveBeenCalled();
      expect(onToolResult).not.toHaveBeenCalled();

      // Snapshot Production calls BEFORE the native oracle below makes any
      // extra calls. Protocol/reasoning probes explicitly use tokenize:false;
      // the standard generation call uses native default tokenize:true.
      const observedMessageSchema = z.object({
        role: z.string(), content: z.string(),
        tool_calls: toolAssistantMessageSchema.shape.tool_calls.optional(),
        tool_call_id: z.literal('call_template_probe_1').optional(),
      }).strict();
      // Compare semantic values after the real call. Do not require an own
      // undefined property: removing one from an adapter must remain possible,
      // notably for the separately reproduced GPT-OSS history defect.
      const productionTokenizations = templateSpy.mock.calls
        .filter(([, options]) => options?.tokenize !== false)
        .map(([rawMessages, options]) => [
          z.array(observedMessageSchema).parse(rawMessages).map(message => {
            const { role, content, tool_calls, tool_call_id, ...unhandled } = message;
            unhandled satisfies Record<PropertyKey, never>;
            return { role, content, tool_calls, tool_call_id };
          }), options,
        ]);
      expect(productionTokenizations).toStrictEqual([[
        scenario.messages.map(message => ({
          role: message.role, content: message.content,
          tool_calls: 'tool_calls' in message ? message.tool_calls : undefined,
          tool_call_id: 'tool_call_id' in message ? message.tool_call_id : undefined,
        })),
        { add_generation_prompt: true, return_dict: true, tools: strictToolDefinitions },
      ]]);
      if (!actualTokenizer) throw new Error('Actual tokenizer did not reach the inference boundary');
      expect(createHash('sha256').update(actualTokenizer.get_chat_template({ tools: scenario.tools })).digest('hex'))
        .toBe(toolInputEvidence.selectedTemplateSha256);
      expect(actualTokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: scenario.tools,
      })).toBe(scenario.renderedText);
      expect(actualTokenizer.apply_chat_template(scenario.messages, {
        tokenize: true, return_tensor: false, return_dict: false, add_generation_prompt: true, tools: scenario.tools,
      })).toEqual(scenario.inputTokenIds);
      expect(actualTokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: strictToolDefinitions,
      })).toBe(scenario.renderedText);
      expect(actualTokenizer.apply_chat_template(scenario.messages, {
        tokenize: true, return_tensor: false, return_dict: false, add_generation_prompt: true, tools: strictToolDefinitions,
      })).toEqual(scenario.inputTokenIds);

      // Native limitation, not successful tool support: removing every tool
      // definition/call/association has no effect on the prompt. Role/content
      // (including the tool-result body) are still rendered and tokenized.
      const onlyRoleAndContent = scenario.messages.map(message => ({ role: message.role, content: message.content }));
      expect(actualTokenizer.apply_chat_template(onlyRoleAndContent, {
        tokenize: false, add_generation_prompt: true, tools: [],
      })).toBe(scenario.renderedText);
      const changedRoleAndContent = onlyRoleAndContent.map(message => ({ ...message }));
      const lastMessage = changedRoleAndContent.at(-1);
      if (!lastMessage) throw new Error('Selected tool input must contain a final message');
      const originalFinalContent = lastMessage.content;
      expect(originalFinalContent).not.toBe('');
      expect(scenario.renderedText.split(originalFinalContent)).toHaveLength(2);
      lastMessage.content = 'Changed synthetic final message.';
      expect(actualTokenizer.apply_chat_template(changedRoleAndContent, {
        tokenize: false, add_generation_prompt: true, tools: [],
      })).toBe(scenario.renderedText.replace(originalFinalContent, lastMessage.content));
      expect(harness.observations.ortCalls.map(([core, options]) => inspectSyntheticOrtSession({
        modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision,
        repositoryPaths: new Set(['onnx/model_q4f16.onnx']), core, options,
      }))).toEqual([{ modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, corePath: 'onnx/model_q4f16.onnx', externalData: [], executionProviders: ['webgpu'] }]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      templateSpy.mockRestore();
      await harness.close();
    }
  }, 30_000);
  it('tools: preserves the recorded minimal no-call response without claiming model-wide non-support', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["natural-tool-minimal"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
  it('tools: preserves the recorded representative no-call response without claiming model-wide non-support', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["natural-tool-representative"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
  it('tools: preserves structured caller history and the recorded response', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["structured-tool-history"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / images', () => {
  it('images: preserves the recorded text-only native handling of an image-bearing request', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["image"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / sequences', () => {
  it('uses only the settled first callback text for a second request in the same loaded runtime', async () => {
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
        expect(tokenizer.decode(continuity.modelReplay.generatedTokenIds, { skip_special_tokens: true })).toBe(continuity.expectedProviderSemantic.visibleContent);
        // A missing first callback changes the real second input. The gate must
        // reject it BEFORE releasing any captured follow-up tokens. Never fill
        // the assistant message from the fixture to make this invocation pass.
        const replay = replayRecordedText({ evidence: continuity, options });
        released.push(replay.releasedTokenCount);
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
    ];
    const harness = await createProviderReplayTestRuntime({
      modelId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', expectedRevision: evidence.identity.resolvedRevision, cacheRevision: evidence.identity.resolvedRevision, metadataCache: "all-fixture", imagePlatform: undefined,
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path: 'onnx/model_q4f16.onnx' }) }],
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
        released: [16, 13],
      });
    } finally {
      await harness.close();
    }
  }, 30_000);
  it('sequences: builds continuation from actually delivered first-request settlement', async () => {
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["first-turn","continuity"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
  }, 30_000);
  it('preserves thirteen causal requests, native streams and settlements in one Load', async () => {
    const fullEvidenceJson = assembleProviderSequenceEvidence({ catalog: providerReplayCatalog });
    expect(fullEvidenceJson.modelId).toBe('HuggingFaceTB/SmolLM2-1.7B-Instruct');
    expect(fullEvidenceJson.metadataRevision).toBe('31b70e2e869a7173562077fd711b654946d38674');
    expect(fullEvidenceJson.observedCacheRevision).toBe('main');
    await verifyCapturedFullReplay({ unavailableOutputs: [], completeResult: undefined, expectedLoadReceipt: undefined, evidence: fullEvidenceJson, imagePlatform: undefined, artifactPaths: ["onnx/model_q4f16.onnx"] });
  }, 30_000);
});
