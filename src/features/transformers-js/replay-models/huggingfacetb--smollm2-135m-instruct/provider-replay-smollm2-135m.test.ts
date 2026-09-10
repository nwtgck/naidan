// @vitest-environment node
import { captureProviderChat, type ProviderChatCapture } from '@/features/transformers-js/replay-models/support/capture-provider-chat';
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
import { providerReplayCatalog } from './provider-evidence-catalog';
import { assembleProviderSequenceEvidence } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';
import { createProviderRequestReplay } from '@/features/transformers-js/replay-models/support/provider-replay-request';
import { verifyCapturedFullReplay } from '@/features/transformers-js/replay-models/support/provider-replay-test-captured-full';
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
  sourceMemberSha256: z.literal('1ccd769adcfe0847658f94e1f83159a2ddb428d71d33411f841da0d2f5e6f230'),
  modelId: z.literal('HuggingFaceTB/SmolLM2-135M-Instruct'),
  revision: z.literal('12fd25f77366fa6b3b4b768ec3050bf629380bac'),
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
  sourceMemberSha256: z.literal('1ccd769adcfe0847658f94e1f83159a2ddb428d71d33411f841da0d2f5e6f230'),
  modelId: z.literal('HuggingFaceTB/SmolLM2-135M-Instruct'),
  revision: z.literal('12fd25f77366fa6b3b4b768ec3050bf629380bac'),
  selectedTemplateSha256: z.literal('872be49dbb638044ad01b60388f48d469ff2980e5f0dccdc22ec907db54d0788'),
  cases: z.tuple([
    toolInputCaseSchema.extend({ caseId: z.literal('tools-generation'), messages: z.tuple([toolUserMessageSchema]) }),
    toolInputCaseSchema.extend({ caseId: z.literal('tool-result-continuation'), messages: z.tuple([toolUserMessageSchema, toolAssistantMessageSchema, toolResultMessageSchema]) }),
  ]),
}).strict().parse(toolInputJson);

// Input-only observations copy native storage before controlled rejection.
function captureSmol135NativeInput({ options, tokenizer, runtime }: Parameters<ProviderReplayGenerate>[0]) {
  const tensor = ({ value }: { value: unknown }) => value instanceof runtime.Tensor
    ? { isTensor: true as const, type: value.type, location: value.location, dims: [...value.dims], data: value.data.slice() }
    : { isTensor: false as const };
  return {
    tokenizer, runtimeVersion: runtime.env.version, tokenizerIsInstance: tokenizer instanceof runtime.PreTrainedTokenizer,
    input: tensor({ value: options.input_ids }), mask: tensor({ value: options.attention_mask }), optionKeys: Object.keys(options),
    settings: { maxNewTokens: options.max_new_tokens, temperature: options.temperature, topP: options.top_p, doSample: options.do_sample },
    pastIsNull: options.past_key_values === null, returnDict: options.return_dict_in_generate,
    isTextStreamer: options.streamer instanceof runtime.TextStreamer, stoppingCriteriaType: typeof options.stopping_criteria,
  };
}

