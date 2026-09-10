// @vitest-environment node
import { captureProviderChat, type ProviderChatCapture } from '@/features/transformers-js/replay-models/support/capture-provider-chat';
import { providerReplayCatalog } from './provider-evidence-catalog';
import { assembleProviderSequenceEvidence } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';
import { createProviderRequestReplay } from '@/features/transformers-js/replay-models/support/provider-replay-request';
import { verifyCapturedFullReplay } from '@/features/transformers-js/replay-models/support/provider-replay-test-captured-full';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';
import inputJson from './provider-template-inputs.evidence.json';
import toolInputJson from './provider-template-tool-inputs.evidence.json';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import evidenceJson from './provider-prefix-output.evidence.json';
import rawHistoryJson from './provider-raw-history-prefix.evidence.json';
import { parseProviderReplayTextEvidence, replayRecordedText } from '@/features/transformers-js/replay-models/support/provider-replay-test-causal-gate';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';

const evidence = parseProviderReplayTextEvidence({ value: evidenceJson });
const rawHistory = parseProviderReplayTextEvidence({ value: rawHistoryJson });
const inputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('a8217db0966688e510df7388d343187710be5b84bc291acf384586b15166bc32'),
  modelId: z.literal('LiquidAI/LFM2.5-2.6B-ONNX'), revision: z.literal('66826372fd4fa166f53be0371c9315745c07cace'),
  cases: z.array(z.object({
    caseId: z.enum(['system-user-generation', 'multi-turn-generation']),
    messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()),
    addGenerationPrompt: z.literal(true),
    selectedTemplateSha256: z.literal('8ea15224003c2e89a1ac8d3b0a3362e8e587896f2bcc41df5dcc2d9c5d0ee82c'),
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
  tools: nativeToolsSchema, addGenerationPrompt: z.literal(true),
  selectedTemplateSha256: z.literal('8ea15224003c2e89a1ac8d3b0a3362e8e587896f2bcc41df5dcc2d9c5d0ee82c'),
}).strict();
const toolInputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('a8217db0966688e510df7388d343187710be5b84bc291acf384586b15166bc32'),
  modelId: z.literal('LiquidAI/LFM2.5-2.6B-ONNX'), revision: z.literal('66826372fd4fa166f53be0371c9315745c07cace'),
  cases: z.tuple([
    nativeToolCaseSchema.extend({
      caseId: z.literal('tools-generation'), messages: z.tuple([toolUserSchema]), status: z.literal('passed'),
      renderedText: z.string(), inputTokenIds: z.array(z.number().int().nonnegative().safe()).min(1),
    }),
    nativeToolCaseSchema.extend({
      caseId: z.literal('tool-result-continuation'), messages: z.tuple([toolUserSchema, toolAssistantSchema, toolResultSchema]),
      status: z.literal('failed'), failureStage: z.literal('render'),
      error: z.object({
        name: z.literal('Error'),
        message: z.literal('Tool call arguments must be a mapping, got a JSON-encoded string: parse arguments with json.loads() before applying the chat template'),
      }).strict(),
    }),
  ]),
}).strict().parse(toolInputJson);
const observedToolMessagesSchema = z.array(z.object({
  role: z.enum(['user', 'assistant', 'tool']), content: z.string(), tool_call_id: z.string().optional(),
  tool_calls: z.tuple([z.object({
    id: z.string(), type: z.literal('function'),
    function: z.object({
      name: z.string(), arguments: z.object({ city: z.string() }).strict(),
    }).strict(),
  }).strict()]).optional(),
}).strict());
const strictLfm26Tools = [{ type: 'function', function: {
  name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false
  },
} }];
const LFM26_TOOL_INPUT_STOP = 'LFM2.6 tool input captured; no inference output supplied';

