// @vitest-environment node
import { providerReplayCatalog } from './provider-evidence-catalog';
import { assembleProviderSequenceEvidence } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';
import { createProviderRequestReplay } from '@/features/transformers-js/replay-models/support/provider-replay-request';
import { verifyCapturedFullReplay } from '@/features/transformers-js/replay-models/support/provider-replay-test-captured-full';
import { runProviderReplayTurn, createReplayImageAttachment, closeProviderReplayCaptures } from '@/features/transformers-js/replay-models/support/provider-replay-chat';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toMessageId, toToolCallId } from '@/01-models/ids';
import evidenceJson from './provider-prefix-output.evidence.json';
import continuityJson from './provider-supplied-history-prefix.evidence.json';
import inputJson from './provider-template-inputs.evidence.json';
import toolInputJson from './provider-template-tool-inputs.evidence.json';
import { parseProviderReplayTextEvidence, replayRecordedText } from '@/features/transformers-js/replay-models/support/provider-replay-test-causal-gate';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import { captureProviderChat, type ProviderChatCapture, type CapturedChatRequest } from '@/features/transformers-js/replay-models/support/capture-provider-chat';

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

// Input-only observations copy native storage before controlled rejection.
function captureSmol17NativeInput({ options, tokenizer, runtime }: Parameters<ProviderReplayGenerate>[0]) {
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

describe('SmolLM2 1.7B Provider / basic', () => {
  it('preserves the recorded first user input without supplying any output tokens', async () => {
    const nativeInputs: ReturnType<typeof captureSmol17NativeInput>[] = [];
    const source = evidence;
    expect(source.identity.resolvedRevision).toBe('31b70e2e869a7173562077fd711b654946d38674');
    expect(source.scenario.messages).toEqual([{ role: 'user', content: 'Template probe user message.' }]);
    expect(source.scenario.tools).toEqual([]);
    const stop = 'smollm2-1.7b first Production input verified; no output tokens supplied';
    const harness = await createProviderReplayTestRuntime({
      modelId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', expectedRevision: source.identity.resolvedRevision, cacheRevision: source.identity.resolvedRevision, metadataCache: "all-fixture", imagePlatform: undefined,
      // Identifiable synthetic bodies replace native weight execution only.
      artifacts: ['onnx/model_q4f16.onnx'].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', revision: source.identity.resolvedRevision, path }),
      })),
      generate: async context => {
        nativeInputs.push(captureSmol17NativeInput(context));
        // This observation-only boundary never supplies inference output.
        throw new Error(stop);
      },
    });
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-1.7B-Instruct",
          messages: [
            { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
          ],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 16,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: { effort: undefined },
          },
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined
        },
      });
      await capture.completion;
      expect(capture.snapshot().result).toMatchObject({ type: 'error', error: { message: stop } });
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
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'fulfilled' });
      expect(observed.parts.filter(part => part.type === 'text').flatMap(part => part.chunks)).toEqual([]);
      expect(observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.ortCalls).toHaveLength(1);
      expect(harness.observations.processors).toHaveLength(0);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await closeProviderReplayCaptures({ captures: [capture], close: () => harness.close() });
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
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-1.7B-Instruct",
          messages: [
            { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
          ],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 16,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: { effort: undefined },
          },
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined
        },
      });
      await capture.completion;
      const observed = capture.snapshot();
      // The original recorded prefix is still partial: native EOF does not
      // imply completion without the model's end token.
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual([`\
Sure, here's a sample message for a template:

"Hello!`]);
      expect(observed.parts.filter(part => part.type === 'text').flatMap(part => part.chunks)).toEqual([
        '', 'Sure', ', ', "here's ", "a ", "sample ", "message ", "for ", "a ", "template:\n", "\n", "\"Hello!",
      ]);
      expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
      expect(observed.parts.filter(part => part.type === 'text').map(part => part.completeness)).toEqual(['partial']);
      expect(releasedTokenCount).toBe(16);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => item.operation.startsWith('writer') || item.operation.startsWith('create') || item.operation === 'remove')).toEqual([]);
      expect(observed.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(['part', 'part-complete', 'settled']);
      expect(observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
    } finally {
      await closeProviderReplayCaptures({ captures: [capture], close: () => harness.close() });
    }
  }, 30_000);
  it('basic: delivers the recorded first-turn text through structured parts before settlement', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["first-turn"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      // first-turn: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "first-turn", parameters });
        capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
            messages: [
              { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
            ],
            tools: [],
            parameters,
            signal,
            readBinaryObject: undefined,
            debug: undefined
          },
        });
        await capture.completion;
        const observed = capture.snapshot();
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.completeness)).toEqual(['partial']);
        replay.endNativeRequest();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual([`\
Sure, here's a sample message for a template:

"Hello!`]);
        expect(observed.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(["part", "part-complete", "settled"]);
        expect(observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures: [capture], close: () => replay.close() });
    }
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / system', () => {
  it('system: preserves instructions and delivers the recorded text through structured parts', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["system-user"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      // system-user: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "system-user", parameters });
        capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
            messages: [
              { id: toMessageId({ raw: 'message_0' }), role: 'system', parts: [{ type: 'text', text: "Template probe system instruction.", completeness: 'complete' }] },
              { id: toMessageId({ raw: 'message_1' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
            ],
            tools: [],
            parameters,
            signal,
            readBinaryObject: undefined,
            debug: undefined
          },
        });
        await capture.completion;
        const observed = capture.snapshot();
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.completeness)).toEqual(['partial']);
        replay.endNativeRequest();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual(["User"]);
        expect(observed.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(["part", "part-complete", "settled"]);
        expect(observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures: [capture], close: () => replay.close() });
    }
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / history', () => {
  it("system-user-generation matches the original native input through public Provider", async () => {
    const nativeInputs: ReturnType<typeof captureSmol17NativeInput>[] = [];
    const scenario = inputEvidence.cases.find((item): boolean => item.caseId === "system-user-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'Smol1.7 native input verified; generation intentionally not replayed';
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      // Identifiable tiny bytes replace native weight execution only.
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path: 'onnx/model_q4f16.onnx' }) }],
      generate: async context => {
        nativeInputs.push(captureSmol17NativeInput(context));
        // This observation-only boundary never supplies inference output.
        throw new Error(boundary);
      },
    });
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [
            { id: toMessageId({ raw: 'message_0' }), role: 'system', parts: [{ type: 'text', text: "Template probe system instruction.", completeness: 'complete' }] },
            { id: toMessageId({ raw: 'message_1' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
          ],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 1,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: { effort: undefined },
          },
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined
        },
      });
      await capture.completion;
      expect(capture.snapshot().result).toMatchObject({ type: 'error', error: { message: boundary } });
      expect(nativeInputs).toHaveLength(1);
      const native = nativeInputs[0];
      if (!native) throw new Error('Input-only inference was not observed');
      const tokenizer = native.tokenizer;
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(inputEvidence.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: scenario.addGenerationPrompt })).toBe(scenario.renderedText);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: true, add_generation_prompt: scenario.addGenerationPrompt, return_tensor: false, return_dict: false })).toEqual(scenario.inputTokenIds);
      if (!native.input.isTensor || !native.mask.isTensor) {
        throw new Error('Expected actual Smol1.7 tokenizer tensors');
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
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'fulfilled' });
      expect(observed.parts.filter(part => part.type === 'text').flatMap(part => part.chunks)).toEqual([]);
      expect(observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
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
      await closeProviderReplayCaptures({ captures: [capture], close: () => harness.close() });
    }

  }, 30_000);
  it("multi-turn-generation matches the original native input through public Provider", async () => {
    const nativeInputs: ReturnType<typeof captureSmol17NativeInput>[] = [];
    const scenario = inputEvidence.cases.find((item): boolean => item.caseId === "multi-turn-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'Smol1.7 native input verified; generation intentionally not replayed';
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      // Identifiable tiny bytes replace native weight execution only.
      artifacts: [{ path: 'onnx/model_q4f16.onnx', bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path: 'onnx/model_q4f16.onnx' }) }],
      generate: async context => {
        nativeInputs.push(captureSmol17NativeInput(context));
        // This observation-only boundary never supplies inference output.
        throw new Error(boundary);
      },
    });
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: [
            { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe first user message.", completeness: 'complete' }] },
            { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ type: 'text', text: "Template probe assistant response.", completeness: 'complete' }] },
            { id: toMessageId({ raw: 'message_2' }), role: 'user', parts: [{ type: 'text', text: "Template probe second user message.", completeness: 'complete' }] }
          ],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 1,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: { effort: undefined },
          },
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined
        },
      });
      await capture.completion;
      expect(capture.snapshot().result).toMatchObject({ type: 'error', error: { message: boundary } });
      expect(nativeInputs).toHaveLength(1);
      const native = nativeInputs[0];
      if (!native) throw new Error('Input-only inference was not observed');
      const tokenizer = native.tokenizer;
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(inputEvidence.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: scenario.addGenerationPrompt })).toBe(scenario.renderedText);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: true, add_generation_prompt: scenario.addGenerationPrompt, return_tensor: false, return_dict: false })).toEqual(scenario.inputTokenIds);
      if (!native.input.isTensor || !native.mask.isTensor) {
        throw new Error('Expected actual Smol1.7 tokenizer tensors');
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
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'fulfilled' });
      expect(observed.parts.filter(part => part.type === 'text').flatMap(part => part.chunks)).toEqual([]);
      expect(observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
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
      await closeProviderReplayCaptures({ captures: [capture], close: () => harness.close() });
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
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-1.7B-Instruct",
          messages: [
            { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] },
            { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ type: 'text', text: `\
Sure, here's a sample message for a template:

"Hello!`, completeness: 'complete' }] },
            { id: toMessageId({ raw: 'message_2' }), role: 'user', parts: [{ type: 'text', text: "Continue with one short sentence.", completeness: 'complete' }] }
          ],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 16,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: { effort: undefined },
          },
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined
        },
      });
      await capture.completion;
      const observed = capture.snapshot();
      expect(releasedTokenCount).toBe(13);
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual([`\
I'm excited to help you with your project or idea.`]);
      expect(observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // The part begins empty, then the native streamer flushes its first text
      // token immediately. The original end token completes the part without
      // becoming text. Supplied history does not prove KV-cache reuse.
      expect(observed.parts.filter(part => part.type === 'text').flatMap(part => part.chunks)).toEqual([
        '', 'I', "'m ", 'excited ', 'to ', 'help ', 'you ', 'with ', 'your ', 'project ', 'or ', 'idea.',
      ]);
      expect(observed.result).toEqual({ type: 'finished', next: 'user' });
      expect(observed.parts.filter(part => part.type === 'text').map(part => part.completeness)).toEqual(['complete']);
    } finally {
      await closeProviderReplayCaptures({ captures: [capture], close: () => harness.close() });
    }
  }, 30_000);
  it('history: preserves supplied history and delivers the recorded text through structured parts', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["supplied-history"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      // supplied-history: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "supplied-history", parameters });
        capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
            messages: [
              { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe first user message.", completeness: 'complete' }] },
              { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ type: 'text', text: "Template probe assistant response.", completeness: 'complete' }] },
              { id: toMessageId({ raw: 'message_2' }), role: 'user', parts: [{ type: 'text', text: "Template probe second user message.", completeness: 'complete' }] }
            ],
            tools: [],
            parameters,
            signal,
            readBinaryObject: undefined,
            debug: undefined
          },
        });
        await capture.completion;
        const observed = capture.snapshot();
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.completeness)).toEqual(['partial']);
        replay.endNativeRequest();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual(["Template"]);
        expect(observed.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(["part", "part-complete", "settled"]);
        expect(observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures: [capture], close: () => replay.close() });
    }
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / independent', () => {
  it('keeps an independent next input free of prior text in the same null-KV loaded runtime', async () => {
    const nativeInputs: ReturnType<typeof captureSmol17NativeInput>[] = [];
    const nextMessages: ChatMessage[] = [
      { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: 'A separate synthetic conversation.', completeness: 'complete' }] }
    ];
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
        nativeInputs.push(captureSmol17NativeInput(context));
        // This observation-only boundary never supplies inference output.
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
    const captures: ProviderChatCapture[] = [];
    try {
      const firstCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-1.7B-Instruct",
          messages: [
            { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
          ],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 16,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: { effort: undefined },
          },
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;
      const firstObserved = firstCapture.snapshot();
      expect(firstObserved.settlement).toEqual({ status: 'fulfilled' });
      expect(firstObserved.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      const ortCountAfterFirst = harness.observations.ortCalls.length;
      const secondCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-1.7B-Instruct",
          messages: nextMessages,
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 1,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: { effort: undefined },
          },
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined
        },
      });
      captures.push(secondCapture);
      await secondCapture.completion;
      expect(secondCapture.snapshot().result).toMatchObject({ type: 'error', error: { message: stop } });
      expect(nativeInputs).toHaveLength(1);
      const native = nativeInputs[0];
      if (!native) throw new Error('Input-only inference was not observed');
      const tokenizer = native.tokenizer;
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(inputEvidence.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template([{ role: 'user', content: 'A separate synthetic conversation.' }], { tokenize: false, add_generation_prompt: true })).toBe(nextPrompt);
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
      // No captured response exists for this changed input. This tests input
      // isolation with null KV, not native KV invalidation or generation.
      const secondObserved = secondCapture.snapshot();
      expect(firstReleased).toBe(16);
      expect(secondObserved.settlement).toMatchObject({ status: 'fulfilled' });
      expect(secondObserved!.parts.filter(part => part.type === 'text').flatMap(part => part.chunks)).toEqual([]);
      expect(secondObserved!.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
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
      await closeProviderReplayCaptures({ captures: captures, close: () => harness.close() });
    }
  }, 30_000);
  it('independent: keeps a new conversation independent after settled requests in the same runtime', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["first-turn","continuity","independent-next-input"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
    const captures: ProviderChatCapture[] = [];
    let firstResponse = '';
    try {
      // first-turn: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "first-turn", parameters });
        const firstCapture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
            messages: [
              { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
            ],
            tools: [],
            parameters,
            signal,
            readBinaryObject: undefined,
            debug: undefined
          },
        });
        captures.push(firstCapture);
        await firstCapture.completion;
        replay.endNativeRequest();
        const firstObserved = firstCapture.snapshot();
        expect(firstObserved.settlement).toEqual({ status: 'fulfilled' });
        expect(firstObserved.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual([`\
Sure, here's a sample message for a template:

"Hello!`]);
        expect(firstObserved.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(["part", "part-complete", "settled"]);
        expect(firstObserved.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
        firstResponse = firstObserved.parts.filter(part => part.type === 'text').map(part => part.chunks)[0]!.join('');
      }
      // continuity: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "continuity", parameters });
        const continuityCapture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
            messages: [
              { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] },
              { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ type: 'text', text: firstResponse, completeness: 'complete' }] },
              { id: toMessageId({ raw: 'message_2' }), role: 'user', parts: [{ type: 'text', text: "Continue the synthetic conversation with a short response.", completeness: 'complete' }] }
            ],
            tools: [],
            parameters,
            signal,
            readBinaryObject: undefined,
            debug: undefined
          },
        });
        captures.push(continuityCapture);
        await continuityCapture.completion;
        replay.endNativeRequest();
        const continuityObserved = continuityCapture.snapshot();
        expect(continuityObserved.settlement).toEqual({ status: 'fulfilled' });
        expect(continuityObserved.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual(["\"Great to hear from you! How can I assist you today?\""]);
        expect(continuityObserved.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(["part", "part-complete", "settled"]);
        expect(continuityObserved.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      }
      // independent-next-input: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "independent-next-input", parameters });
        const independentCapture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
            messages: [
              { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "A separate synthetic capture conversation.", completeness: 'complete' }] }
            ],
            tools: [],
            parameters,
            signal,
            readBinaryObject: undefined,
            debug: undefined
          },
        });
        captures.push(independentCapture);
        await independentCapture.completion;
        replay.endNativeRequest();
        const independentObserved = independentCapture.snapshot();
        expect(independentObserved.settlement).toEqual({ status: 'fulfilled' });
        expect(independentObserved.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual(["Sure"]);
        expect(independentObserved.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(["part", "part-complete", "settled"]);
        expect(independentObserved.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      }
      replay.assertComplete({ requests: 3, nativeCalls: 3 });
    } finally {
      await closeProviderReplayCaptures({ captures: captures, close: () => replay.close() });
    }
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / reasoning', () => {
  it('reasoning: preserves the recorded none-effort request and structured text', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["reasoning-none"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      // reasoning-none: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: "none" } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "reasoning-none", parameters });
        capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
            messages: [
              { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
            ],
            tools: [],
            parameters,
            signal,
            readBinaryObject: undefined,
            debug: undefined
          },
        });
        await capture.completion;
        const observed = capture.snapshot();
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.completeness)).toEqual(['partial']);
        replay.endNativeRequest();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual(["Sure"]);
        expect(observed.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(["part", "part-complete", "settled"]);
        expect(observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures: [capture], close: () => replay.close() });
    }
  }, 30_000);
  it('reasoning: preserves the recorded low-effort request and structured text', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["reasoning-low"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      // reasoning-low: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: "low" } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "reasoning-low", parameters });
        capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
            messages: [
              { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
            ],
            tools: [],
            parameters,
            signal,
            readBinaryObject: undefined,
            debug: undefined
          },
        });
        await capture.completion;
        const observed = capture.snapshot();
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.completeness)).toEqual(['partial']);
        replay.endNativeRequest();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual(["Sure"]);
        expect(observed.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(["part", "part-complete", "settled"]);
        expect(observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures: [capture], close: () => replay.close() });
    }
  }, 30_000);
  it('reasoning: preserves the recorded medium-effort request and structured text', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["reasoning-medium"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      // reasoning-medium: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: "medium" } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "reasoning-medium", parameters });
        capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
            messages: [
              { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
            ],
            tools: [],
            parameters,
            signal,
            readBinaryObject: undefined,
            debug: undefined
          },
        });
        await capture.completion;
        const observed = capture.snapshot();
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.completeness)).toEqual(['partial']);
        replay.endNativeRequest();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual(["Sure"]);
        expect(observed.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(["part", "part-complete", "settled"]);
        expect(observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures: [capture], close: () => replay.close() });
    }
  }, 30_000);
  it('reasoning: preserves the recorded high-effort request and structured text', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["reasoning-high"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      // reasoning-high: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: "high" } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "reasoning-high", parameters });
        capture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
            messages: [
              { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
            ],
            tools: [],
            parameters,
            signal,
            readBinaryObject: undefined,
            debug: undefined
          },
        });
        await capture.completion;
        const observed = capture.snapshot();
        expect(observed.result).toEqual({ type: 'interrupted', reason: 'unknown' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.completeness)).toEqual(['partial']);
        replay.endNativeRequest();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        expect(observed.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual(["Sure"]);
        expect(observed.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(["part", "part-complete", "settled"]);
        expect(observed.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      }
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await closeProviderReplayCaptures({ captures: [capture], close: () => replay.close() });
    }
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / tools', () => {
  it("tools-generation rejects before inference while retaining the historical template oracle", async () => {
    const nativeInputs: ReturnType<typeof captureSmol17NativeInput>[] = [];
    const scenario = toolInputEvidence.cases.find((item): boolean => item.caseId === "tools-generation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'SmolLM2 1.7B tool input inspected; no inference output supplied';
    const publicTool: NonNullable<CapturedChatRequest['tools']>[number] = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
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
        nativeInputs.push(captureSmol17NativeInput(context));
        // This observation-only boundary never supplies inference output.
        throw new Error(boundary);
      },
    });
    // A call-through spy observes the actual inherited method without replacing
    // its receiver, arguments, result, tokenizer instance or native tokenization.
    const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
    let capture: ProviderChatCapture | undefined;
    try {
      const request: CapturedChatRequest = {
        model: toolInputEvidence.modelId,
        messages: [
          { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Use the weather tool for Tokyo.", completeness: 'complete' }] }
        ],
        tools: [publicTool],
        parameters: {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 1,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: { effort: undefined },
        },
        readBinaryObject: undefined,
        debug: undefined,
        signal: undefined
      };
      const originalInput = structuredClone({ messages: request.messages, tools: request.tools, parameters: request.parameters });
      capture = captureProviderChat({ provider: harness.provider, request });
      await capture.completion;
      expect(capture.snapshot().result).toMatchObject({ type: 'error', error: { message: 'This standard tool protocol has no structured generation adapter.' } });
      expect(nativeInputs).toEqual([]);
      expect(harness.observations.inferenceCalls).toEqual([]);
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.parts).toEqual([]);
      expect({ messages: request.messages, tools: request.tools, parameters: request.parameters }).toEqual(originalInput);
      const actualTokenizer = templateSpy.mock.contexts[0];

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
      if (!(actualTokenizer instanceof harness.runtime.PreTrainedTokenizer)) throw new Error('Expected the real tokenizer to inspect the unsupported protocol');
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
      await closeProviderReplayCaptures({ captures: [capture], close: () => harness.close() });
    }

  }, 30_000);
  it("tool-result-continuation rejects before inference while retaining the historical template oracle", async () => {
    const nativeInputs: ReturnType<typeof captureSmol17NativeInput>[] = [];
    const scenario = toolInputEvidence.cases.find((item): boolean => item.caseId === "tool-result-continuation");
    if (scenario === undefined) throw new Error('Missing pinned native input case');
    const boundary = 'SmolLM2 1.7B tool input inspected; no inference output supplied';
    const publicTool: NonNullable<CapturedChatRequest['tools']>[number] = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
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
        nativeInputs.push(captureSmol17NativeInput(context));
        // This observation-only boundary never supplies inference output.
        throw new Error(boundary);
      },
    });
    // A call-through spy observes the actual inherited method without replacing
    // its receiver, arguments, result, tokenizer instance or native tokenization.
    const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
    let capture: ProviderChatCapture | undefined;
    try {
      const request: CapturedChatRequest = {
        model: toolInputEvidence.modelId,
        messages: [
          { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Use the weather tool for Tokyo.", completeness: 'complete' }] },
          { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ type: 'text', text: "", completeness: 'complete' },
            { type: 'tool_call', toolCall: {
              id: toToolCallId({ raw: "call_template_probe_1" }),
              type: "function",
              function: {
                name: "lookup_weather",
                arguments: "{\"city\":\"Tokyo\"}",
              },
            } }] },
          { id: toMessageId({ raw: 'message_2' }), role: 'tool', parts: [{ type: 'tool_result', result: { toolCallId: toToolCallId({ raw: "call_template_probe_1" }), status: 'success', content: { type: 'text', text: "{\"temperatureC\":20,\"condition\":\"clear\"}" } } }] }
        ],
        tools: [publicTool],
        parameters: {
          temperature: 0,
          topP: 1,
          maxCompletionTokens: 1,
          presencePenalty: undefined,
          frequencyPenalty: undefined,
          stop: undefined,
          reasoning: { effort: undefined },
        },
        readBinaryObject: undefined,
        debug: undefined,
        signal: undefined
      };
      const originalInput = structuredClone({ messages: request.messages, tools: request.tools, parameters: request.parameters });
      capture = captureProviderChat({ provider: harness.provider, request });
      await capture.completion;
      expect(capture.snapshot().result).toMatchObject({ type: 'error', error: { message: 'This standard tool history has no reviewed structured input adapter.' } });
      expect(nativeInputs).toEqual([]);
      expect(harness.observations.inferenceCalls).toEqual([]);
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.parts).toEqual([]);
      expect({ messages: request.messages, tools: request.tools, parameters: request.parameters }).toEqual(originalInput);
      const actualTokenizer = templateSpy.mock.contexts[0];

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
      expect(productionTokenizations).toEqual([]);
      if (!(actualTokenizer instanceof harness.runtime.PreTrainedTokenizer)) throw new Error('Expected the real tokenizer to inspect the unsupported protocol');
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
      await closeProviderReplayCaptures({ captures: [capture], close: () => harness.close() });
    }

  }, 30_000);
  it('tools: rejects the recorded minimal tool-enabled input before native generation', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["natural-tool-minimal"], artifactPaths: ['onnx/model_q4f16.onnx'], imagePlatform: undefined });
    const parameters: NonNullable<CapturedChatRequest['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
    const executions: { args: unknown; signal: AbortSignal | undefined }[] = [];
    const lateExecutions: string[] = [];
    let settled = false;
    let turn: Awaited<ReturnType<typeof runProviderReplayTurn>> | undefined;
    const tools: Tool[] = [{ name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }),
      execute: async ({ args, signal }) => {
        executions.push({ args: structuredClone(args), signal });
        if (settled) lateExecutions.push('execute');
        return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
      },
    }];
    try {
      replay.beginNativeRequest({ caseId: "natural-tool-minimal", parameters });
      const request: Omit<CapturedChatRequest, 'tools' | 'signal'> = { model: "HuggingFaceTB/SmolLM2-1.7B-Instruct", messages: [
        { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Use the weather tool for Tokyo.", completeness: 'complete' }] }
      ], parameters, debug: undefined, readBinaryObject: undefined };
      const originalInput = structuredClone(request);
      // The ordinary caller runner owns the error and must not execute tools.
      turn = await runProviderReplayTurn({
        onChange: undefined,
        provider: replay.provider,
        tools,
        abortController: new AbortController(),
        request,
      });
      settled = true;
      replay.endRejectedRequest({ outcome: turn.outcome });
      expect(turn.outcome).toMatchObject({ status: 'rejected', error: { message: 'This standard tool protocol has no structured generation adapter.' } });
      expect(request).toEqual(originalInput);
      expect(turn.generated.map(node => node.role)).toEqual(['assistant']);
      const assistant = turn.generated[0];
      if (assistant?.role !== 'assistant') throw new Error('Expected the generated assistant');
      expect(assistant.parts).toEqual([]);
      expect(assistant.interruption).toEqual({ type: 'error', message: 'This standard tool protocol has no structured generation adapter.' });
      expect(turn.toolEvents).toEqual([]);
      expect(executions).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 0 });
    } finally {
      const beforeDisposal = structuredClone(turn);
      await replay.close();
      // Compare the same clone representation on both sides: Comlink Error
      // values can own a name property that structured clone omits.
      expect(structuredClone(turn), 'through awaited Worker disposal').toEqual(beforeDisposal);
      expect(executions).toEqual([]);
      expect(lateExecutions).toEqual([]);
    }
  }, 30_000);
  it('tools: rejects the recorded representative tool-enabled input before native generation', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["natural-tool-representative"], artifactPaths: ['onnx/model_q4f16.onnx'], imagePlatform: undefined });
    const parameters: NonNullable<CapturedChatRequest['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
    const executions: { args: unknown; signal: AbortSignal | undefined }[] = [];
    const lateExecutions: string[] = [];
    let settled = false;
    let turn: Awaited<ReturnType<typeof runProviderReplayTurn>> | undefined;
    const tools: Tool[] = [{ name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }),
      execute: async ({ args, signal }) => {
        executions.push({ args: structuredClone(args), signal });
        if (settled) lateExecutions.push('execute');
        return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
      },
    }];
    try {
      replay.beginNativeRequest({ caseId: "natural-tool-representative", parameters });
      const request: Omit<CapturedChatRequest, 'tools' | 'signal'> = { model: "HuggingFaceTB/SmolLM2-1.7B-Instruct", messages: [
        { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Use lookup_weather for Tokyo, then give a short answer based on the tool result.", completeness: 'complete' }] }
      ], parameters, debug: undefined, readBinaryObject: undefined };
      const originalInput = structuredClone(request);
      // The ordinary caller runner owns the error and must not execute tools.
      turn = await runProviderReplayTurn({
        onChange: undefined,
        provider: replay.provider,
        tools,
        abortController: new AbortController(),
        request,
      });
      settled = true;
      replay.endRejectedRequest({ outcome: turn.outcome });
      expect(turn.outcome).toMatchObject({ status: 'rejected', error: { message: 'This standard tool protocol has no structured generation adapter.' } });
      expect(request).toEqual(originalInput);
      expect(turn.generated.map(node => node.role)).toEqual(['assistant']);
      const assistant = turn.generated[0];
      if (assistant?.role !== 'assistant') throw new Error('Expected the generated assistant');
      expect(assistant.parts).toEqual([]);
      expect(assistant.interruption).toEqual({ type: 'error', message: 'This standard tool protocol has no structured generation adapter.' });
      expect(turn.toolEvents).toEqual([]);
      expect(executions).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 0 });
    } finally {
      const beforeDisposal = structuredClone(turn);
      await replay.close();
      // Compare the same clone representation on both sides: Comlink Error
      // values can own a name property that structured clone omits.
      expect(structuredClone(turn), 'through awaited Worker disposal').toEqual(beforeDisposal);
      expect(executions).toEqual([]);
      expect(lateExecutions).toEqual([]);
    }
  }, 30_000);
  it('tools: rejects structured caller history without executing historical calls', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["structured-tool-history"], artifactPaths: ['onnx/model_q4f16.onnx'], imagePlatform: undefined });
    const parameters: NonNullable<CapturedChatRequest['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
    const executions: { args: unknown; signal: AbortSignal | undefined }[] = [];
    const lateExecutions: string[] = [];
    let settled = false;
    let turn: Awaited<ReturnType<typeof runProviderReplayTurn>> | undefined;
    const tools: Tool[] = [{ name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }),
      execute: async ({ args, signal }) => {
        executions.push({ args: structuredClone(args), signal });
        if (settled) lateExecutions.push('execute');
        return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
      },
    }];
    try {
      replay.beginNativeRequest({ caseId: "structured-tool-history", parameters });
      const request: Omit<CapturedChatRequest, 'tools' | 'signal'> = { model: "HuggingFaceTB/SmolLM2-1.7B-Instruct", messages: [
        { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Use the weather tool for Tokyo.", completeness: 'complete' }] },
        { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ type: 'text', text: "", completeness: 'complete' },
          { type: 'tool_call', toolCall: { id: toToolCallId({ raw: "call_model_support_probe_1" }), type: "function", function: { name: "lookup_weather", arguments: "{\"city\":\"Tokyo\"}" } } }] },
        { id: toMessageId({ raw: 'message_2' }), role: 'tool', parts: [{ type: 'tool_result', result: { toolCallId: toToolCallId({ raw: "call_model_support_probe_1" }), status: 'success', content: { type: 'text', text: "{\"temperatureC\":20,\"condition\":\"clear\"}" } } }] }
      ], parameters, debug: undefined, readBinaryObject: undefined };
      const originalInput = structuredClone(request);
      // The ordinary caller runner owns the error and must not execute tools.
      turn = await runProviderReplayTurn({
        onChange: undefined,
        provider: replay.provider,
        tools,
        abortController: new AbortController(),
        request,
      });
      settled = true;
      replay.endRejectedRequest({ outcome: turn.outcome });
      // The original 128-token stream has no EOS; it is a partial answer.
      expect(turn.outcome).toMatchObject({ status: 'rejected', error: { message: 'This standard tool history has no reviewed structured input adapter.' } });
      expect(request).toEqual(originalInput);
      expect(turn.generated.map(node => node.role)).toEqual(['assistant']);
      const assistant = turn.generated[0];
      if (assistant?.role !== 'assistant') throw new Error('Expected the generated assistant');
      expect(assistant.parts).toEqual([]);
      expect(assistant.interruption).toEqual({ type: 'error', message: 'This standard tool history has no reviewed structured input adapter.' });
      expect(turn.toolEvents).toEqual([]);
      expect(executions).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 0 });
    } finally {
      const beforeDisposal = structuredClone(turn);
      await replay.close();
      // Compare the same clone representation on both sides: Comlink Error
      // values can own a name property that structured clone omits.
      expect(structuredClone(turn), 'through awaited Worker disposal').toEqual(beforeDisposal);
      expect(executions).toEqual([]);
      expect(lateExecutions).toEqual([]);
    }
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / images', () => {
  it('images: rejects the recorded image-bearing input before text-only native generation', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["image"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      // image: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "image", parameters });
        const request: CapturedChatRequest = {
          model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
          messages: [
            { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Describe the single synthetic image in one short phrase.", completeness: 'complete' },
              { type: 'attachment', attachment: createReplayImageAttachment({ dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }) }] }
          ],
          parameters,
          tools: [],
          signal,
          readBinaryObject: undefined,
          debug: undefined
        };
        const originalInput = structuredClone({ messages: request.messages, parameters: request.parameters });
        capture = captureProviderChat({ provider: replay.provider, request });
        await capture.completion;
        const observed = capture.snapshot();
        expect(observed.result).toMatchObject({ type: 'error', error: { message: 'The standard text strategy cannot preserve an image input.' } });
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        expect(observed.parts).toEqual([]);
        expect({ messages: request.messages, parameters: request.parameters }).toEqual(originalInput);
        replay.endRejectedRequest({ outcome: { status: 'fulfilled', result: observed.result } });
      }
      replay.assertComplete({ requests: 1, nativeCalls: 0 });
    } finally {
      await closeProviderReplayCaptures({ captures: [capture], close: () => replay.close() });
    }
  }, 30_000);
});