describe('SmolLM2 135M Provider / basic', () => {
  it('preserves the recorded first user input without supplying any output tokens', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    const nativeInputs: ReturnType<typeof captureSmol135NativeInput>[] = [];
    const source = evidence;
    expect(source.identity.resolvedRevision).toBe('12fd25f77366fa6b3b4b768ec3050bf629380bac');
    expect(source.scenario.messages).toEqual([{ role: 'user', content: 'Template probe user message.' }]);
    expect(source.scenario.tools).toEqual([]);
    const stop = 'smollm2-135m first Production input verified; no output tokens supplied';
    const harness = await createProviderReplayTestRuntime({
      modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct', expectedRevision: source.identity.resolvedRevision, cacheRevision: source.identity.resolvedRevision, metadataCache: "all-fixture", imagePlatform: undefined,
      // Identifiable synthetic bodies replace native weight execution only.
      artifacts: ['onnx/model_q4f16.onnx'].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct', revision: source.identity.resolvedRevision, path }),
      })),
      generate: async context => {
        nativeInputs.push(captureSmol135NativeInput(context));
        // No captured output is supplied at this observation-only boundary.
        throw new Error(stop);
      },
    });
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-135M-Instruct",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
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
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
      expect(nativeInputs).toHaveLength(1);
      const native = nativeInputs[0];
      if (!native) throw new Error('Input-only inference was not observed');
      const tokenizer = native.tokenizer;
      expect(native.runtimeVersion).toBe(source.identity.transformersJsVersion);
      expect(native.tokenizerIsInstance).toBe(true);
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'))
        .toBe('872be49dbb638044ad01b60388f48d469ff2980e5f0dccdc22ec907db54d0788');
      expect(native.optionKeys.sort()).toEqual([
        'attention_mask', 'do_sample', 'input_ids', 'max_new_tokens', 'past_key_values',
        'return_dict_in_generate', 'stopping_criteria', 'streamer', 'temperature', 'top_p',
      ].sort());
      if (!native.input.isTensor || !native.mask.isTensor) {
        throw new Error('Expected actual first-input Tensor instances');
      }
      const tensors = { input_ids: native.input, attention_mask: native.mask };
      for (const fact of source.inputContract.inputTensorFacts) {
        const tensor = tensors[fact.name];
        expect({ name: fact.name, dtype: tensor.type, dims: tensor.dims, location: tensor.location }).toEqual(fact);
        expect(tensor.data).toBeInstanceOf(BigInt64Array);
      }
      const actualIds = Array.from(native.input.data, Number);
      expect(native.input.dims).toEqual([1, 35]);
      expect(actualIds).toEqual(source.inputContract.inputTokenIds);
      expect(actualIds).toEqual(source.modelReplay.sourceInputTokenIds);
      expect(createHash('sha256').update(JSON.stringify(actualIds)).digest('hex')).toBe(source.modelReplay.sourceInputSha256);
      expect(Array.from(native.mask.data, BigInt)).toEqual(source.modelReplay.sourceInputTokenIds.map(() => 1n));
      // The source records these four requested settings, not every merged
      // GenerationConfig default or native GPU state.
      expect({
        maxNewTokens: native.settings.maxNewTokens, temperature: native.settings.temperature,
        topP: native.settings.topP, doSample: native.settings.doSample,
      }).toEqual(source.inputContract.effectiveGenerationConfig);
      expect(native.pastIsNull).toBe(true);
      expect(native.returnDict).toBe(true);
      expect(native.isTextStreamer).toBe(true);
      expect(native.stoppingCriteriaType).toBe('function');
      // Never call replayRecordedText, streamer.put/end or return sequences.
      // This positive input test remains independent of callback delivery.
      expect(chunks).toEqual([]);
      expect(capture?.snapshot().toolCalls).toEqual([]);
      expect(capture?.snapshot().toolEvents).toEqual([]);
      expect(capture?.snapshot().toolResults).toEqual([]);
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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('delivers the recorded no-tools prefix before the public Provider settles', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    // Selected from handoff's original production-lane/first-turn.json, not
    // user conversation. Only this exact source input may release these tokens.
    expect(evidence.identity).toEqual({
      modelId: 'hf.co/HuggingFaceTB/SmolLM2-135M-Instruct',
      resolvedRevision: '12fd25f77366fa6b3b4b768ec3050bf629380bac',
      investigationRunId: 'e3116bf8-aad5-431a-a9a5-e8056de49896',
      transformersJsVersion: '4.2.0',
    });
    let releasedTokenCount = 0;
    const harness = await createProviderReplayTestRuntime({
      imagePlatform: undefined,
      modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct', expectedRevision: evidence.identity.resolvedRevision, cacheRevision: evidence.identity.resolvedRevision, metadataCache: "all-fixture",
      // Native model bytes are synthetic; tokenizer metadata, loading and
      // Production control flow remain real. No weight execution is asserted.
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: Uint8Array.of(1) }],
      generate: async ({ options, tokenizer, runtime }) => {
        expect(tokenizer.decode(evidence.modelReplay.generatedTokenIds, { skip_special_tokens: false }))
          .toBe(evidence.modelReplay.generatedText);
        const replay = replayRecordedText({ evidence, options });
        releasedTokenCount += replay.releasedTokenCount;
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
    });
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-135M-Instruct",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
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
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'fulfilled' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
      // Snapshot at settlement. No timer or callback drain repairs the trace.
      const settled = { assistantStarts: observed.responses.length, text: chunks.join(''), toolCalls: observed.toolCalls, toolEvents: observed.toolEvents, toolResults: observed.toolResults };
      expect(releasedTokenCount).toBe(16);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => item.operation.startsWith('writer') || item.operation.startsWith('create') || item.operation === 'remove')).toEqual([]);
      expect(settled).toEqual({
        assistantStarts: 1,
        text: `\
"Dear Hugging Face,

I hope this message finds you well.`,
        toolCalls: [], toolEvents: [], toolResults: [],
      });
    } finally {
      await harness.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('basic: delivers the recorded first-turn callbacks before settlement', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn"],
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Template probe user message.",
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual([`\
"Dear Hugging Face,

I hope this message finds you well.`]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
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

describe('SmolLM2 135M Provider / system', () => {
  it('system: preserves instructions and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["system-user"],
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "system",
                content: "Template probe system instruction.",
              },
              {
                role: "user",
                content: "Template probe user message.",
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["\""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
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

describe('SmolLM2 135M Provider / history', () => {
  it("system-user-generation matches the original native input through public Provider", async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    const nativeInputs: ReturnType<typeof captureSmol135NativeInput>[] = [];
    const scenario = inputEvidence.cases.find((item): boolean => item.caseId === "system-user-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'Smol135 native input verified; generation intentionally not replayed';
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      // Identifiable tiny bytes replace native weight execution only.
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path: 'onnx/model_q4f16.onnx' }) }],
      generate: async context => {
        nativeInputs.push(captureSmol135NativeInput(context));
        // No captured output is supplied at this observation-only boundary.
        throw new Error(boundary);
      },
    });
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [
            {
              role: "system",
              content: "Template probe system instruction.",
            },
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
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
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
      expect(nativeInputs).toHaveLength(1);
      const native = nativeInputs[0];
      if (!native) throw new Error('Input-only inference was not observed');
      const tokenizer = native.tokenizer;
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(inputEvidence.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: scenario.addGenerationPrompt })).toBe(scenario.renderedText);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: true, add_generation_prompt: scenario.addGenerationPrompt, return_tensor: false, return_dict: false })).toEqual(scenario.inputTokenIds);
      if (!native.input.isTensor || !native.mask.isTensor) {
        throw new Error('Expected actual Smol135 tokenizer tensors');
      }
      expect(native.input.type).toBe('int64');
      expect(native.input.location).toBe('cpu');
      expect(native.input.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(Array.from(native.input.data, Number)).toEqual(scenario.inputTokenIds);
      expect(native.mask.type).toBe('int64');
      expect(native.mask.location).toBe('cpu');
      expect(native.mask.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(Array.from(native.mask.data, BigInt)).toEqual(scenario.inputTokenIds.map(() => 1n));
      // The matrix recorded input, not an inference result for these cases.
      // Never release another invocation's output or synthesize KV state.
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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }

  }, 30_000);
  it("multi-turn-generation matches the original native input through public Provider", async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    const nativeInputs: ReturnType<typeof captureSmol135NativeInput>[] = [];
    const scenario = inputEvidence.cases.find((item): boolean => item.caseId === "multi-turn-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'Smol135 native input verified; generation intentionally not replayed';
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      // Identifiable tiny bytes replace native weight execution only.
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path: 'onnx/model_q4f16.onnx' }) }],
      generate: async context => {
        nativeInputs.push(captureSmol135NativeInput(context));
        // No captured output is supplied at this observation-only boundary.
        throw new Error(boundary);
      },
    });
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [
            {
              role: "user",
              content: "Template probe first user message.",
            },
            {
              role: "assistant",
              content: "Template probe assistant response.",
            },
            {
              role: "user",
              content: "Template probe second user message.",
            },
          ],
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
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
      expect(nativeInputs).toHaveLength(1);
      const native = nativeInputs[0];
      if (!native) throw new Error('Input-only inference was not observed');
      const tokenizer = native.tokenizer;
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(inputEvidence.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: scenario.addGenerationPrompt })).toBe(scenario.renderedText);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: true, add_generation_prompt: scenario.addGenerationPrompt, return_tensor: false, return_dict: false })).toEqual(scenario.inputTokenIds);
      if (!native.input.isTensor || !native.mask.isTensor) {
        throw new Error('Expected actual Smol135 tokenizer tensors');
      }
      expect(native.input.type).toBe('int64');
      expect(native.input.location).toBe('cpu');
      expect(native.input.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(Array.from(native.input.data, Number)).toEqual(scenario.inputTokenIds);
      expect(native.mask.type).toBe('int64');
      expect(native.mask.location).toBe('cpu');
      expect(native.mask.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(Array.from(native.mask.data, BigInt)).toEqual(scenario.inputTokenIds.map(() => 1n));
      // The matrix recorded input, not an inference result for these cases.
      // Never release another invocation's output or synthesize KV state.
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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }

  }, 30_000);
  it('preserves the recorded follow-up prefix with an explicitly supplied assistant history', async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    // The original MSI continuity second turn records these 68 input tokens.
    // Supplying that history is not a claim of successful first-turn callback
    // delivery, application history persistence, or native KV-cache reuse.
    expect(continuity.identity).toEqual(evidence.identity);
    expect(continuity.scenario.messages).toEqual([
      { role: 'user', content: 'Template probe user message.' },
      { role: 'assistant', content: evidence.expectedProviderSemantic.visibleContent },
      { role: 'user', content: 'Continue with one short sentence.' },
    ]);
    let releasedTokenCount = 0;
    const harness = await createProviderReplayTestRuntime({
      imagePlatform: undefined,
      modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct', expectedRevision: continuity.identity.resolvedRevision, cacheRevision: continuity.identity.resolvedRevision, metadataCache: "all-fixture",
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: Uint8Array.of(1) }],
      generate: async ({ options, tokenizer, runtime }) => {
        expect(tokenizer.decode(continuity.modelReplay.generatedTokenIds, { skip_special_tokens: false }))
          .toBe(continuity.modelReplay.generatedText);
        const replay = replayRecordedText({ evidence: continuity, options });
        releasedTokenCount += replay.releasedTokenCount;
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
    });
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-135M-Instruct",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
            {
              role: "assistant",
              content: `\
"Dear Hugging Face,

I hope this message finds you well.`,
            },
            {
              role: "user",
              content: "Continue with one short sentence.",
            },
          ],
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
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'fulfilled' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
      const settledChunks = [...chunks];
      expect(releasedTokenCount).toBe(16);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      // Exact original stream segmentation as well as visible content; no
      // fabricated callback ACK or after-settlement drain is permitted.
      expect(settledChunks).toEqual([
        '"I\'m ', 'sorry ', 'for ', 'the ', 'misunderstanding, ', 'but ',
        'as ', 'a ', 'Hugging ', 'Face ', 'user,',
      ]);
    } finally {
      await harness.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('history: preserves supplied history and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["supplied-history"],
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Template probe first user message.",
              },
              {
                role: "assistant",
                content: "Template probe assistant response.",
              },
              {
                role: "user",
                content: "Template probe second user message.",
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["Template"]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
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

describe('SmolLM2 135M Provider / independent', () => {
  it('keeps an independent next input free of prior text in the same null-KV loaded runtime', async () => {
    const captures: ProviderChatCapture[] = [];
    let firstCapture: ProviderChatCapture | undefined;
    let secondCapture: ProviderChatCapture | undefined;
    const nextMessages: ChatMessage[] = [
      {
        role: 'user',
        content: 'A separate synthetic conversation.',
      },
    ];
    const nextPrompt = `\
<|im_start|>system
You are a helpful AI assistant named SmolLM, trained by Hugging Face<|im_end|>
<|im_start|>user
A separate synthetic conversation.<|im_end|>
<|im_start|>assistant
`;
    const stop = 'Independent Smol135 next input verified; no second output supplied';
    const contexts: Parameters<ProviderReplayGenerate>[0][] = [];
    let firstReleased = 0;
    const stoppedInputs: ReturnType<typeof captureSmol135NativeInput>[] = [];
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
        stoppedInputs.push(captureSmol135NativeInput(context));
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
      firstCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-135M-Instruct",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
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
      const firstObserved = firstCapture.snapshot();
      expect(firstObserved.settlement).toMatchObject({ status: 'fulfilled' });
      expect(firstObserved.preStartChunks).toEqual([]);
      expect(firstObserved.responses).toHaveLength(1);
      expect(firstObserved.toolCalls).toEqual([]);
      expect(firstObserved.toolResults).toEqual([]);
      expect(firstObserved.toolEvents).toEqual([]);
      expect(firstObserved.lateEvents).toEqual([]);
      expect(firstObserved.chunks.join('')).toBe(evidence.expectedProviderSemantic.visibleContent);
      const ortCountAfterFirst = harness.observations.ortCalls.length;
      secondCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-135M-Instruct",
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
      expect(stoppedInputs).toHaveLength(1);
      const native = stoppedInputs[0];
      if (!native) throw new Error('Independent input-only inference was not observed');
      const tokenizer = native.tokenizer;
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(inputEvidence.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(nextMessages, { tokenize: false, add_generation_prompt: true })).toBe(nextPrompt);
      const ids = tokenizer.encode(nextPrompt, { add_special_tokens: false });
      if (!native.input.isTensor || !native.mask.isTensor) throw new Error('Expected actual next-input tensors');
      expect(native.input.type).toBe('int64');
      expect(native.input.location).toBe('cpu');
      expect(native.input.dims).toEqual([1, ids.length]);
      expect(Array.from(native.input.data, Number)).toEqual(ids);
      expect(native.mask.type).toBe('int64');
      expect(native.mask.location).toBe('cpu');
      expect(native.mask.dims).toEqual([1, ids.length]);
      expect(Array.from(native.mask.data, BigInt)).toEqual(ids.map(() => 1n));
      expect(native.pastIsNull).toBe(true);
      const secondObserved = secondCapture.snapshot();
      expect(secondObserved.settlement).toMatchObject({ status: 'rejected' });
      expect(secondObserved.preStartChunks).toEqual([]);
      expect(secondObserved.responses).toHaveLength(1);
      expect(secondObserved.toolCalls).toEqual([]);
      expect(secondObserved.toolResults).toEqual([]);
      expect(secondObserved.toolEvents).toEqual([]);
      expect(secondObserved.lateEvents).toEqual([]);
      const secondChunks = secondObserved.chunks;
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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('independent: keeps a new conversation independent after settled requests in the same runtime', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn","continuity","independent-next-input"],
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Template probe user message.",
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual([`\
"Dear Hugging Face,

I hope this message finds you well.`]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Template probe user message.",
              },
              {
                role: "assistant",
                content: firstResponse,
              },
              {
                role: "user",
                content: "Continue the synthetic conversation with a short response.",
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["\"I'm glad to hear that you're doing well. I've been meaning"]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "A separate synthetic capture conversation.",
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["I"]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
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

describe('SmolLM2 135M Provider / reasoning', () => {
  it('reasoning: preserves the recorded none-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-none"],
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Template probe user message.",
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["\""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
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
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Template probe user message.",
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["\""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
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
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Template probe user message.",
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["\""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
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
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Template probe user message.",
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["\""]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
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

describe('SmolLM2 135M Provider / tools', () => {
  it("tools-generation preserves arguments up to a template that does not render tool definitions or calls", async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    const nativeInputs: ReturnType<typeof captureSmol135NativeInput>[] = [];
    const scenario = toolInputEvidence.cases.find((item): boolean => item.caseId === "tools-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'SmolLM2 135M tool input inspected; no inference output supplied';
    let actualTokenizer: Parameters<ProviderReplayGenerate>[0]['tokenizer'] | undefined;
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }));
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
    const harness = await createProviderReplayTestRuntime({
      modelId: toolInputEvidence.modelId, expectedRevision: toolInputEvidence.revision, cacheRevision: toolInputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: createSyntheticModelBody({ modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, path: 'onnx/model_q4f16.onnx' }) }],
      generate: async context => {
        nativeInputs.push(captureSmol135NativeInput(context));
        actualTokenizer = context.tokenizer;
        // No captured output is supplied at this observation-only boundary.
        throw new Error(boundary);
      },
    });
    // A call-through spy observes the actual inherited method without replacing
    // its receiver, arguments, result, tokenizer instance or native tokenization.
    const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: toolInputEvidence.modelId,
          messages: [
            {
              role: "user",
              content: "Use the weather tool for Tokyo.",
            },
          ],
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
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
      expect(nativeInputs).toHaveLength(1);
      const native = nativeInputs[0];
      if (!native) throw new Error('Input-only inference was not observed');
      if (!native.input.isTensor || !native.mask.isTensor) {
        throw new Error('Expected actual SmolLM2 135M tokenizer tensors');
      }
      expect(native.input.type).toBe('int64');
      expect(native.input.location).toBe('cpu');
      expect(native.input.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(Array.from(native.input.data, Number)).toEqual(scenario.inputTokenIds);
      expect(native.mask.type).toBe('int64');
      expect(native.mask.location).toBe('cpu');
      expect(native.mask.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(Array.from(native.mask.data, BigInt)).toEqual(scenario.inputTokenIds.map(() => 1n));
      // Nothing was generated in this matrix capture. Neither streamer tokens
      // nor fabricated return sequences/KV are released at this boundary.
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(chunks).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(capture?.snapshot().toolCalls).toEqual([]);
      expect(capture?.snapshot().toolResults).toEqual([]);

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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }

  }, 30_000);
  it("tool-result-continuation preserves arguments up to a template that does not render tool definitions or calls", async () => {
    const captures: ProviderChatCapture[] = [];
    let capture: ProviderChatCapture | undefined;
    const nativeInputs: ReturnType<typeof captureSmol135NativeInput>[] = [];
    const scenario = toolInputEvidence.cases.find((item): boolean => item.caseId === "tool-result-continuation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'SmolLM2 135M tool input inspected; no inference output supplied';
    let actualTokenizer: Parameters<ProviderReplayGenerate>[0]['tokenizer'] | undefined;
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }));
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
    const harness = await createProviderReplayTestRuntime({
      modelId: toolInputEvidence.modelId, expectedRevision: toolInputEvidence.revision, cacheRevision: toolInputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: createSyntheticModelBody({ modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, path: 'onnx/model_q4f16.onnx' }) }],
      generate: async context => {
        nativeInputs.push(captureSmol135NativeInput(context));
        actualTokenizer = context.tokenizer;
        // No captured output is supplied at this observation-only boundary.
        throw new Error(boundary);
      },
    });
    // A call-through spy observes the actual inherited method without replacing
    // its receiver, arguments, result, tokenizer instance or native tokenization.
    const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: toolInputEvidence.modelId,
          messages: [
            {
              role: "user",
              content: "Use the weather tool for Tokyo.",
            },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: toToolCallId({ raw: "call_template_probe_1" }),
                  type: "function",
                  function: {
                    name: "lookup_weather",
                    arguments: "{\"city\":\"Tokyo\"}",
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: toToolCallId({ raw: "call_template_probe_1" }),
              content: "{\"temperatureC\":20,\"condition\":\"clear\"}",
            },
          ],
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
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.responses).toHaveLength(1);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      const chunks = observed.chunks;
      expect(nativeInputs).toHaveLength(1);
      const native = nativeInputs[0];
      if (!native) throw new Error('Input-only inference was not observed');
      if (!native.input.isTensor || !native.mask.isTensor) {
        throw new Error('Expected actual SmolLM2 135M tokenizer tensors');
      }
      expect(native.input.type).toBe('int64');
      expect(native.input.location).toBe('cpu');
      expect(native.input.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(Array.from(native.input.data, Number)).toEqual(scenario.inputTokenIds);
      expect(native.mask.type).toBe('int64');
      expect(native.mask.location).toBe('cpu');
      expect(native.mask.dims).toEqual([1, scenario.inputTokenIds.length]);
      expect(Array.from(native.mask.data, BigInt)).toEqual(scenario.inputTokenIds.map(() => 1n));
      // Nothing was generated in this matrix capture. Neither streamer tokens
      // nor fabricated return sequences/KV are released at this boundary.
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(chunks).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(capture?.snapshot().toolCalls).toEqual([]);
      expect(capture?.snapshot().toolResults).toEqual([]);

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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }

  }, 30_000);
  it('tools: preserves the recorded minimal no-call response without claiming model-wide non-support', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["natural-tool-minimal"],
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
        const captureHolder: { current: ProviderChatCapture | undefined } = { current: undefined };
        const executions: { args: unknown; signal: AbortSignal | undefined }[] = [];
        const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.",
          parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args, signal: receivedSignal }) => {
            executions.push({ args: structuredClone(args), signal: receivedSignal });
            if (captureHolder.current?.snapshot().settlement.status !== 'pending') lateExecutions.push('execute');
            return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
          },
        }];
        replay.beginNativeRequest({ caseId: "natural-tool-minimal", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Use the weather tool for Tokyo.",
              },
            ],
            parameters,
            tools: tools,
            signal,
          },
        });
        captureHolder.current = capture;
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["I'm sorry for the misunderstanding, but as a weather-related AI, I don't have the capability to access real-time weather data. I recommend using a weather-related service like Weather.com, the Japan Meteorological Agency, or the National Weather Service."]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
        expect(executions).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(lateExecutions).toEqual([]);
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('tools: preserves the recorded representative no-call response without claiming model-wide non-support', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["natural-tool-representative"],
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
        const captureHolder: { current: ProviderChatCapture | undefined } = { current: undefined };
        const executions: { args: unknown; signal: AbortSignal | undefined }[] = [];
        const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.",
          parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args, signal: receivedSignal }) => {
            executions.push({ args: structuredClone(args), signal: receivedSignal });
            if (captureHolder.current?.snapshot().settlement.status !== 'pending') lateExecutions.push('execute');
            return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
          },
        }];
        replay.beginNativeRequest({ caseId: "natural-tool-representative", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Use lookup_weather for Tokyo, then give a short answer based on the tool result.",
              },
            ],
            parameters,
            tools: tools,
            signal,
          },
        });
        captureHolder.current = capture;
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["I'm sorry for the misunderstanding, but as a weather-related AI, I don't have the capability to provide a lookup-weather response. I'd recommend using the weather-related tool, such as the one provided by Hugging Face, to get the weather information."]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
        expect(executions).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(lateExecutions).toEqual([]);
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('tools: preserves structured caller history and the recorded response', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["structured-tool-history"],
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
        const captureHolder: { current: ProviderChatCapture | undefined } = { current: undefined };
        const executions: { args: unknown; signal: AbortSignal | undefined }[] = [];
        const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.",
          parametersSchema: z.object({ city: z.string() }),
          execute: async ({ args, signal: receivedSignal }) => {
            executions.push({ args: structuredClone(args), signal: receivedSignal });
            if (captureHolder.current?.snapshot().settlement.status !== 'pending') lateExecutions.push('execute');
            return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
          },
        }];
        replay.beginNativeRequest({ caseId: "structured-tool-history", parameters });
        const capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Use the weather tool for Tokyo.",
              },
              {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: toToolCallId({ raw: "call_model_support_probe_1" }),
                    type: "function",
                    function: {
                      name: "lookup_weather",
                      arguments: "{\"city\":\"Tokyo\"}",
                    },
                  },
                ],
              },
              {
                role: "tool",
                content: "{\"temperatureC\":20,\"condition\":\"clear\"}",
                tool_call_id: toToolCallId({ raw: "call_model_support_probe_1" }),
              },
            ],
            parameters,
            tools: tools,
            signal,
          },
        });
        captureHolder.current = capture;
        captures.push(capture);
        await capture.completion;
        replay.endNativeRequest();
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["You are a helpful AI named Huggs, trained by Hugging Face."]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
        expect(executions).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(lateExecutions).toEqual([]);
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
});