// Both cases intentionally share this model's native session/platform ownership,
// not their different original outcomes or expected template inputs.
async function createLfm26ToolInputReplay() {
  const seen: {
    count: number;
    inference: Pick<Parameters<ProviderReplayGenerate>[0], 'tokenizer' | 'runtime'> & {
      options: {
        input_ids: { type: string; location: string; dims: number[]; data: bigint[] } | undefined;
        attention_mask: { type: string; location: string; dims: number[]; data: bigint[] } | undefined;
        past_key_values: unknown;
      };
    } | undefined;
  } = { count: 0, inference: undefined };
  const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }));
  const publicTool: Tool = {
    name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
    parametersSchema: z.object({ city: z.string() }), execute,
  };
  const harness = await createProviderReplayTestRuntime({
    modelId: toolInputEvidence.modelId,
    expectedRevision: toolInputEvidence.revision,
    cacheRevision: toolInputEvidence.revision,
    metadataCache: "all-fixture",
    imagePlatform: undefined,
    artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1'].map(path => ({
      path, bytes: createSyntheticModelBody({ modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, path }),
    })),
    generate: async ({ options, tokenizer, runtime }) => {
      const input = options.input_ids;
      const mask = options.attention_mask;
      seen.count++;
      seen.inference = {
        tokenizer, runtime,
        options: {
          input_ids: input instanceof runtime.Tensor ? {
            type: input.type, location: input.location, dims: [...input.dims], data: Array.from(input.data, BigInt),
          } : undefined,
          attention_mask: mask instanceof runtime.Tensor ? {
            type: mask.type, location: mask.location, dims: [...mask.dims], data: Array.from(mask.data, BigInt),
          } : undefined,
          past_key_values: options.past_key_values,
        },
      };
      // No recorded output exists for these public strict/mapped inputs.
      throw new Error(LFM26_TOOL_INPUT_STOP);
    },
  });
  const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
  return {
    harness, seen, execute, publicTool, templateSpy,
    async close() {
      templateSpy.mockRestore();
      await harness.close();
    },
  };
}