describe('SmolLM2 1.7B Provider / sequences', () => {
  it('reuses the same runtime for ordinary chat after tool and image operation rejections', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog, caseIds: ['natural-tool-minimal', 'image', 'first-turn'],
      artifactPaths: ['onnx/model_q4f16.onnx'], imagePlatform: undefined,
    });
    const parameters: NonNullable<CapturedChatRequest['parameters']> = {
      temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined,
      frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined },
    };
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }));
    const tools: Tool[] = [{ name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    }];
    const observedTurns: Awaited<ReturnType<typeof runProviderReplayTurn>>[] = [];
    try {
      const toolRequest: Omit<CapturedChatRequest, 'tools' | 'signal'> = {
        model: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', parameters: { ...parameters, maxCompletionTokens: 128 },
        messages: [{ id: toMessageId({ raw: 'tool-user' }), role: 'user', parts: [
          { type: 'text', text: 'Use the weather tool for Tokyo.', completeness: 'complete' },
        ] }], debug: undefined, readBinaryObject: undefined,
      };
      const toolInput = structuredClone(toolRequest);
      replay.beginNativeRequest({ caseId: 'natural-tool-minimal', parameters: toolRequest.parameters! });
      const rejectedTool = await runProviderReplayTurn({
        onChange: undefined,
        provider: replay.provider,
        request: toolRequest,
        tools,
        abortController: new AbortController(),
      });
      observedTurns.push(rejectedTool);
      expect(rejectedTool.outcome).toMatchObject({ status: 'rejected', error: { message: 'This standard tool protocol has no structured generation adapter.' } });
      replay.endRejectedRequest({ outcome: rejectedTool.outcome });
      expect(toolRequest).toEqual(toolInput);
      expect(replay.observations.inferenceCalls).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(replay.service.getState().status).toBe('ready');
      const loadedModel = replay.service.getState().activeModelId;
      const worker = replay.observations.workers[0];
      expect(worker).toBeDefined();

      const imageRequest: Omit<CapturedChatRequest, 'tools' | 'signal'> = {
        model: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', parameters: { ...parameters, maxCompletionTokens: 1 },
        messages: [{ id: toMessageId({ raw: 'image-user' }), role: 'user', parts: [
          { type: 'text', text: 'Describe the single synthetic image in one short phrase.', completeness: 'complete' },
          { type: 'attachment', attachment: createReplayImageAttachment({ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }) },
        ] }], debug: undefined, readBinaryObject: undefined,
      };
      const imageInput = structuredClone(imageRequest);
      replay.beginNativeRequest({ caseId: 'image', parameters: imageRequest.parameters! });
      const rejectedImage = await runProviderReplayTurn({
        onChange: undefined,
        provider: replay.provider,
        request: imageRequest,
        tools: [],
        abortController: new AbortController(),
      });
      observedTurns.push(rejectedImage);
      expect(rejectedImage.outcome).toMatchObject({ status: 'rejected', error: { message: 'The standard text strategy cannot preserve an image input.' } });
      replay.endRejectedRequest({ outcome: rejectedImage.outcome });
      expect(imageRequest).toEqual(imageInput);
      expect(replay.observations.inferenceCalls).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      expect(replay.service.getState()).toMatchObject({ status: 'ready', activeModelId: loadedModel });

      // The unchanged first-turn native input/token gate must still match after
      // both failed operations release their lane. No fresh runtime repairs it.
      replay.beginNativeRequest({ caseId: 'first-turn', parameters });
      const recovered = await runProviderReplayTurn({
        onChange: undefined,
        provider: replay.provider,
        tools: [],
        abortController: new AbortController(),
        request: { model: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', parameters,
          messages: [{ id: toMessageId({ raw: 'plain-user' }), role: 'user', parts: [
            { type: 'text', text: 'Template probe user message.', completeness: 'complete' },
          ] }], debug: undefined, readBinaryObject: undefined },
      });
      observedTurns.push(recovered);
      expect(recovered.outcome).toEqual({ status: 'fulfilled', result: { type: 'interrupted', reason: 'unknown' } });
      expect(recovered.generated).toEqual([expect.objectContaining({ role: 'assistant', interruption: undefined, parts: [
        expect.objectContaining({ type: 'text', completeness: 'partial', text: `\
Sure, here's a sample message for a template:

"Hello!` }),
      ] })]);
      replay.endNativeRequest();
      replay.assertComplete({ requests: 3, nativeCalls: 1 });
      expect(replay.observations.workers[0]).toBe(worker);
      expect(worker?.terminated).toBe(false);
      expect(replay.service.getState()).toMatchObject({ status: 'ready', activeModelId: loadedModel });
      expect(observedTurns.every(turn => turn.toolEvents.length === 0)).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      const beforeDisposal = structuredClone(observedTurns);
      await replay.close();
      expect(structuredClone(observedTurns)).toEqual(beforeDisposal);
      expect(execute).not.toHaveBeenCalled();
    }
  }, 30_000);
  it('uses only the settled first part text for a second request in the same loaded runtime', async () => {
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
    const captures: ProviderChatCapture[] = [];
    try {
      const firstCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-1.7B-Instruct",
          messages: [
            { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
          ],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 16,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: { effort: undefined },
          },
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;
      const firstObserved = firstCapture.snapshot();
      // Immutable at settlement: late first callbacks cannot rewrite the next
      // request. There is no timer, callback drain, or artificial callback ACK.
      const firstTextAtSettlement = firstObserved.parts.filter(part => part.type === 'text').flatMap(part => part.chunks).join('');
      const ortCountAfterFirst = harness.observations.ortCalls.length;
      const secondCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: "hf.co/HuggingFaceTB/SmolLM2-1.7B-Instruct",
          messages: [
            { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: 'Template probe user message.', completeness: 'complete' }] },
            { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ type: 'text', text: firstTextAtSettlement, completeness: 'complete' }] },
            { id: toMessageId({ raw: 'message_2' }), role: 'user', parts: [{ type: 'text', text: 'Continue with one short sentence.', completeness: 'complete' }] }
          ],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 16,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: { effort: undefined },
          },
          readBinaryObject: undefined,
          debug: undefined,
          signal: undefined
        },
      });
      captures.push(secondCapture);
      let secondOutcome: { status: 'fulfilled' } | { status: 'rejected', error: unknown };
      try {
        await secondCapture.completion;
        secondOutcome = { status: 'fulfilled' };
      } catch (error) {
        secondOutcome = { status: 'rejected', error };
      }
      // Direct await, as for turn one; wrapping the promise in another .then
      // would give late callbacks an extra reaction before this snapshot.
      const secondObserved = secondCapture.snapshot();
      const secondTextAtSettlement = secondObserved!.parts.filter(part => part.type === 'text').flatMap(part => part.chunks).join('');
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
      await closeProviderReplayCaptures({ captures: captures, close: () => harness.close() });
    }
  }, 30_000);
  it('sequences: builds continuation from actually delivered first-request settlement', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["first-turn","continuity"], artifactPaths: ["onnx/model_q4f16.onnx"], imagePlatform: undefined });
    const captures: ProviderChatCapture[] = [];
    let firstResponse = '';
    try {
      // first-turn: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "first-turn", parameters });
        const firstCapture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
            messages: [
              { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] }
            ],
            tools: [],
            parameters,
            signal,
            readBinaryObject: undefined,
            debug: undefined
          },
        });
        captures.push(firstCapture);
        await firstCapture.completion;
        const firstObserved = firstCapture.snapshot();
        replay.endNativeRequest();
        expect(firstObserved.settlement).toEqual({ status: 'fulfilled' });
        expect(firstObserved.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual([`\
Sure, here's a sample message for a template:

"Hello!`]);
        expect(firstObserved.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(["part", "part-complete", "settled"]);
        expect(firstObserved.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
        firstResponse = firstObserved.parts.filter(part => part.type === 'text').map(part => part.chunks)[0]!.join('');
      }
      // continuity: public inputs and settled expectations are owned by this model.
      {
        const parameters: NonNullable<Parameters<typeof replay.provider.chat>[0]['parameters']> = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
        const signal = new AbortController().signal;
        replay.beginNativeRequest({ caseId: "continuity", parameters });
        const continuityCapture = captureProviderChat({
          provider: replay.provider,
          request: {
            model: "HuggingFaceTB/SmolLM2-1.7B-Instruct",
            messages: [
              { id: toMessageId({ raw: 'message_0' }), role: 'user', parts: [{ type: 'text', text: "Template probe user message.", completeness: 'complete' }] },
              { id: toMessageId({ raw: 'message_1' }), role: 'assistant', parts: [{ type: 'text', text: firstResponse, completeness: 'complete' }] },
              { id: toMessageId({ raw: 'message_2' }), role: 'user', parts: [{ type: 'text', text: "Continue the synthetic conversation with a short response.", completeness: 'complete' }] }
            ],
            tools: [],
            parameters,
            signal,
            readBinaryObject: undefined,
            debug: undefined
          },
        });
        captures.push(continuityCapture);
        await continuityCapture.completion;
        const continuityObserved = continuityCapture.snapshot();
        replay.endNativeRequest();
        expect(continuityObserved.settlement).toEqual({ status: 'fulfilled' });
        expect(continuityObserved.parts.filter(part => part.type === 'text').map(part => part.chunks.join(''))).toEqual(["\"Great to hear from you! How can I assist you today?\""]);
        expect(continuityObserved.events.filter(event => event.kind !== 'chunk' && event.kind !== 'result').map(event => event.kind)).toEqual(["part", "part-complete", "settled"]);
        expect(continuityObserved.parts.filter(part => part.type === 'tool_call').map(part => part.toolCall)).toEqual([]);
      }
      replay.assertComplete({ requests: 2, nativeCalls: 2 });
    } finally {
      await closeProviderReplayCaptures({ captures: captures, close: () => replay.close() });
    }
  }, 30_000);
  it('preserves thirteen causal requests, native streams and settlements in one Load', async () => {
    const fullEvidenceJson = assembleProviderSequenceEvidence({ catalog: providerReplayCatalog });
    expect(fullEvidenceJson.modelId).toBe('HuggingFaceTB/SmolLM2-1.7B-Instruct');
    expect(fullEvidenceJson.metadataRevision).toBe('31b70e2e869a7173562077fd711b654946d38674');
    expect(fullEvidenceJson.observedCacheRevision).toBe('main');
    // This exact tokenizer/generation config uses token 2 as its end marker.
    // A fulfilled old callback request without it remains a partial generation.
    await verifyCapturedFullReplay({ reviewedPublicContract: { singleTextParts: { endTokenIds: ['2'] }, correctedEvents: [], invalidatedOutputs: [],
      preNativeRejections: [
        { scenario: 'natural-tool-minimal', reason: 'This text model has no reviewed structured tool adapter.' },
        { scenario: 'natural-tool-representative', reason: 'Enabling tool definitions is rejected before generation.' },
        { scenario: 'structured-tool-history', reason: 'The current adapter cannot preserve historical tool associations.' },
        { scenario: 'image', reason: 'The current text adapter rejects images instead of silently discarding them.' },
      ],
    },
    unavailableOutputs: [], completeResult: undefined, expectedLoadReceipt: undefined, evidence: fullEvidenceJson, imagePlatform: undefined, artifactPaths: ["onnx/model_q4f16.onnx"] });
  }, 30_000);
});