describe('SmolLM2 135M Provider / images', () => {
  it('images: preserves the recorded text-only native handling of an image-bearing request', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["image"],
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: "Describe the single synthetic image in one short phrase.",
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                    },
                  },
                ],
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["I"]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
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

describe('SmolLM2 135M Provider / sequences', () => {
  it('uses only the settled first callback text for a second request in the same loaded runtime', async () => {
    const captures: ProviderChatCapture[] = [];
    let firstCapture: ProviderChatCapture | undefined;
    let secondCapture: ProviderChatCapture | undefined;
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
      modelId: 'HuggingFaceTB/SmolLM2-135M-Instruct', expectedRevision: evidence.identity.resolvedRevision, cacheRevision: evidence.identity.resolvedRevision, metadataCache: "all-fixture", imagePlatform: undefined,
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path: 'onnx/model_q4f16.onnx' }) }],
      generate: async context => {
        const next = invocations.shift();
        if (!next) throw new Error('Unexpected extra inference in two-turn replay');
        return next(context);
      },
    });
    try {
      firstCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-135M-Instruct",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
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
      const firstObserved = firstCapture.snapshot();
      expect(firstObserved.settlement).toMatchObject({ status: 'fulfilled' });
      expect(firstObserved.preStartChunks).toEqual([]);
      expect(firstObserved.responses).toHaveLength(1);
      expect(firstObserved.toolCalls).toEqual([]);
      expect(firstObserved.toolResults).toEqual([]);
      expect(firstObserved.toolEvents).toEqual([]);
      expect(firstObserved.lateEvents).toEqual([]);
      const firstChunks = firstObserved.chunks;
      // Immutable at settlement: late first callbacks cannot rewrite the next
      // request. There is no timer, callback drain, or artificial callback ACK.
      const firstTextAtSettlement = firstChunks.join('');
      const ortCountAfterFirst = harness.observations.ortCalls.length;
      let secondOutcome: { status: 'fulfilled' } | { status: 'rejected', error: unknown };
      try {
        secondCapture = captureProviderChat({
          provider: harness.provider,
          request: {
            model: "hf.co/HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              ...evidence.scenario.messages,
              {
                role: 'assistant',
                content: firstTextAtSettlement,
              },
              {
                role: 'user',
                content: 'Continue with one short sentence.',
              },
            ],
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
        captures.push(secondCapture);
        await secondCapture.completion;
        secondOutcome = { status: 'fulfilled' };
      } catch (error) {
        secondOutcome = { status: 'rejected', error };
      }
      // The collector's completion owns settlement; disposal below separately
      // checks for later delivered callbacks without a timer or drain.
      const secondObserved = secondCapture?.snapshot();
      expect(secondObserved?.settlement).toMatchObject({ status: 'fulfilled' });
      expect(secondObserved?.preStartChunks).toEqual([]);
      expect(secondObserved?.responses).toHaveLength(1);
      expect(secondObserved?.toolCalls).toEqual([]);
      expect(secondObserved?.toolResults).toEqual([]);
      expect(secondObserved?.toolEvents).toEqual([]);
      expect(secondObserved?.lateEvents).toEqual([]);
      const secondTextAtSettlement = secondObserved?.chunks.join('');
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
      expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('sequences: builds continuation from actually delivered first-request settlement', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn","continuity"],
      artifactPaths: ["onnx/model_q4f16.onnx"],
      imagePlatform: undefined,
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Template probe user message.",
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual([`\
"Dear Hugging Face,

I hope this message finds you well.`]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
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
            model: "HuggingFaceTB/SmolLM2-135M-Instruct",
            messages: [
              {
                role: "user",
                content: "Template probe user message.",
              },
              {
                role: "assistant",
                content: firstResponse,
              },
              {
                role: "user",
                content: "Continue the synthetic conversation with a short response.",
              },
            ],
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
        const { responses, preStartChunks: earlyChunks, toolCalls: calls, toolResults: results, toolEvents } = observed;
        const order = observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind);
        expect(responses.map(chunks => chunks.join(''))).toEqual(["\"I'm glad to hear that you're doing well. I've been meaning"]);
        expect(order).toEqual(["assistant-start", "settled"]);
        expect(earlyChunks).toEqual([]);
        expect(toolEvents).toEqual([]);
        expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
        expect(calls).toEqual([]);
        expect(results).toEqual([]);
      }
      replay.assertComplete({ requests: 2, nativeCalls: 2 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('preserves all thirteen causal inputs, native streams and Provider settlements in one Load', async () => {
    const fullEvidenceJson = assembleProviderSequenceEvidence({ catalog: providerReplayCatalog });
    expect(fullEvidenceJson.modelId).toBe('HuggingFaceTB/SmolLM2-135M-Instruct');
    expect(fullEvidenceJson.metadataRevision).toBe('12fd25f77366fa6b3b4b768ec3050bf629380bac');
    expect(fullEvidenceJson.observedCacheRevision).toBe('12fd25f77366fa6b3b4b768ec3050bf629380bac');
    await verifyCapturedFullReplay({ reviewedPublicContract: undefined, unavailableOutputs: [], completeResult: undefined, expectedLoadReceipt: undefined, evidence: fullEvidenceJson, imagePlatform: undefined, artifactPaths: ['onnx/model_q4f16.onnx'] });
  }, 30_000);
});