describe('LFM2.5 2.6B Provider / basic', () => {
  it('preserves the recorded first user input without supplying any output tokens', async () => {
    const captures: ProviderChatCapture[] = [];
    const source = evidence;
    expect(source.identity.resolvedRevision).toBe('66826372fd4fa166f53be0371c9315745c07cace');
    expect(source.scenario.messages).toEqual([{ role: 'user', content: 'Template probe user message.' }]);
    expect(source.scenario.tools).toEqual([]);
    const stop = 'lfm2.5-2.6b first Production input verified; no output tokens supplied';
    const nativeInputs: Array<{
      input: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      mask: { type: string; location: string; dims: number[]; data: unknown } | undefined;
      past: unknown; version: string; tokenizerInstance: boolean; templateSha: string; optionKeys: string[];
      config: { maxNewTokens: unknown; temperature: unknown; topP: unknown; doSample: unknown };
      returnDict: unknown; streamerInstance: boolean; stoppingType: string;
    }> = [];
    const harness = await createProviderReplayTestRuntime({
      modelId: 'LiquidAI/LFM2.5-2.6B-ONNX',
      expectedRevision: source.identity.resolvedRevision,
      cacheRevision: source.identity.resolvedRevision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      // Identifiable synthetic bodies replace native weight execution only.
      artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1'].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: 'LiquidAI/LFM2.5-2.6B-ONNX', revision: source.identity.resolvedRevision, path }),
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
          model: "hf.co/LiquidAI/LFM2.5-2.6B-ONNX",
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
      await expect(capture.completion).rejects.toThrow(stop);
      const { chunks, toolCalls, toolResults, toolEvents } = capture.snapshot();
      expect(nativeInputs).toHaveLength(1);
      const observed = nativeInputs[0]!;
      expect(observed.version).toBe(source.identity.transformersJsVersion);
      expect(observed.tokenizerInstance).toBe(true);
      expect(observed.templateSha).toBe('8ea15224003c2e89a1ac8d3b0a3362e8e587896f2bcc41df5dcc2d9c5d0ee82c');
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
      expect(observed.input?.dims).toEqual([1, 15]);
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
      expect(chunks).toEqual([]);
      expect(toolCalls).toEqual([]);
      expect(toolEvents).toEqual([]);
      expect(toolResults).toEqual([]);
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
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('delivers the recorded first-turn stream exactly before Provider settlement', async () => {
    const captures: ProviderChatCapture[] = [];
    expect(evidence.identity).toEqual({
      "modelId": "hf.co/LiquidAI/LFM2.5-2.6B-ONNX",
      "resolvedRevision": "66826372fd4fa166f53be0371c9315745c07cace",
      "investigationRunId": "fa058e59-541e-46cf-b1e5-7f2339fb8d19",
      "transformersJsVersion": "4.2.0"
    });
    let releasedTokenCount = 0;
    const harness = await createProviderReplayTestRuntime({
      imagePlatform: undefined,
      modelId: 'LiquidAI/LFM2.5-2.6B-ONNX',
      expectedRevision: evidence.identity.resolvedRevision,
      cacheRevision: evidence.identity.resolvedRevision,
      metadataCache: "all-fixture",
      // Only native model bodies/inference are substituted. Repository paths,
      // original tokenizer/config, offline loading and Production streaming are real.
      artifacts: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"].map(path => ({ path, bytes: Uint8Array.of(1) })),
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
          model: "hf.co/LiquidAI/LFM2.5-2.6B-ONNX",
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
      // These segment expectations are selected original Production first-turn
      // observations, not manufactured decoding steps or a completed answer.
      const settled = {
        assistantStarts: responses.length,
        chunks: [...chunks],
        toolCalls: [...toolCalls],
        toolEvents: [...toolEvents],
        toolResults: [...toolResults]
      };
      expect(releasedTokenCount).toBe(16);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => item.operation.startsWith('writer') || item.operation.startsWith('create') || item.operation === 'remove')).toEqual([]);
      expect(settled).toEqual({
        assistantStarts: 1,
        chunks: ["<think>","The ","user ","wants ","me ","to ","\"Template ","probe ","user ","message.\" ","This ","is ","a ","bit ","ambiguous"],
        toolCalls: [], toolEvents: [], toolResults: [],
      });
    } finally {
      await harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('basic: delivers the recorded first-turn callbacks before settlement', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The user wants me to \"Template probe user message.\" This is a bit ambiguous"]);
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

describe('LFM2.5 2.6B Provider / system', () => {
  it('system: preserves instructions and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["system-user"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The"]);
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

describe('LFM2.5 2.6B Provider / history', () => {
  it("system-user-generation preserves the recorded native input through Provider.chat", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases.find((item): boolean => item.caseId === "system-user-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'LFM2.5 2.6B input verified; no generation replay';
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
        'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1',
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
      await harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it("multi-turn-generation preserves the recorded native input through Provider.chat", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases.find((item): boolean => item.caseId === "multi-turn-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'LFM2.5 2.6B input verified; no generation replay';
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
        'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1',
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
      await harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('replays the captured prefix for explicit raw assistant history without claiming a successful preceding Provider turn', async () => {
    const captures: ProviderChatCapture[] = [];
    expect(rawHistory.identity).toEqual(evidence.identity);
    expect(rawHistory.scenario.id).toBe('explicit-raw-assistant-history-natural-prefix');
    expect(rawHistory.scenario.messages).toEqual([
      { role: 'user', content: 'Template probe user message.' },
      { role: 'assistant', content: evidence.modelReplay.generatedText },
      { role: 'user', content: 'Continue with one short sentence.' },
    ]);
    // The old investigation fed raw model text back as visible assistant text,
    // without the public <think> prefix. This is an independently supplied
    // history scenario, not proof of correct first-to-second-turn reconstruction.
    expect(rawHistory.scenario.messages[1]?.content).not.toBe(`<think>${evidence.expectedProviderSemantic.thinking}`);
    let releasedTokenCount = 0;
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId,
      expectedRevision: inputEvidence.revision,
      cacheRevision: inputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      artifacts: [
        'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async ({ options, tokenizer, runtime }) => {
        expect(tokenizer.decode([124901], { skip_special_tokens: false })).toBe('<think>');
        expect(tokenizer.decode(rawHistory.modelReplay.generatedTokenIds, { skip_special_tokens: false }))
          .toBe(rawHistory.modelReplay.generatedText);
        const result = replayRecordedText({ evidence: rawHistory, options });
        releasedTokenCount += result.releasedTokenCount;
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(result.sequenceTokenIds), [1, result.sequenceTokenIds.length]), past_key_values: null };
      },
    });
    try {
      const capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/LiquidAI/LFM2.5-2.6B-ONNX",
          messages: [{ role: "user", content: "Template probe user message." }, { role: "assistant", content: "The user wants me to \"Template probe user message.\" This is a bit ambiguous" }, { role: "user", content: "Continue with one short sentence." }],
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
      const { chunks } = capture.snapshot();
      const settledChunks = [...chunks];
      expect(releasedTokenCount).toBe(16);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Original normalized chunks. Do not synthesize a reasoning close/final
      // response, or drain callbacks after public settlement to obtain a PASS.
      expect(settledChunks).toEqual([
        '<think>', 'The ', 'user ', 'wants ', 'me ', 'to ', 'continue ', 'with ',
        'one ', 'short ', 'sentence. ', 'They ', 'previously ', 'asked ', 'for ', 'a',
      ]);
    } finally {
      await harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('history: preserves supplied history and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["supplied-history"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The"]);
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

describe('LFM2.5 2.6B Provider / independent', () => {
  it('keeps an independent next input free of prior reasoning in the same null-KV loaded runtime', async () => {
    const captures: ProviderChatCapture[] = [];
    const nextMessages: ChatMessage[] = [{ role: 'user', content: 'A separate synthetic LFM conversation.' }];
    // Specify the prompt separately from the Production adapter. The captured
    // template controls above establish this model's delimiters and open think.
    const nextPrompt = `\
<|startoftext|><|im_start|>user
A separate synthetic LFM conversation.<|im_end|>
<|im_start|>assistant
<think>`;
    const stop = 'Independent LFM2.6 next input verified; no second output supplied';
    const contexts: Array<Pick<Parameters<ProviderReplayGenerate>[0], 'model' | 'tokenizer'> & {
      options: { past_key_values: unknown };
    }> = [];
    const nextInputs: Array<{
      tokenizer: Parameters<ProviderReplayGenerate>[0]['tokenizer'];
      input: { type: string; location: string; dims: number[]; data: number[] } | undefined;
      mask: { type: string; location: string; dims: number[]; data: bigint[] } | undefined;
      past: unknown; maxNewTokens: unknown; temperature: unknown; topP: unknown; doSample: unknown; returnDict: unknown;
    }> = [];
    let firstReleased = 0;
    const invocations: ProviderReplayGenerate[] = [
      async context => {
        contexts.push({ model: context.model, tokenizer: context.tokenizer, options: { past_key_values: context.options.past_key_values } });
        const { options, tokenizer, runtime } = context;
        expect(tokenizer.decode(evidence.modelReplay.generatedTokenIds, { skip_special_tokens: false })).toBe(evidence.modelReplay.generatedText);
        const replay = replayRecordedText({ evidence, options });
        firstReleased = replay.releasedTokenCount;
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
      async context => {
        contexts.push({ model: context.model, tokenizer: context.tokenizer, options: { past_key_values: context.options.past_key_values } });
        const { options, tokenizer, runtime } = context;
        const input = options.input_ids;
        const mask = options.attention_mask;
        nextInputs.push({
          tokenizer,
          input: input instanceof runtime.Tensor ? {
            type: input.type, location: input.location, dims: [...input.dims], data: Array.from(input.data, Number),
          } : undefined,
          mask: mask instanceof runtime.Tensor ? {
            type: mask.type, location: mask.location, dims: [...mask.dims], data: Array.from(mask.data, BigInt),
          } : undefined,
          past: options.past_key_values, maxNewTokens: options.max_new_tokens, temperature: options.temperature,
          topP: options.top_p, doSample: options.do_sample, returnDict: options.return_dict_in_generate,
        });
        // This proves isolation of public input with a null native cache, not
        // real GPU KV invalidation or an uncaptured second inference result.
        throw new Error(stop);
      },
    ];
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId,
      expectedRevision: inputEvidence.revision,
      cacheRevision: inputEvidence.revision,
      metadataCache: "all-fixture",
      imagePlatform: undefined,
      artifacts: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1'].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }),
      })),
      generate: async context => {
        const next = invocations.shift();
        if (!next) throw new Error('Unexpected extra inference in independent LFM2.6 input replay');
        return next(context);
      },
    });
    try {
      const firstCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/LiquidAI/LFM2.5-2.6B-ONNX",
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

      // Keep exactly the same public model spelling; alias-triggered reload
      // would hide whether the existing runtime retains a previous request.
      const secondCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/LiquidAI/LFM2.5-2.6B-ONNX",
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

      expect(nextInputs).toHaveLength(1);
      const nextInput = nextInputs[0]!;
      expect(createHash('sha256').update(nextInput.tokenizer.get_chat_template()).digest('hex'))
        .toBe('8ea15224003c2e89a1ac8d3b0a3362e8e587896f2bcc41df5dcc2d9c5d0ee82c');
      expect(nextInput.tokenizer.apply_chat_template(nextMessages, { tokenize: false, add_generation_prompt: true })).toBe(nextPrompt);
      const ids = nextInput.tokenizer.encode(nextPrompt, { add_special_tokens: false });
      expect(nextInput.input?.type).toBe('int64');
      expect(nextInput.input?.location).toBe('cpu');
      expect(nextInput.input?.dims).toEqual([1, ids.length]);
      expect(nextInput.input?.data).toEqual(ids);
      expect(nextInput.mask?.type).toBe('int64');
      expect(nextInput.mask?.location).toBe('cpu');
      expect(nextInput.mask?.dims).toEqual([1, ids.length]);
      expect(nextInput.mask?.data).toEqual(ids.map(() => 1n));
      expect(nextInput.past).toBeNull();
      expect(nextInput.maxNewTokens).toBe(1);
      expect(nextInput.temperature).toBe(0);
      expect(nextInput.topP).toBe(1);
      expect(nextInput.doSample).toBe(false);
      expect(nextInput.returnDict).toBe(true);

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
      expect(harness.observations.processors).toHaveLength(0);
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
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn","continuity","independent-next-input"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The user wants me to \"Template probe user message.\" This is a bit ambiguous"]);
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The user wants me to continue a synthetic conversation with a short response. They previously"]);
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The"]);
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

describe('LFM2.5 2.6B Provider / reasoning', () => {
  it('reasoning: preserves the recorded none-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-none"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The"]);
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
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-low"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The"]);
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
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-medium"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The"]);
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
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-high"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The"]);
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

describe('LFM2.5 2.6B Provider / tools', () => {
  it('tools-generation uses the strict public schema rather than replaying the different native open-schema input', async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = toolInputEvidence.cases[0];
    const replay = await createLfm26ToolInputReplay();
    try {
      const capture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: toolInputEvidence.modelId,
          messages: scenario.messages,
          tools: [replay.publicTool],
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
      await expect(capture.completion).rejects.toThrow(LFM26_TOOL_INPUT_STOP);
      const { chunks } = capture.snapshot();
      expect(chunks).toEqual([]);
      expect(replay.execute).not.toHaveBeenCalled();
      expect(replay.harness.observations.inferenceCalls).toHaveLength(1);
      // Only actual Production calls are considered here. Protocol/reasoning
      // probes use tokenize:false; no native oracle has run through this spy yet.
      const productionTokenizations = replay.templateSpy.mock.calls.filter(([, options]) => options?.tokenize !== false);
      expect(productionTokenizations).toHaveLength(1);
      const productionCall = productionTokenizations[0];
      if (!productionCall) throw new Error('Expected Production template invocation');
      // Raw unknown fields still fail. Only optional-field ownness is irrelevant
      // to the semantic messages being compared, and actual arguments stay intact.
      const observedMessages = observedToolMessagesSchema.parse(productionCall[0]).map(message => {
        const { role, content, tool_calls, tool_call_id, ...unhandled } = message;
        unhandled satisfies Record<PropertyKey, never>;
        return { role, content, tool_calls, tool_call_id };
      });
      expect(observedMessages).toStrictEqual([
        { role: 'user', content: scenario.messages[0].content, tool_calls: undefined, tool_call_id: undefined },
      ]);
      expect(productionCall[1]).toStrictEqual({ add_generation_prompt: true, return_dict: true, tools: strictLfm26Tools });
      if (!replay.seen.inference) throw new Error('Actual LFM2.6 inference boundary was not reached');
      const { tokenizer, runtime, options } = replay.seen.inference;
      expect(replay.seen.count).toBe(1);
      expect(createHash('sha256').update(tokenizer.get_chat_template({ tools: scenario.tools })).digest('hex')).toBe(scenario.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: scenario.tools,
      })).toBe(scenario.renderedText);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: true, return_dict: false, return_tensor: false, add_generation_prompt: true, tools: scenario.tools,
      })).toEqual(scenario.inputTokenIds);
      expect(scenario.renderedText.split('"required": ["city"]')).toHaveLength(2);
      const strictPrompt = scenario.renderedText.replace('"required": ["city"]', '"required": ["city"], "additionalProperties": false');
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: strictLfm26Tools,
      })).toBe(strictPrompt);
      const nativeStrict = tokenizer(strictPrompt, { add_special_tokens: false });
      expect(nativeStrict.input_ids).toBeInstanceOf(runtime.Tensor);
      const strictIds = Array.from(nativeStrict.input_ids.data, Number);
      expect(strictIds).not.toEqual(scenario.inputTokenIds);
      if (!options.input_ids || !options.attention_mask) {
        throw new Error('Expected actual LFM2.6 input tensors');
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
      const originalContent = scenario.messages[0].content;
      expect(originalContent).not.toBe('');
      expect(strictPrompt.split(originalContent)).toHaveLength(2);
      expect(tokenizer.apply_chat_template([{ role: 'user', content: 'Changed synthetic user message.' }], {
        tokenize: false, add_generation_prompt: true, tools: strictLfm26Tools,
      })).toBe(strictPrompt.replace(originalContent, 'Changed synthetic user message.'));
      expect(replay.harness.observations.ortCalls.map(([core, ortOptions]) => inspectSyntheticOrtSession({
        modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision,
        repositoryPaths: new Set(['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1']), core, options: ortOptions,
      }))).toEqual([{
        modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, corePath: 'onnx/model_q4f16.onnx',
        externalData: [{ path: 'model_q4f16.onnx_data', artifactPath: 'onnx/model_q4f16.onnx_data' }, { path: 'model_q4f16.onnx_data_1', artifactPath: 'onnx/model_q4f16.onnx_data_1' }],
        executionProviders: ['webgpu'],
      }]);
      expect(replay.harness.observations.runtimeAssetFetchCalls).toEqual([replay.harness.observations.expectedRuntimeAssetUrl]);
      expect(replay.harness.observations.localImageFetchCalls).toEqual([]);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
      expect(replay.harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('tool-result-continuation converts public JSON arguments to the native mapping contract without inventing an original successful capture', async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = toolInputEvidence.cases[1];
    const replay = await createLfm26ToolInputReplay();
    const publicMessages: ChatMessage[] = [
      scenario.messages[0],
      {
        role: 'assistant', content: '',
        tool_calls: [{
          id: toToolCallId({ raw: 'call_template_probe_1' }), type: 'function',
          function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' },
        }],
      },
      { role: 'tool', tool_call_id: toToolCallId({ raw: 'call_template_probe_1' }), content: scenario.messages[2].content },
    ];
    try {
      expect(publicMessages).toStrictEqual(scenario.messages);

      const capture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: toolInputEvidence.modelId,
          messages: publicMessages,
          tools: [replay.publicTool],
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
      await expect(capture.completion).rejects.toThrow(LFM26_TOOL_INPUT_STOP);
      const { chunks, toolCalls, toolResults } = capture.snapshot();
      expect(chunks).toEqual([]);
      expect(replay.execute).not.toHaveBeenCalled();
      expect(toolCalls).toEqual([]);
      expect(toolResults).toEqual([]);
      expect(replay.harness.observations.inferenceCalls).toHaveLength(1);
      // This mapping is an independent expectation for Naidan's documented
      // delimited-pythonic adaptation, not data copied from actual spy output.
      const nativeMappedMessages = [
        { role: 'user', content: scenario.messages[0].content, tool_calls: undefined, tool_call_id: undefined },
        {
          role: 'assistant', content: '', tool_call_id: undefined,
          tool_calls: [{
            id: 'call_template_probe_1', type: 'function',
            function: { name: 'lookup_weather', arguments: { city: 'Tokyo' } },
          }],
        },
        { role: 'tool', content: scenario.messages[2].content, tool_calls: undefined, tool_call_id: 'call_template_probe_1' },
      ] satisfies [Record<string, unknown>, Record<string, unknown>, Record<string, unknown>];
      const productionTokenizations = replay.templateSpy.mock.calls.filter(([, options]) => options?.tokenize !== false);
      expect(productionTokenizations).toHaveLength(1);
      const productionCall = productionTokenizations[0];
      if (!productionCall) throw new Error('Expected Production template invocation');
      const observedMessages = observedToolMessagesSchema.parse(productionCall[0]).map(message => {
        const { role, content, tool_calls, tool_call_id, ...unhandled } = message;
        unhandled satisfies Record<PropertyKey, never>;
        return { role, content, tool_calls, tool_call_id };
      });
      expect(observedMessages).toStrictEqual(nativeMappedMessages);
      expect(productionCall[1]).toStrictEqual({ add_generation_prompt: true, return_dict: true, tools: strictLfm26Tools });
      if (!replay.seen.inference) throw new Error('Actual LFM2.6 inference boundary was not reached');
      const { tokenizer, runtime, options } = replay.seen.inference;
      expect(replay.seen.count).toBe(1);
      expect(createHash('sha256').update(tokenizer.get_chat_template({ tools: scenario.tools })).digest('hex')).toBe(scenario.selectedTemplateSha256);
      // Preserve the original render failure. It had no rendered text, input IDs
      // or generated output; the successful mapped oracle below is CURRENT.
      expect(() => tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: scenario.tools,
      })).toThrow(scenario.error.message);
      expect(() => tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: strictLfm26Tools,
      })).toThrow(scenario.error.message);
      const strictPrompt = `\
<|startoftext|><|im_start|>system
List of tools: [{"type": "function", "function": {"name": "lookup_weather", "description": "Return deterministic weather fixture data.", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"], "additionalProperties": false}}}]<|im_end|>
<|im_start|>user
Use the weather tool for Tokyo.<|im_end|>
<|im_start|>assistant
<|tool_call_start|>[lookup_weather(city='Tokyo')]<|tool_call_end|><|im_end|>
<|im_start|>tool
{"temperatureC":20,"condition":"clear"}<|im_end|>
<|im_start|>assistant
<think>`;
      expect(tokenizer.apply_chat_template(nativeMappedMessages, {
        tokenize: false, add_generation_prompt: true, tools: strictLfm26Tools,
      })).toBe(strictPrompt);
      expect(tokenizer.apply_chat_template(nativeMappedMessages, {
        tokenize: false, add_generation_prompt: true, tools: scenario.tools,
      })).toBe(strictPrompt.replace(', "additionalProperties": false', ''));
      const nativeStrict = tokenizer(strictPrompt, { add_special_tokens: false });
      expect(nativeStrict.input_ids).toBeInstanceOf(runtime.Tensor);
      const strictIds = Array.from(nativeStrict.input_ids.data, Number);
      if (!options.input_ids || !options.attention_mask) {
        throw new Error('Expected actual LFM2.6 input tensors');
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
      // Call name/arguments and result body have separate exact sensitivity.
      expect(strictPrompt.split("city='Tokyo'")).toHaveLength(2);
      const changedCallMessages = [
        nativeMappedMessages[0],
        { role: 'assistant', content: '', tool_calls: [{
          id: 'call_template_probe_1', type: 'function',
          function: { name: 'lookup_weather', arguments: { city: 'Osaka' } },
        }] },
        nativeMappedMessages[2],
      ];
      expect(tokenizer.apply_chat_template(changedCallMessages, {
        tokenize: false, add_generation_prompt: true, tools: strictLfm26Tools,
      })).toBe(strictPrompt.replace("city='Tokyo'", "city='Osaka'"));
      const originalResult = scenario.messages[2].content;
      expect(originalResult).not.toBe('');
      expect(strictPrompt.split(originalResult)).toHaveLength(2);
      expect(tokenizer.apply_chat_template([
        nativeMappedMessages[0], nativeMappedMessages[1], { role: 'tool', content: 'Changed synthetic result.' },
      ], { tokenize: false, add_generation_prompt: true, tools: strictLfm26Tools }))
        .toBe(strictPrompt.replace(originalResult, 'Changed synthetic result.'));
      expect(replay.harness.observations.ortCalls.map(([core, ortOptions]) => inspectSyntheticOrtSession({
        modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision,
        repositoryPaths: new Set(['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1']), core, options: ortOptions,
      }))).toEqual([{
        modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, corePath: 'onnx/model_q4f16.onnx',
        externalData: [{ path: 'model_q4f16.onnx_data', artifactPath: 'onnx/model_q4f16.onnx_data' }, { path: 'model_q4f16.onnx_data_1', artifactPath: 'onnx/model_q4f16.onnx_data_1' }],
        executionProviders: ['webgpu'],
      }]);
      expect(replay.harness.observations.runtimeAssetFetchCalls).toEqual([replay.harness.observations.expectedRuntimeAssetUrl]);
      expect(replay.harness.observations.localImageFetchCalls).toEqual([]);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
      expect(replay.harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('tools: executes the recorded minimal Tokyo call once and continues with its result', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["natural-tool-minimal"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
      imagePlatform: undefined
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The user wants me to use the weather tool for Tokyo. I need to call the lookup_weather function with the city parameter set to \"Tokyo\".</think>", "<think>The weather tool has returned the weather data for Tokyo. The temperature is 20°C and the condition is clear. I should provide this information to the user.</think>The weather in Tokyo is currently **clear** with a temperature of **20°C**."]);
        expect(order).toEqual(["assistant-start", "tool-call", "execute", "tool-result", "assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
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
  }, 30_000);
  it('tools: executes the recorded representative Tokyo call once and continues with its result', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["natural-tool-representative"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
      imagePlatform: undefined
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual([`\
<think>The user wants me to:
1. Use the lookup_weather tool for Tokyo
2. Then provide a short answer based on the tool result

Let me first call the lookup_weather function with city "Tokyo".</think>`, "<think>The tool returned weather data for Tokyo: temperature is 20°C and the condition is \"clear\". I need to provide a short answer based on this result.</think>The weather in Tokyo is currently **clear** with a temperature of **20°C**."]);
        expect(order).toEqual(["assistant-start", "tool-call", "execute", "tool-result", "assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
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
  }, 30_000);
  it('tools: preserves structured caller history and the recorded response', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["structured-tool-history"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
      imagePlatform: undefined
    });
    const captures: ProviderChatCapture[] = [];
    const lateExecutions: string[] = [];
    try {
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The weather tool has returned the weather for Tokyo. The temperature is 20°C and the condition is clear. I should provide this information to the user in a clear and concise way.</think>The weather in Tokyo is currently **clear** with a temperature of **20°C**."]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(lateEvents).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
        expect(executions).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
    expect(lateExecutions).toEqual([]);
  }, 30_000);
});

describe('LFM2.5 2.6B Provider / images', () => {
  it('images: preserves the recorded text-only native handling of an image-bearing request', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["image"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The"]);
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

describe('LFM2.5 2.6B Provider / sequences', () => {
  it('sequences: builds continuation from actually delivered first-request settlement', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn","continuity"],
      artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"],
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The user wants me to \"Template probe user message.\" This is a bit ambiguous"]);
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
            model: "LiquidAI/LFM2.5-2.6B-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["<think>The user wants me to continue a synthetic conversation with a short response. They previously"]);
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
  it('preserves thirteen causal requests, native streams and settlements in one Load', async () => {
    const fullEvidenceJson = assembleProviderSequenceEvidence({ catalog: providerReplayCatalog });
    expect(fullEvidenceJson.modelId).toBe('LiquidAI/LFM2.5-2.6B-ONNX');
    expect(fullEvidenceJson.metadataRevision).toBe('66826372fd4fa166f53be0371c9315745c07cace');
    expect(fullEvidenceJson.observedCacheRevision).toBe('main');
    await verifyCapturedFullReplay({ reviewedPublicContract: undefined, unavailableOutputs: [], completeResult: undefined, expectedLoadReceipt: undefined, evidence: fullEvidenceJson, imagePlatform: undefined, artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1"] });
  }, 30_000);
});
