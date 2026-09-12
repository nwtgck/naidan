// @vitest-environment node
import { providerReplayCatalog } from './provider-evidence-catalog';
import { assembleProviderSequenceEvidence, readProviderRequestEvidence, type ProviderReplayCatalog } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';
import { createProviderRequestReplay } from '@/features/transformers-js/replay-models/support/provider-replay-request';
import { parseCapturedFullReplay, replayCapturedFullInvocation, verifyCapturedFullReplay } from '@/features/transformers-js/replay-models/support/provider-replay-test-captured-full';
import completeImage from './provider-image-complete.evidence.json';
import imageOutputContext from './provider-image-output-context.evidence.json';
import imageOutputProvenance from './provider-image-output-provenance.evidence.json';
import imageOutputSequence from './provider-image-output-sequence.evidence.json';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';
import evidenceJson from './provider-legacy-adapter-input.evidence.json';
import inputJson from './provider-template-inputs.evidence.json';
import toolInputJson from './provider-template-tool-inputs.evidence.json';
import productionJson from './provider-legacy-first-prefix.evidence.json';
import continuityJson from './provider-legacy-history-prefix.evidence.json';
import reasoningJson from './provider-legacy-reasoning-prefix.evidence.json';
import { parseProviderReplayTextEvidence, replayRecordedText } from '@/features/transformers-js/replay-models/support/provider-replay-test-causal-gate';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { createProviderReplayTestImagePlatform } from '@/features/transformers-js/replay-models/support/provider-replay-test-image-platform';
import { readModelFixture } from '@/features/transformers-js/replay-models/support/model-runtime-fixture';
import { captureProviderChat, type ProviderChatCapture } from '@/features/transformers-js/replay-models/support/capture-provider-chat';

const messagesSchema = z.array(z.object({ role: z.literal('user'), content: z.string() }).strict()).length(1);
const tokenIdsSchema = z.array(z.number().int().nonnegative().safe());
const evidence = z.object({
  schemaVersion: z.literal(1),
  identity: z.object({ modelId: z.literal('onnx-community/Qwen3.5-2B-ONNX'), resolvedRevision: z.literal('b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb'), transformersJsVersion: z.literal('4.2.0') }).strict(),
  nativeTemplate: z.object({ caseId: z.literal('user-generation'), messages: messagesSchema, addGenerationPrompt: z.literal(true), renderedText: z.string(), inputIds: tokenIdsSchema.length(17) }).strict(),
  productionInput: z.object({
    messages: messagesSchema, inputKeys: z.tuple([z.literal('attention_mask'), z.literal('input_ids')]),
    inputTensors: z.array(z.object({ name: z.enum(['attention_mask', 'input_ids']), dtype: z.literal('int64'), dims: z.tuple([z.literal(1), z.literal(13)]), location: z.literal('cpu') }).strict()).length(2),
    inputTokenIds: tokenIdsSchema.length(13),
    // These are the four recorded request settings, not all merged defaults.
    effectiveGenerationConfig: z.object({ maxNewTokens: z.literal(16), temperature: z.literal(0), topP: z.literal(1), doSample: z.literal(false) }).strict(),
  }).strict(),
}).strict().parse(evidenceJson);

const inputCaseSchema = z.object({
  messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()),
  addGenerationPrompt: z.literal(true),
  selectedTemplateSha256: z.literal('273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80'),
  renderedText: z.string(), inputTokenIds: tokenIdsSchema.min(1),
}).strict();
const inputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('ca28e5780dfc709c8b070324783ef9faf90510285c06698266082073e3e69228'),
  modelId: z.literal('onnx-community/Qwen3.5-2B-ONNX'),
  revision: z.literal('b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb'),
  cases: z.tuple([
    inputCaseSchema.extend({ caseId: z.literal('system-user-generation') }),
    inputCaseSchema.extend({ caseId: z.literal('multi-turn-generation') }),
  ]),
}).strict().parse(inputJson);

const toolUserSchema = z.object({ role: z.literal('user'), content: z.string() }).strict();
const toolCallSchema = z.object({
  id: z.string(), type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }).strict(),
}).strict();
const toolAssistantSchema = z.object({
  role: z.literal('assistant'), content: z.literal(''), tool_calls: z.tuple([toolCallSchema]),
}).strict();
const toolResultSchema = z.object({
  role: z.literal('tool'), content: z.string(), tool_call_id: z.string(),
}).strict();
const nativeToolDefinitionSchema = z.object({
  type: z.literal('function'), function: z.object({
    name: z.literal('lookup_weather'), description: z.literal('Return deterministic weather fixture data.'),
    parameters: z.object({
      type: z.literal('object'), properties: z.object({ city: z.object({ type: z.literal('string') }).strict() }).strict(),
      required: z.tuple([z.literal('city')]),
    }).strict(),
  }).strict(),
}).strict();
const nativeToolCaseSchema = z.object({
  tools: z.tuple([nativeToolDefinitionSchema]), addGenerationPrompt: z.literal(true),
  selectedTemplateSha256: z.literal('273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80'),
}).strict();
const toolInputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('ca28e5780dfc709c8b070324783ef9faf90510285c06698266082073e3e69228'),
  modelId: z.literal('onnx-community/Qwen3.5-2B-ONNX'), revision: z.literal('b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb'),
  cases: z.tuple([
    nativeToolCaseSchema.extend({
      caseId: z.literal('tools-generation'), messages: z.tuple([toolUserSchema]), status: z.literal('passed'),
      renderedText: z.string(), inputTokenIds: tokenIdsSchema.length(276),
    }),
    nativeToolCaseSchema.extend({
      caseId: z.literal('tool-result-continuation'), messages: z.tuple([toolUserSchema, toolAssistantSchema, toolResultSchema]),
      status: z.literal('failed'), failureStage: z.literal('render'),
      error: z.object({ name: z.literal('Error'), message: z.literal('Unknown StringValue filter: items') }).strict(),
    }),
  ]),
}).strict().parse(toolInputJson);
const publicToolDefinitionSchema = z.object({
  type: z.literal('function'), function: z.object({
    name: z.literal('lookup_weather'), description: z.string(),
    parameters: z.object({
      type: z.literal('object'), properties: z.object({ city: z.object({ type: z.literal('string') }).strict() }).strict(),
      required: z.tuple([z.literal('city')]), additionalProperties: z.literal(false),
    }).strict(),
  }).strict(),
}).strict();
const strictQwenTools: [z.infer<typeof publicToolDefinitionSchema>] = [{ type: 'function', function: {
  name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
} }];
const observedBuilderInputSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'tool']), content: z.string(),
    tool_calls: z.tuple([toolCallSchema]).optional(), tool_call_id: z.string().optional(),
  }).strict()),
  tools: z.tuple([publicToolDefinitionSchema]), reasoningMode: z.literal('default'),
}).strict();
const QWEN_TOOL_INPUT_STOP = 'Qwen2B tool input captured; no generated output supplied';

// Input-only observations own CPU data and dimensions, not live Tensor views.
// Undefined snapshots preserve a failed runtime-instance check for postasserts.
function snapshotQwenInput({ context }: { context: Parameters<ProviderReplayGenerate>[0] }) {
  const { options, runtime } = context;
  function tensorSnapshot({ value }: { value: unknown }) {
    if (!(value instanceof runtime.Tensor)) return undefined;
    return {
      type: value.type, dims: [...value.dims], location: value.location,
      data: structuredClone(value.data),
    };
  }
  return {
    model: context.model, tokenizer: context.tokenizer, runtime,
    optionKeys: Object.keys(options).sort(),
    streamerIsTextStreamer: options.streamer instanceof runtime.TextStreamer,
    stoppingCriteriaType: typeof options.stopping_criteria,
    options: {
      ...options,
      input_ids: tensorSnapshot({ value: options.input_ids }),
      attention_mask: tensorSnapshot({ value: options.attention_mask }),
      pixel_values: tensorSnapshot({ value: options.pixel_values }),
      image_grid_thw: tensorSnapshot({ value: options.image_grid_thw }),
      original_sizes: structuredClone(options.original_sizes),
      reshaped_input_sizes: structuredClone(options.reshaped_input_sizes),
    },
  };
}

// Historical Naidan JSON tool protocol retained as a contrast. Native
// uses XML function/parameter tags and additional instructions instead. This
// text is NOT a model-source capture or a claim of equivalent natural tool use.
const qwenJsonToolPrelude = `\
<|im_start|>system
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
${JSON.stringify(strictQwenTools[0])}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call><|im_end|>`;

async function createQwenToolInputReplay() {
  const inputs: ReturnType<typeof snapshotQwenInput>[] = [];
  const generate = vi.fn<ProviderReplayGenerate>(async context => {
    inputs.push(snapshotQwenInput({ context }));
    // No output tokens, fabricated sequences, KV or streamer activity.
    throw new Error(QWEN_TOOL_INPUT_STOP);
  });
  const execute = vi.fn<Tool['execute']>(async () => {
    throw new Error('No natural tool invocation belongs to this input-only capture');
  });
  const publicTool: Tool = {
    name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
    parametersSchema: z.object({ city: z.string() }), execute,
  };
  const harness = await createProviderReplayTestRuntime({
    modelId: toolInputEvidence.modelId, expectedRevision: toolInputEvidence.revision, cacheRevision: toolInputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
    artifacts: [
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
    ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, path }) })),
    generate,
  });
  try {
    await harness.service.loadDownloadedModel({ modelId: toolInputEvidence.modelId });
    expect(harness.observations.processors).toHaveLength(1);
    const processor = harness.observations.processors[0];
    if (!processor?.tokenizer) throw new Error('Actual Qwen processor/tokenizer unavailable');
    expect(processor.constructor.name).toBe('Qwen3VLProcessor');
    expect(processor.tokenizer).toBeInstanceOf(harness.runtime.PreTrainedTokenizer);
    const serializer = await import('@/features/transformers-js/models/qwen3_5');
    const builderSpy = vi.spyOn(serializer, 'buildQwen3_5Prompt');
    const processorSpy = vi.spyOn(processor, '_call');
    return {
      harness, generate, inputs, execute, publicTool, processor, tokenizer: processor.tokenizer, builderSpy, processorSpy,
      async close() {
        processorSpy.mockRestore();
        builderSpy.mockRestore();
        await harness.close();
      },
    };
  } catch (error) {
    try {
      await harness.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Qwen tool fixture setup and cleanup failed', { cause: error });
    }
    throw error;
  }
}

// Qwen-specific observation mechanics shared by the two input scenarios. All
// prompts, native outcomes and semantic expectations remain caller-owned here.
function verifyQwenToolInput({
  replay, messages, publicTool: _publicTool, expectedToolDefinition, expectedPrompt, before }: {
  replay: Awaited<ReturnType<typeof createQwenToolInputReplay>>,
  messages: ChatMessage[],
  publicTool: Tool,
  expectedToolDefinition: z.infer<typeof publicToolDefinitionSchema>,
  expectedPrompt: string, before: number,
}) {
  expect(replay.generate).toHaveBeenCalledTimes(before + 1);
  expect(replay.builderSpy).toHaveBeenCalledTimes(before + 1);
  expect(replay.processorSpy).toHaveBeenCalledTimes(before + 1);
  const call = replay.builderSpy.mock.calls[before];
  if (!call) throw new Error('No actual Qwen builder invocation');
  const { tokenizer: actualTokenizer, ...builderInput } = call[0];
  expect(actualTokenizer).toBe(replay.tokenizer);
  const observed = observedBuilderInputSchema.parse(builderInput);
  const { messages: observedMessages, tools: observedTools, reasoningMode, ...unhandled } = observed;
  unhandled satisfies Record<PropertyKey, never>;
  // Validate raw arguments; canonicalization only removes irrelevant optional
  // field ownness AFTER the call. Missing values/types still fail expectations.
  expect(observedMessages.map(message => {
    const { role, content, tool_calls, tool_call_id, ...rest } = message;
    rest satisfies Record<PropertyKey, never>;
    return { role, content, tool_calls, tool_call_id };
  })).toStrictEqual(messages.map(message => ({
    role: message.role, content: message.content,
    tool_calls: message.tool_calls, tool_call_id: message.tool_call_id,
  })));
  expect(observedTools).toStrictEqual([expectedToolDefinition]);
  expect(reasoningMode).toBe('default');
  // Qwen's actual Callable delegates to this inherited _call. The spy does not
  // replace its receiver/result. Native controls use tokenizer directly, so
  // these ledger entries only describe actual Production processor invocations.
  expect(replay.processorSpy.mock.calls[before]).toStrictEqual([expectedPrompt]);
  expect(replay.inputs).toHaveLength(before + 1);
  const context = replay.inputs[before];
  if (!context) throw new Error('No actual inference boundary');
  const { options, runtime } = context;
  if (!options.input_ids || !options.attention_mask) {
    throw new Error('Expected actual Qwen processor tensors');
  }
  const expectedNative = replay.tokenizer(expectedPrompt);
  expect(expectedNative.input_ids).toBeInstanceOf(runtime.Tensor);
  const ids = Array.from(expectedNative.input_ids.data, Number);
  expect(options.input_ids.type).toBe('int64');
  expect(options.input_ids.location).toBe('cpu');
  expect(options.input_ids.dims).toEqual([1, ids.length]);
  expect(Array.from(options.input_ids.data, Number)).toEqual(ids);
  expect(options.attention_mask.type).toBe('int64');
  expect(options.attention_mask.location).toBe('cpu');
  expect(options.attention_mask.dims).toEqual([1, ids.length]);
  expect(Array.from(options.attention_mask.data, BigInt)).toEqual(ids.map(() => 1n));
  expect(options.past_key_values).toBeNull();
  expect(replay.harness.observations.runtimeAssetFetchCalls).toEqual([replay.harness.observations.expectedRuntimeAssetUrl]);
  expect(replay.harness.observations.localImageFetchCalls).toEqual([]);
  expect(replay.harness.observations.forbiddenTransport).toEqual([]);
  expect(replay.harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  expect(replay.harness.observations.ortCalls.map(([core, options]) => inspectSyntheticOrtSession({
    modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision,
    repositoryPaths: new Set([
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
    ]), core, options,
  })).toSorted((a, b) => a.corePath.localeCompare(b.corePath))).toEqual([
    {
      modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, corePath: 'onnx/decoder_model_merged_q4f16.onnx',
      externalData: [{ path: 'decoder_model_merged_q4f16.onnx_data', artifactPath: 'onnx/decoder_model_merged_q4f16.onnx_data' }], executionProviders: ['webgpu'],
    },
    {
      modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, corePath: 'onnx/embed_tokens_q4f16.onnx',
      externalData: [{ path: 'embed_tokens_q4f16.onnx_data', artifactPath: 'onnx/embed_tokens_q4f16.onnx_data' }], executionProviders: ['webgpu'],
    },
  ]);
}

const recordedQwenCaptureSchema = z.object({
  sourceFacts: z.object({
    inputKeys: z.tuple([z.literal('attention_mask'), z.literal('input_ids')]),
    fullConversationInput: z.object({ status: z.literal('observed'), inputTokenIds: tokenIdsSchema.min(1) }).strict(),
    cacheDecision: z.object({
      status: z.literal('not-reused'),
      reason: z.enum(['qwen3_5-missing-conversation-state', 'qwen3_5-message-count-mismatch']),
    }).strict(),
    pastKeyValuesProvided: z.literal(false),
    inputPastKeyValuesSummary: z.object({
      kind: z.literal('nullish'), valueType: z.literal('null'), ownKeyCount: z.literal(0),
      ownKeys: z.tuple([]), truncated: z.literal(false),
    }).strict(),
  }).strict(),
  streamChunks: z.array(z.string()).min(1), replay: z.unknown(),
}).strict();

function parseRecordedQwenCapture({ value }: { value: unknown }) {
  const { sourceFacts, streamChunks, replay: rawReplay, ...unhandled } = recordedQwenCaptureSchema.parse(value);
  unhandled satisfies Record<PropertyKey, never>;
  const replay = parseProviderReplayTextEvidence({ value: rawReplay });
  expect(replay.identity).toStrictEqual({
    modelId: 'onnx-community/Qwen3.5-2B-ONNX', resolvedRevision: 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb',
    investigationRunId: '18926c5f-50e7-4da8-8395-dd5f4ee5556a', transformersJsVersion: '4.2.0',
  });
  expect(sourceFacts.fullConversationInput.inputTokenIds).toEqual(replay.modelReplay.sourceInputTokenIds);
  expect(streamChunks.join('')).toBe(replay.expectedProviderSemantic.visibleContent);
  return { sourceFacts, streamChunks, replay };
}

const productionSelection = z.object({
  schemaVersion: z.literal(1),
  sourceMemberSha256: z.literal('96447b1b4d0173c0c8006f919755a1a5fd40d973b5c12abded82a5270606c7cf'),
  capture: recordedQwenCaptureSchema,
}).strict().parse(productionJson);
const continuitySelection = z.object({
  schemaVersion: z.literal(1),
  sourceMemberSha256: z.literal('0048d772d051b023df241b54e8d66ca2e4cd063c3176d4d06c04bbf70afcd76e'),
  assistantMessage: z.object({ role: z.literal('assistant'), content: z.string() }).strict(),
  followUpMessage: z.object({ role: z.literal('user'), content: z.string() }).strict(),
  capture: recordedQwenCaptureSchema,
}).strict().parse(continuityJson);
const reasoningSelection = z.object({
  schemaVersion: z.literal(1),
  sourceMemberSha256: z.literal('e8bb944bc4dceb2b8c73530f3fa8dd1ef4f506c3b29268c91e9b7de4d783d198'),
  source: z.literal('existing-production-strategy'), strategy: z.literal('qwen3_5'),
  disabledEffort: z.literal('none'), enabledEffort: z.literal('high'),
  disabled: recordedQwenCaptureSchema, enabled: recordedQwenCaptureSchema,
}).strict().parse(reasoningJson);
const firstQwenCapture = parseRecordedQwenCapture({ value: productionSelection.capture });
const historyQwenCapture = parseRecordedQwenCapture({ value: continuitySelection.capture });
const disabledQwenCapture = parseRecordedQwenCapture({ value: reasoningSelection.disabled });
const enabledQwenCapture = parseRecordedQwenCapture({ value: reasoningSelection.enabled });
const recordedQwenBuilderSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']), content: z.string(),
    tool_calls: z.undefined().optional(), tool_call_id: z.undefined().optional(),
  }).strict()),
  tools: z.undefined(), reasoningMode: z.enum(['default', 'enabled', 'disabled']),
}).strict();

// Independent render expectations for these RECORDED Production inputs, not
// replacement expectations for the native-default/system/history parity tests.
const recordedQwenUserPrompt = `\
<|im_start|>user
Template probe user message.<|im_end|>
<|im_start|>assistant
`;

// Historical source adapter only. It preserves the entire real Provider →
// service → Comlink → Worker → strategy → processor → streamer route while
// substituting the formerly incorrect serializer at this one explicit seam.
// No current Provider output is inferred from these old prompt/output captures.
async function installHistoricalQwenSerializer({ harness, capture, effort, expectedMode, expectedPrompt }: {
  harness: Awaited<ReturnType<typeof createProviderReplayTestRuntime>>,
  capture: ReturnType<typeof parseRecordedQwenCapture>, effort: 'none' | 'high' | undefined,
  expectedMode: 'default' | 'disabled' | 'enabled', expectedPrompt: string,
}) {
  const serializer = await import('@/features/transformers-js/models/qwen3_5');
  const nativeRender = serializer.buildQwen3_5Prompt;
  const nativeGenerate = harness.service.generateText;
  const serviceSpy = vi.spyOn(harness.service, 'generateText').mockImplementation(args => {
    // Reject a changed request before its historical prompt can be substituted.
    expect(args.messages.map(message => ({ role: message.role, content: message.content }))).toStrictEqual(capture.replay.scenario.messages);
    expect(args.tools).toBeUndefined();
    expect(args.params).toStrictEqual({ ...capture.replay.scenario.lmParameters,
      presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort } });
    return Reflect.apply(nativeGenerate, harness.service, [args]);
  });
  const builderSpy = vi.spyOn(serializer, 'buildQwen3_5Prompt').mockImplementation(args => {
    const tokenizer = harness.observations.processors[0]?.tokenizer;
    if (!tokenizer) throw new Error('Historical serializer requires the actual selected tokenizer');
    expect(args.tokenizer).toBe(tokenizer);
    expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe('273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80');
    const { tokenizer: _tokenizer, ...raw } = args;
    const observed = recordedQwenBuilderSchema.parse(raw);
    expect(observed.messages.map(message => ({ role: message.role, content: message.content }))).toStrictEqual(capture.replay.scenario.messages);
    expect(observed.reasoningMode).toBe(expectedMode);
    const nativeText = nativeRender(args);
    const options = expectedMode === 'default' ? {} : { enable_thinking: expectedMode === 'enabled' };
    expect(nativeText).toBe(tokenizer.apply_chat_template(capture.replay.scenario.messages, { tokenize: false, add_generation_prompt: true, ...options }));
    expect(nativeText).not.toBe(expectedPrompt);
    // Reproduce the old no-tool serializer from its actual messages, not a
    // constant return for arbitrary input. Fixtures separately fix text/IDs/SHA.
    const historicalMessages = observed.messages.map(message => {
      switch (message.role) {
      case 'user': case 'system': return `<|im_start|>${message.role}\n${message.content}<|im_end|>`;
      case 'assistant': return ['<|im_start|>assistant', ...(message.content.length === 0 ? [] : [message.content]), '<|im_end|>'].join('\n');
      default: { const exhaustive: never = message.role; throw new Error(String(exhaustive)); }
      }
    });
    const prefix = (() => {
      switch (expectedMode) {
      case 'default': return '<|im_start|>assistant';
      case 'disabled': return `\
<|im_start|>assistant
<think>

</think>

`;
      case 'enabled': return `\
<|im_start|>assistant
<think>
`;
      default: { const exhaustive: never = expectedMode; throw new Error(String(exhaustive)); }
      }
    })();
    const firstSystem = observed.messages[0]?.role === 'system' ? [historicalMessages[0]!] : [];
    const historical = [...firstSystem, ...historicalMessages, prefix].join('\n') + '\n';
    expect(historical).toBe(expectedPrompt);
    const ids = tokenizer.encode(historical, { add_special_tokens: false });
    expect(ids).toEqual(capture.replay.modelReplay.sourceInputTokenIds);
    expect(createHash('sha256').update(JSON.stringify(ids)).digest('hex')).toBe(capture.replay.modelReplay.sourceInputSha256);
    return historical;
  });
  return { builderSpy, serviceSpy, restore() {
    builderSpy.mockRestore(); serviceSpy.mockRestore();
  } };
}

async function createRecordedQwenOutputControl({ capture, effort, expectedMode, expectedPrompt, verifyBeforeRelease }: {
  capture: ReturnType<typeof parseRecordedQwenCapture>,
  effort: 'none' | 'high' | undefined, expectedMode: 'default' | 'disabled' | 'enabled', expectedPrompt: string,
  verifyBeforeRelease: ({ context }: { context: Parameters<ProviderReplayGenerate>[0] }) => void,
}) {
  const { replay } = capture;
  let releasedTokenCount = 0;
  let gateAccepted = false;
  let builderSpy: MockInstance<typeof import('@/features/transformers-js/models/qwen3_5').buildQwen3_5Prompt> | undefined;
  let historicalAdapter: Awaited<ReturnType<typeof installHistoricalQwenSerializer>> | undefined;
  const harness = await createProviderReplayTestRuntime({
    modelId: 'onnx-community/Qwen3.5-2B-ONNX', expectedRevision: 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb', cacheRevision: 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb', metadataCache: "all-fixture",
    imagePlatform: undefined,
    artifacts: [
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
    ].map(path => ({ path, bytes: createSyntheticModelBody({
      modelId: 'onnx-community/Qwen3.5-2B-ONNX', revision: 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb', path,
    }) })),
    generate: async context => {
      const { options, tokenizer, runtime } = context;
      expect(runtime.env.version).toBe(replay.identity.transformersJsVersion);
      expect(tokenizer).toBe(harness.observations.processors[0]?.tokenizer);
      expect(builderSpy).toHaveBeenCalledOnce();
      const builderCall = builderSpy?.mock.calls[0];
      if (!builderCall) throw new Error('Qwen recorded replay requires the actual public serializer');
      const { tokenizer: builderTokenizer, ...builderInput } = builderCall[0];
      expect(builderTokenizer).toBe(tokenizer);
      const observed = recordedQwenBuilderSchema.parse(builderInput);
      const { messages, tools, reasoningMode, ...rest } = observed;
      rest satisfies Record<PropertyKey, never>;
      expect(messages.map(message => {
        const { role, content, tool_calls: _calls, tool_call_id: _id, ...unhandled } = message;
        unhandled satisfies Record<PropertyKey, never>;
        return { role, content };
      })).toStrictEqual(replay.scenario.messages);
      expect(tools).toBeUndefined();
      expect(reasoningMode).toBe(expectedMode);
      // Full text/ID controls precede the only output-release operation. The
      // shared gate separately checks every ID, its hash, masks and kwargs.
      expect(tokenizer.decode(replay.modelReplay.sourceInputTokenIds, { skip_special_tokens: false })).toBe(expectedPrompt);
      expect(tokenizer.encode(expectedPrompt, { add_special_tokens: false })).toEqual(replay.modelReplay.sourceInputTokenIds);
      expect(tokenizer.decode(replay.modelReplay.generatedTokenIds, { skip_special_tokens: false })).toBe(replay.modelReplay.generatedText);
      expect(options.past_key_values).toBeNull();
      verifyBeforeRelease({ context });
      const result = replayRecordedText({ evidence: replay, options });
      gateAccepted = true;
      releasedTokenCount += result.releasedTokenCount;
      // The recorded output cache was a _DynamicCache, whose tensors were not
      // captured. This test replays text only, never fabricates or reuses that
      // cache, and makes exactly one public request in this fresh runtime.
      return {
        sequences: new runtime.Tensor('int64', BigInt64Array.from(result.sequenceTokenIds), [1, result.sequenceTokenIds.length]),
        past_key_values: null,
      };
    },
  });
  try {
    await harness.service.loadDownloadedModel({ modelId: replay.identity.modelId });
    expect(harness.observations.processors).toHaveLength(1);
    const processor = harness.observations.processors[0];
    if (!processor?.tokenizer) throw new Error('Expected real Qwen2 processor/tokenizer');
    expect(processor.constructor.name).toBe('Qwen3VLProcessor');
    expect(createHash('sha256').update(processor.tokenizer.get_chat_template()).digest('hex'))
      .toBe('273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80');
    historicalAdapter = await installHistoricalQwenSerializer({ harness, capture, effort, expectedMode, expectedPrompt });
    builderSpy = historicalAdapter.builderSpy;
    const processorSpy = vi.spyOn(processor, '_call');
    return { harness, verifyNativeInput() {
      expect(gateAccepted).toBe(true);
      expect(releasedTokenCount).toBe(replay.modelReplay.generatedTokenIds.length);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(processorSpy.mock.calls).toStrictEqual([[expectedPrompt]]);
      expect(harness.observations.ortCalls.map(([core, options]) => inspectSyntheticOrtSession({
        modelId: replay.identity.modelId, revision: replay.identity.resolvedRevision,
        repositoryPaths: new Set([
          'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
          'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        ]), core, options,
      })).toSorted((a, b) => a.corePath.localeCompare(b.corePath))).toEqual([
        { modelId: replay.identity.modelId, revision: replay.identity.resolvedRevision, corePath: 'onnx/decoder_model_merged_q4f16.onnx',
          externalData: [{ path: 'decoder_model_merged_q4f16.onnx_data', artifactPath: 'onnx/decoder_model_merged_q4f16.onnx_data' }], executionProviders: ['webgpu'] },
        { modelId: replay.identity.modelId, revision: replay.identity.resolvedRevision, corePath: 'onnx/embed_tokens_q4f16.onnx',
          externalData: [{ path: 'embed_tokens_q4f16.onnx_data', artifactPath: 'onnx/embed_tokens_q4f16.onnx_data' }], executionProviders: ['webgpu'] },
      ]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    }, async close() {
      processorSpy.mockRestore();
      historicalAdapter?.restore();
      await harness.close();
    } };
  } catch (error) {
    historicalAdapter?.restore();
    await harness.close();
    throw error;
  }
}

function createQwenReplay({ generate }: { generate: ProviderReplayGenerate }) {
  const metadata = readModelFixture({ modelId: evidence.identity.modelId });
  expect(createHash('sha256').update(metadata.files.get('tokenizer.json')!).digest('hex')).toBe('89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b');
  expect(createHash('sha256').update(metadata.files.get('tokenizer_config.json')!).digest('hex')).toBe('fccbff64ebe09343aa2171028657f5b038db96fb4f657609bc76743eddfa3b9d');
  expect(evidence.productionInput.messages).toEqual(evidence.nativeTemplate.messages);
  return createProviderReplayTestRuntime({
    imagePlatform: undefined,
    modelId: evidence.identity.modelId, expectedRevision: evidence.identity.resolvedRevision, cacheRevision: evidence.identity.resolvedRevision, metadataCache: "all-fixture",
    artifacts: [
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
    ].map(path => ({ path, bytes: new TextEncoder().encode(`synthetic Qwen model artifact: ${path}`) })),
    generate,
  });
}

async function createHistoricalMutationControl() {
  const generate = vi.fn<ProviderReplayGenerate>(async () => {
    throw new Error('Historical mutation must stop before native token release');
  });
  const harness = await createQwenReplay({ generate });
  await harness.service.loadDownloadedModel({ modelId: firstQwenCapture.replay.identity.modelId });
  const adapter = await installHistoricalQwenSerializer({ harness, capture: firstQwenCapture, effort: undefined, expectedMode: 'default', expectedPrompt: recordedQwenUserPrompt });
  return { harness, adapter, generate, async close() {
    adapter.restore(); await harness.close();
  } };
}

async function createCurrentQwenHistoricalOutputControl({ capture, effort, expectedNativePrompt }: {
  capture: ReturnType<typeof parseRecordedQwenCapture>, effort: 'none' | 'high' | undefined, expectedNativePrompt: string,
}) {
  const stop = 'Current native Qwen input verified; historical output is ineligible';
  const inputs: ReturnType<typeof snapshotQwenInput>[] = [];
  const legacyAttempts: ({ status: 'rejected', error: unknown } | { status: 'returned', result: ReturnType<typeof replayRecordedText> })[] = [];
  const streamCalls: { put: number, end: number }[] = [];
  const harness = await createQwenReplay({ generate: async context => {
    inputs.push(snapshotQwenInput({ context }));
    const { options, runtime } = context;
    const streamer = options.streamer instanceof runtime.TextStreamer ? options.streamer : undefined;
    const put = streamer ? vi.spyOn(streamer, 'put') : undefined;
    const end = streamer ? vi.spyOn(streamer, 'end') : undefined;
    try {
      // Exercise the real refusal at the native boundary; never return its
      // result as successful generation, even if this negative control regresses.
      legacyAttempts.push({ status: 'returned', result: replayRecordedText({ evidence: capture.replay, options }) });
    } catch (error) {
      legacyAttempts.push({ status: 'rejected', error });
    } finally {
      if (put && end) streamCalls.push({ put: put.mock.calls.length, end: end.mock.calls.length });
      put?.mockRestore();
      end?.mockRestore();
    }
    throw new Error(stop);
  } });
  return { harness, stop, verifyNativeInput() {
    expect(inputs).toHaveLength(1);
    const actual = inputs[0];
    if (!actual?.options.input_ids || !actual.options.attention_mask) throw new Error('Expected actual current native Qwen tensors');
    const { options, tokenizer } = actual;
    const thinking = effort === undefined ? {} : { enable_thinking: effort !== 'none' };
    expect(tokenizer.apply_chat_template(capture.replay.scenario.messages, { tokenize: false, add_generation_prompt: true, ...thinking })).toBe(expectedNativePrompt);
    const expectedIds = tokenizer.encode(expectedNativePrompt, { add_special_tokens: false });
    expect(Array.from(actual.options.input_ids.data, Number)).toEqual(expectedIds);
    expect(Array.from(actual.options.attention_mask.data, BigInt)).toEqual(expectedIds.map(() => 1n));
    expect(options.past_key_values).toBeNull();
    expect(actual.streamerIsTextStreamer).toBe(true);
    expect(legacyAttempts).toHaveLength(1);
    expect(legacyAttempts[0]).toMatchObject({ status: 'rejected', error: expect.any(Error) });
    const attempt = legacyAttempts[0];
    if (attempt?.status !== 'rejected') throw new Error('Historical output unexpectedly passed its causal gate');
    expect(attempt.error).toHaveProperty('message', expect.stringContaining('Replay causal mismatch: actual source input'));
    expect(streamCalls).toEqual([{ put: 0, end: 0 }]);
    expect(harness.observations.inferenceCalls).toHaveLength(1);
    expect(harness.observations.workers).toHaveLength(1);
    expect(harness.observations.ortCalls).toHaveLength(2);
    expect(harness.observations.localImageFetchCalls).toEqual([]);
    expect(harness.observations.forbiddenTransport).toEqual([]);
    expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  } };
}

// These are bounded synthetic opaque PNG inputs, not captured browser pixels or
// image-generation evidence. Their bytes are decoded by the existing platform;
// real Qwen2 RawImage conversion, resizing and patchification remain unchanged.
const qwen2ImageCases = [
  {
    name: 'opaque black',
    imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    rgba: Uint8ClampedArray.of(0, 0, 0, 255), rescaled: 0,
  },
  {
    name: 'opaque white',
    imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGP4/x8AAwAB//wl3FEAAAAASUVORK5CYII=',
    rgba: Uint8ClampedArray.of(255, 255, 255, 255), rescaled: 1,
  },
];
// Independently read from this exact 2B template (273d8e0e...). Unlike 4B,
// its absent enable_thinking closes an empty thinking section by default.
const qwen2NativeImagePrompt = `\
<|im_start|>user
Describe this synthetic Qwen2 image.<|vision_start|><|image_pad|><|vision_end|><|im_end|>
<|im_start|>assistant
<think>

</think>

`;
// Historical Production default retained as a contrast, never as the current
// native image-input oracle or authorization to reuse an old output capture.
const qwen2ProductionImagePrompt = `\
<|im_start|>user
Describe this synthetic Qwen2 image.<|vision_start|><|image_pad|><|vision_end|><|im_end|>
<|im_start|>assistant
`;

describe('Qwen3.5 2B Provider / basic', () => {
  it('rejects changed messages at the historical adapter before releasing any native tokens', async () => {
    const control = await createHistoricalMutationControl();
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({
        provider: control.harness.provider,
        request: {
          model: 'onnx-community/Qwen3.5-2B-ONNX',
          messages: [{ role: 'user', content: 'Changed synthetic message.' }],
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
          signal: new AbortController().signal,
        },
      });
      await expect(capture.completion).rejects.toThrow();
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind === 'settled' ? 'rejected' : event.kind)).toEqual(['assistant-start', 'rejected']);
      expect(observed.chunks).toEqual([]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(control.adapter.serviceSpy).toHaveBeenCalledOnce();
      expect(control.adapter.builderSpy).not.toHaveBeenCalled();
      expect(control.generate).not.toHaveBeenCalled();
      expect(control.harness.observations.inferenceCalls).toHaveLength(0);
    } finally {
      await control.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('rejects changed generation parameters at the historical adapter before releasing any native tokens', async () => {
    const control = await createHistoricalMutationControl();
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({
        provider: control.harness.provider,
        request: {
          model: 'onnx-community/Qwen3.5-2B-ONNX',
          messages: [{ role: 'user', content: 'Template probe user message.' }],
          tools: [],
          parameters: {
            temperature: 0,
            topP: 1,
            maxCompletionTokens: 15,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: { effort: undefined },
          },
          signal: new AbortController().signal,
        },
      });
      await expect(capture.completion).rejects.toThrow();
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind === 'settled' ? 'rejected' : event.kind)).toEqual(['assistant-start', 'rejected']);
      expect(observed.chunks).toEqual([]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(control.adapter.serviceSpy).toHaveBeenCalledOnce();
      expect(control.adapter.builderSpy).not.toHaveBeenCalled();
      expect(control.generate).not.toHaveBeenCalled();
      expect(control.harness.observations.inferenceCalls).toHaveLength(0);
    } finally {
      await control.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('rejects a changed selected template at the historical adapter before releasing any native tokens', async () => {
    const control = await createHistoricalMutationControl();
    const tokenizer = control.harness.observations.processors[0]!.tokenizer;
    if (tokenizer === undefined) throw new Error('Expected the selected native tokenizer');
    const template = vi.spyOn(tokenizer, 'get_chat_template').mockReturnValue('changed synthetic template');
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({
        provider: control.harness.provider,
        request: {
          model: 'onnx-community/Qwen3.5-2B-ONNX',
          messages: [{ role: 'user', content: 'Template probe user message.' }],
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
          signal: new AbortController().signal,
        },
      });
      await expect(capture.completion).rejects.toThrow();
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind === 'settled' ? 'rejected' : event.kind)).toEqual(['assistant-start', 'rejected']);
      expect(observed.chunks).toEqual([]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(control.adapter.serviceSpy).toHaveBeenCalledOnce();
      expect(control.adapter.builderSpy).toHaveBeenCalledOnce();
      expect(template).toHaveBeenCalledOnce();
      expect(control.generate).not.toHaveBeenCalled();
      expect(control.harness.observations.inferenceCalls).toHaveLength(0);
    } finally {
      template.mockRestore();
      await control.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('preserves the historical 13-ID first input through an explicit legacy serializer adapter', async () => {
    const source = firstQwenCapture.replay;
    expect(source.identity.resolvedRevision).toBe('b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb');
    expect(source.scenario.messages).toEqual([{ role: 'user', content: 'Template probe user message.' }]);
    expect(source.scenario.tools).toEqual([]);
    // This successful Production-input contract is separate from native 17-ID
    // parity below. It neither decides the intended reasoning policy nor
    // authorizes the captured output for a different native prompt.
    expect(source.modelReplay.sourceInputTokenIds).toEqual(evidence.productionInput.inputTokenIds);
    expect(source.modelReplay.sourceInputTokenIds).not.toEqual(evidence.nativeTemplate.inputIds);
    const stop = 'qwen3.5-2b first Production input verified; no output tokens supplied';
    const inputs: ReturnType<typeof snapshotQwenInput>[] = [];
    const harness = await createProviderReplayTestRuntime({
      modelId: 'onnx-community/Qwen3.5-2B-ONNX', expectedRevision: source.identity.resolvedRevision, cacheRevision: source.identity.resolvedRevision, metadataCache: "all-fixture", imagePlatform: undefined,
      // Identifiable synthetic bodies replace native weight execution only.
      artifacts: ['onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data', 'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data'].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: 'onnx-community/Qwen3.5-2B-ONNX', revision: source.identity.resolvedRevision, path }),
      })),
      generate: async context => {
        inputs.push(snapshotQwenInput({ context }));
        // Never call replayRecordedText, streamer.put/end or return sequences.
        // This positive input test remains independent of callback delivery.
        throw new Error(stop);
      },
    });
    const historicalAdapter = await installHistoricalQwenSerializer({ harness, capture: firstQwenCapture, effort: undefined, expectedMode: 'default', expectedPrompt: recordedQwenUserPrompt });
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: source.identity.modelId,
          messages: source.scenario.messages,
          tools: [],
          parameters: {
            ...source.scenario.lmParameters,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: { effort: undefined },
          },
        },
      });
      await expect(capture.completion).rejects.toThrow(stop);
      const observed = capture.snapshot();
      expect(inputs).toHaveLength(1);
      const native = inputs[0]!;
      const { options, tokenizer, runtime } = native;
      expect(runtime.env.version).toBe(source.identity.transformersJsVersion);
      expect(tokenizer).toBeInstanceOf(runtime.PreTrainedTokenizer);
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'))
        .toBe('273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80');
      expect(tokenizer).toBe(harness.observations.processors[0]?.tokenizer);
      expect(native.optionKeys).toEqual([
        'attention_mask', 'do_sample', 'input_ids', 'max_new_tokens', 'past_key_values',
        'return_dict_in_generate', 'stopping_criteria', 'streamer', 'temperature', 'top_p',
      ].sort());
      if (!options.input_ids || !options.attention_mask) {
        throw new Error('Expected actual first-input Tensor instances');
      }
      const tensors = { input_ids: options.input_ids, attention_mask: options.attention_mask };
      for (const fact of source.inputContract.inputTensorFacts) {
        const tensor = tensors[fact.name];
        expect({ name: fact.name, dtype: tensor.type, dims: tensor.dims, location: tensor.location }).toEqual(fact);
        expect(tensor.data).toBeInstanceOf(BigInt64Array);
      }
      const actualIds = Array.from(options.input_ids.data, Number);
      expect(options.input_ids.dims).toEqual([1, 13]);
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
      expect(native.streamerIsTextStreamer).toBe(true);
      expect(native.stoppingCriteriaType).toBe('function');
      expect(historicalAdapter.builderSpy).toHaveBeenCalledOnce();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.chunks).toEqual([]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.ortCalls).toHaveLength(2);
      expect(harness.observations.processors).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      historicalAdapter.restore();
      await harness.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('rejects historical first-turn output at the repaired native input without a legacy adapter', async () => {
    {
      const control = await createCurrentQwenHistoricalOutputControl({ capture: firstQwenCapture, effort: undefined, expectedNativePrompt: recordedQwenUserPrompt + `\
<think>

</think>

` });
      let capture: ProviderChatCapture | undefined;
      try {
        capture = captureProviderChat({
          provider: control.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-2B-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }],
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
          },
        });
        await expect(capture.completion).rejects.toThrow(control.stop);
        const observed = capture.snapshot();
        expect(observed.settlement).toMatchObject({ status: 'rejected' });
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        control.verifyNativeInput();
      } finally {
        await control.harness.close();
      }
      expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('preserves the native default template and its independently recorded 17 tokens', async () => {
    const generate = vi.fn<ProviderReplayGenerate>(async () => {
      throw new Error('This native input test must not generate');
    });
    const harness = await createQwenReplay({ generate });
    try {
      await harness.service.loadDownloadedModel({ modelId: evidence.identity.modelId });
      expect(harness.observations.processors).toHaveLength(1);
      const processor = harness.observations.processors[0]!;
      expect(processor.constructor.name).toBe('Qwen3VLProcessor');
      const tokenizer = processor.tokenizer;
      if (!tokenizer) throw new Error('Actual processor did not expose its tokenizer');
      expect(tokenizer).toBeInstanceOf(harness.runtime.PreTrainedTokenizer);
      expect(tokenizer.apply_chat_template(evidence.nativeTemplate.messages, { tokenize: false, add_generation_prompt: true })).toBe(evidence.nativeTemplate.renderedText);
      expect(tokenizer.apply_chat_template(evidence.nativeTemplate.messages, { tokenize: true, add_generation_prompt: true, return_tensor: false, return_dict: false })).toEqual(evidence.nativeTemplate.inputIds);
      expect(generate).not.toHaveBeenCalled();
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
  it('passes the same native default input through public Provider before any token can be released', async () => {
    const inputs: ReturnType<typeof snapshotQwenInput>[] = [];
    const stop = new Error('Qwen input captured; native inference intentionally not executed');
    const generate = vi.fn<ProviderReplayGenerate>(async context => {
      inputs.push(snapshotQwenInput({ context }));
      // No captured generation token IDs are present in this fixture. Never
      // call streamer.put/end or invent KV state for an unmatched input.
      throw stop;
    });
    const harness = await createQwenReplay({ generate });
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: `hf.co/${evidence.identity.modelId}`,
          messages: evidence.productionInput.messages,
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
        },
      });
      await expect(capture.completion).rejects.toThrow(stop.message);
      const observed = capture.snapshot();
      expect(generate).toHaveBeenCalledOnce();
      expect(inputs).toHaveLength(1);
      const { options, tokenizer } = inputs[0]!;
      const input = options.input_ids;
      const mask = options.attention_mask;
      if (!input || !mask) throw new Error('Expected actual processor tensors');
      const actualInput = Array.from(input.data, BigInt);
      expect(Array.from(mask.data, BigInt)).toEqual(actualInput.map(() => 1n));
      expect(input.dims).toEqual([1, actualInput.length]);
      expect({ maxNewTokens: options.max_new_tokens, temperature: options.temperature, topP: options.top_p, doSample: options.do_sample }).toEqual(evidence.productionInput.effectiveGenerationConfig);
      expect(tokenizer.apply_chat_template(evidence.nativeTemplate.messages, { tokenize: true, add_generation_prompt: true, return_tensor: false, return_dict: false })).toEqual(evidence.nativeTemplate.inputIds);
      expect(harness.observations.processors).toHaveLength(1);
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.chunks).toEqual([]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // The historical 13-token observation is provenance, not a success
      // expectation. This tests recorded native-default parity; it does not
      // mandate that every user reasoning policy use the 17-token default.
      // Any later explicit policy mapping needs a separately reviewed contract.
      expect(actualInput, JSON.stringify({ historicalProductionInput: evidence.productionInput.inputTokenIds })).toEqual(evidence.nativeTemplate.inputIds.map(BigInt));
    } finally {
      await harness.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('delivers the historical 13-input prefix through the legacy serializer adapter before Provider settlement', async () => {
    expect(firstQwenCapture.replay.scenario.messages).toEqual(evidence.productionInput.messages);
    expect(firstQwenCapture.replay.modelReplay.sourceInputTokenIds).toEqual(evidence.productionInput.inputTokenIds);
    expect(firstQwenCapture.sourceFacts.cacheDecision.reason).toBe('qwen3_5-missing-conversation-state');
    {
      const control = await createRecordedQwenOutputControl({
        capture: firstQwenCapture, effort: undefined, expectedMode: 'default', expectedPrompt: recordedQwenUserPrompt,
        verifyBeforeRelease: ({ context }) => {
          if (!(context.options.input_ids instanceof context.runtime.Tensor)) throw new Error('Expected actual Qwen input Tensor');
          expect(context.options.input_ids.dims).toEqual([1, 13]);
          expect(firstQwenCapture.replay.modelReplay.generatedTokenIds).toHaveLength(16);
        },
      });
      let capture: ProviderChatCapture | undefined;
      try {
        capture = captureProviderChat({
          provider: control.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-2B-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }],
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
          },
        });
        await capture.completion;
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        expect(observed.responses.map(chunks => chunks.join(''))).toEqual([`\
<think>
Okay, the user is asking for a template for a user message.`]);
        expect(observed.chunks).toEqual(firstQwenCapture.streamChunks);
        expect(observed.responses).toHaveLength(1);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(['assistant-start', 'settled']);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        control.verifyNativeInput();
      } finally {
        await control.close();
      }
      expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('basic: delivers the recorded first-turn callbacks before settlement', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["first-turn"], artifactPaths: ["onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "first-turn", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages: [{ role: "user", content: "Template probe user message." }],
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["It looks like you might be looking for a **prompt template** to use with"]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
});

describe('Qwen3.5 2B Provider / system', () => {
  it('system: preserves instructions and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["system-user"], artifactPaths: ["onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const messages: ChatMessage[] = [{ role: "system", content: "Template probe system instruction." }, { role: "user", content: "Template probe user message." }];
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "system-user", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages,
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["Hello"]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
});

describe('Qwen3.5 2B Provider / history', () => {
  it('rejects historical raw-history output at the repaired native input without a legacy adapter', async () => {
    {
      const control = await createCurrentQwenHistoricalOutputControl({ capture: historyQwenCapture, effort: undefined, expectedNativePrompt: `\
<|im_start|>user
Template probe user message.<|im_end|>
<|im_start|>assistant
<think>
Okay, the user is asking for a template for a user message.<|im_end|>
<|im_start|>user
Continue with one short sentence.<|im_end|>
<|im_start|>assistant
<think>

</think>

` });
      let capture: ProviderChatCapture | undefined;
      try {
        capture = captureProviderChat({
          provider: control.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-2B-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }, { role: "assistant", content: `\
<think>
Okay, the user is asking for a template for a user message.` }, { role: "user", content: "Continue with one short sentence." }],
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
          },
        });
        await expect(capture.completion).rejects.toThrow(control.stop);
        const observed = capture.snapshot();
        expect(observed.settlement).toMatchObject({ status: 'rejected' });
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        control.verifyNativeInput();
      } finally {
        await control.harness.close();
      }
      expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it.each(inputEvidence.cases)('$caseId retains the recorded native default input through public Provider', async scenario => {
    expect(inputEvidence.modelId).toBe(evidence.identity.modelId);
    expect(inputEvidence.revision).toBe(evidence.identity.resolvedRevision);
    const inputs: ReturnType<typeof snapshotQwenInput>[] = [];
    const boundary = 'Qwen system/history input captured; native inference intentionally not executed';
    const generate = vi.fn<ProviderReplayGenerate>(async context => {
      inputs.push(snapshotQwenInput({ context }));
      // Input-only capture. Never use the first-turn output to cross a mismatch.
      throw new Error(boundary);
    });
    const harness = await createQwenReplay({ generate });
    let capture: ProviderChatCapture | undefined;
    try {
      await harness.service.loadDownloadedModel({ modelId: inputEvidence.modelId });
      expect(harness.observations.processors).toHaveLength(1);
      const processor = harness.observations.processors[0]!;
      const tokenizer = processor.tokenizer;
      if (!tokenizer) throw new Error('Actual Qwen processor tokenizer unavailable');
      expect(tokenizer).toBeInstanceOf(harness.runtime.PreTrainedTokenizer);
      // Independent native control runs before public generation, so an input
      // adaptation failure cannot hide a changed tokenizer/template fixture.
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(scenario.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: true })).toBe(scenario.renderedText);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: true, add_generation_prompt: true, return_tensor: false, return_dict: false,
      })).toEqual(scenario.inputTokenIds);
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: inputEvidence.modelId,
          messages: scenario.messages,
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
        },
      });
      await expect(capture.completion).rejects.toThrow(boundary);
      const observed = capture.snapshot();
      expect(generate).toHaveBeenCalledOnce();
      expect(inputs).toHaveLength(1);
      const { options } = inputs[0]!;
      if (!options.input_ids || !options.attention_mask) {
        throw new Error('Expected actual Qwen processor tensors');
      }
      const actualInput = Array.from(options.input_ids.data, BigInt);
      expect(options.input_ids.type).toBe('int64');
      expect(options.input_ids.location).toBe('cpu');
      expect(options.input_ids.dims).toEqual([1, actualInput.length]);
      expect(options.attention_mask.type).toBe('int64');
      expect(options.attention_mask.location).toBe('cpu');
      expect(options.attention_mask.dims).toEqual([1, actualInput.length]);
      expect(options.attention_mask.data).toEqual(new BigInt64Array(actualInput.length).fill(1n));
      expect(options.past_key_values).toBeNull();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(observed.chunks).toEqual([]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Native-default parity, not a decision that every reasoning policy must
      // use this suffix. Later policy changes need a separately reviewed mapping.
      expect(actualInput).toEqual(scenario.inputTokenIds.map(BigInt));
    } finally {
      await harness.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('replays historical raw assistant-history through the legacy serializer adapter without inventing output KV', async () => {
    expect(continuitySelection.assistantMessage).toStrictEqual({ role: 'assistant', content: firstQwenCapture.replay.modelReplay.generatedText });
    expect(historyQwenCapture.replay.scenario.messages).toEqual([
      firstQwenCapture.replay.scenario.messages[0], continuitySelection.assistantMessage, continuitySelection.followUpMessage,
    ]);
    expect(historyQwenCapture.sourceFacts.cacheDecision.reason).toBe('qwen3_5-message-count-mismatch');
    // The investigation supplied raw decoded model text, not a completed
    // assistant reconstructed from a successful Provider callback sequence.
    {
      const control = await createRecordedQwenOutputControl({
        capture: historyQwenCapture, effort: undefined, expectedMode: 'default',
        expectedPrompt: `\
<|im_start|>user
Template probe user message.<|im_end|>
<|im_start|>assistant
<think>
Okay, the user is asking for a template for a user message.
<|im_end|>
<|im_start|>user
Continue with one short sentence.<|im_end|>
<|im_start|>assistant
`,
        verifyBeforeRelease: ({ context }) => {
          if (!(context.options.input_ids instanceof context.runtime.Tensor)) throw new Error('Expected actual Qwen input Tensor');
          expect(context.options.input_ids.dims).toEqual([1, 46]);
          expect(historyQwenCapture.replay.modelReplay.generatedTokenIds).toHaveLength(16);
        },
      });
      let capture: ProviderChatCapture | undefined;
      try {
        capture = captureProviderChat({
          provider: control.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-2B-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }, { role: "assistant", content: `\
<think>
Okay, the user is asking for a template for a user message.` }, { role: "user", content: "Continue with one short sentence." }],
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
          },
        });
        await capture.completion;
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        expect(observed.responses.map(chunks => chunks.join(''))).toEqual([`\
<think>
Thinking Process:

1.  **Analyze the Request:**
`]);
        expect(observed.chunks).toEqual(historyQwenCapture.streamChunks);
        expect(observed.responses).toHaveLength(1);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(['assistant-start', 'settled']);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        control.verifyNativeInput();
      } finally {
        await control.close();
      }
      expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('history: preserves supplied history and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["supplied-history"], artifactPaths: ["onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const messages: ChatMessage[] = [{ role: "user", content: "Template probe first user message." }, { role: "assistant", content: "Template probe assistant response." }, { role: "user", content: "Template probe second user message." }];
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "supplied-history", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages,
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["Hello"]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
});

describe('Qwen3.5 2B Provider / independent', () => {
  it('keeps an independent next input free of prior text in the same null-KV loaded runtime', async () => {
    const source = firstQwenCapture.replay;
    const nextMessages: ChatMessage[] = [{ role: 'user', content: 'A separate synthetic Qwen conversation.' }];
    // Independently specified default Production text, not captured output
    // and not an oracle generated by calling the serializer under test.
    const historicalNextPrompt = `\
<|im_start|>user
A separate synthetic Qwen conversation.<|im_end|>
<|im_start|>assistant
`;
    const nextPrompt = historicalNextPrompt + `\
<think>

</think>

`;
    const stop = 'Independent Qwen2 next input verified; no second output supplied';
    const contexts: ReturnType<typeof snapshotQwenInput>[] = [];
    let firstReleased = 0;
    const invocations: ProviderReplayGenerate[] = [
      async context => {
        contexts.push(snapshotQwenInput({ context }));
        const { options, tokenizer, runtime } = context;
        expect(tokenizer.decode(source.modelReplay.generatedTokenIds, { skip_special_tokens: false })).toBe(source.modelReplay.generatedText);
        const replay = replayRecordedText({ evidence: source, options });
        firstReleased = replay.releasedTokenCount;
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
      async context => {
        contexts.push(snapshotQwenInput({ context }));
        // No captured response exists for this changed input. This tests input
        // isolation with null KV, not native KV invalidation or generation.
        throw new Error(stop);
      },
    ];
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      artifacts: [
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async context => {
        const next = invocations.shift();
        if (!next) throw new Error('Unexpected extra inference in independent-input replay');
        return next(context);
      },
    });
    const historicalAdapter = await installHistoricalQwenSerializer({ harness, capture: firstQwenCapture, effort: undefined, expectedMode: 'default', expectedPrompt: recordedQwenUserPrompt });
    const captures: ProviderChatCapture[] = [];
    try {
      const firstCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: source.identity.modelId,
          messages: source.scenario.messages,
          tools: [],
          parameters: {
            ...source.scenario.lmParameters,
            presencePenalty: undefined,
            frequencyPenalty: undefined,
            stop: undefined,
            reasoning: { effort: undefined },
          },
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;
      const firstObserved = firstCapture.snapshot();
      expect(firstObserved.settlement).toEqual({ status: 'fulfilled' });
      expect(historicalAdapter.builderSpy).toHaveBeenCalledOnce();
      historicalAdapter.restore();
      expect(firstObserved.chunks).toEqual(firstQwenCapture.streamChunks);
      expect(firstObserved.responses).toHaveLength(1);
      expect(firstObserved.preStartChunks).toEqual([]);
      expect(firstObserved.lateEvents).toEqual([]);
      expect(firstObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(['assistant-start', 'settled']);
      expect(firstObserved.toolCalls).toEqual([]);
      expect(firstObserved.toolResults).toEqual([]);
      expect(firstObserved.toolEvents).toEqual([]);
      const ortCountAfterFirst = harness.observations.ortCalls.length;
      expect(harness.observations.processors).toHaveLength(1);
      const processorAfterFirst = harness.observations.processors[0];
      const secondCapture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: source.identity.modelId,
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
        },
      });
      captures.push(secondCapture);
      await expect(secondCapture.completion).rejects.toThrow(stop);
      const secondObserved = secondCapture.snapshot();
      expect(secondObserved.settlement).toMatchObject({ status: 'rejected' });
      expect(contexts).toHaveLength(2);
      const native = contexts[1]!;
      const { options, tokenizer } = native;
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe('273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80');
      const processor = harness.observations.processors[0];
      if (!processor) throw new Error('Expected actual loaded Qwen2 processor');
      expect(tokenizer).toBe(processor.tokenizer);
      // This independent next-input contract uses the existing Production
      // serializer, not a claim of native-default parity. Keep that distinct
      // default native suffix visible without using its tokens for inference.
      const nativeDefaultPrompt = nextPrompt;
      expect(tokenizer.apply_chat_template(nextMessages, { tokenize: false, add_generation_prompt: true })).toBe(nativeDefaultPrompt);
      expect(nativeDefaultPrompt).not.toBe(historicalNextPrompt);
      const ids = tokenizer.encode(nextPrompt, { add_special_tokens: false });
      if (!options.input_ids || !options.attention_mask) throw new Error('Expected actual next-input tensors');
      expect(options.input_ids.type).toBe('int64');
      expect(options.input_ids.location).toBe('cpu');
      expect(options.input_ids.dims).toEqual([1, ids.length]);
      expect(Array.from(options.input_ids.data, Number)).toEqual(ids);
      expect(options.attention_mask.type).toBe('int64');
      expect(options.attention_mask.location).toBe('cpu');
      expect(options.attention_mask.dims).toEqual([1, ids.length]);
      expect(Array.from(options.attention_mask.data, BigInt)).toEqual(ids.map(() => 1n));
      expect(native.optionKeys).toEqual([
        'attention_mask', 'do_sample', 'input_ids', 'max_new_tokens', 'past_key_values',
        'return_dict_in_generate', 'stopping_criteria', 'streamer', 'temperature', 'top_p',
      ].sort());
      expect({ maxNewTokens: options.max_new_tokens, temperature: options.temperature, topP: options.top_p, doSample: options.do_sample })
        .toEqual({ maxNewTokens: 1, temperature: 0, topP: 1, doSample: false });
      expect(options.return_dict_in_generate).toBe(true);
      expect(native.streamerIsTextStreamer).toBe(true);
      expect(native.stoppingCriteriaType).toBe('function');
      expect(options.past_key_values).toBeNull();
      expect(firstReleased).toBe(16);
      expect(secondObserved.chunks).toEqual([]);
      expect(secondObserved.preStartChunks).toEqual([]);
      expect(secondObserved.lateEvents).toEqual([]);
      expect(secondObserved.toolCalls).toEqual([]);
      expect(secondObserved.toolResults).toEqual([]);
      expect(secondObserved.toolEvents).toEqual([]);
      expect(contexts).toHaveLength(2);
      expect(contexts[1]!.model).toBe(contexts[0]!.model);
      expect(contexts[1]!.tokenizer).toBe(contexts[0]!.tokenizer);
      expect(contexts.map(context => context.options.past_key_values)).toEqual([null, null]);
      expect(invocations).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(ortCountAfterFirst).toBe(2);
      expect(harness.observations.ortCalls).toHaveLength(ortCountAfterFirst);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.processors).toHaveLength(1);
      expect(harness.observations.processors[0]).toBe(processorAfterFirst);
      expect(contexts[1]!.tokenizer).toBe(processorAfterFirst?.tokenizer);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      historicalAdapter.restore();
      await harness.close();
    }
    for (const capture of captures) expect(capture.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('independent: keeps a new conversation independent after settled requests in the same runtime', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["first-turn","continuity","independent-next-input"], artifactPaths: ["onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"], imagePlatform: undefined });
    const captures: ProviderChatCapture[] = [];
    try {
      const firstSignal = new AbortController().signal;
      const firstParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "first-turn", parameters: firstParameters });
      const firstCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages: [{ role: "user", content: "Template probe user message." }],
          tools: [],
          parameters: firstParameters,
          signal: firstSignal,
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;
      replay.endNativeRequest();
      const firstObserved = firstCapture.snapshot();
      expect(firstObserved.settlement).toEqual({ status: 'fulfilled' });
      expect(firstObserved.responses.map(chunks => chunks.join(''))).toEqual(["It looks like you might be looking for a **prompt template** to use with"]);
      expect(firstObserved.preStartChunks).toEqual([]);
      expect(firstObserved.lateEvents).toEqual([]);
      expect(firstObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(firstObserved.toolEvents).toEqual([]);
      expect(firstObserved.toolCalls).toEqual([]);
      expect(firstObserved.toolResults).toEqual([]);
      const nextMessages: ChatMessage[] = [{ role: "user", content: "Template probe user message." }, { role: "assistant", content: firstObserved.responses[0]!.join('') }, { role: "user", content: "Continue the synthetic conversation with a short response." }];
      const nextSignal = new AbortController().signal;
      const nextParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "continuity", parameters: nextParameters });
      const nextCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages: nextMessages,
          tools: [],
          parameters: nextParameters,
          signal: nextSignal,
        },
      });
      captures.push(nextCapture);
      await nextCapture.completion;
      replay.endNativeRequest();
      const nextObserved = nextCapture.snapshot();
      expect(nextObserved.settlement).toEqual({ status: 'fulfilled' });
      expect(nextObserved.responses.map(chunks => chunks.join(''))).toEqual(["Got it! I'm ready to continue the conversation. What would you like to"]);
      expect(nextObserved.preStartChunks).toEqual([]);
      expect(nextObserved.lateEvents).toEqual([]);
      expect(nextObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(nextObserved.toolEvents).toEqual([]);
      expect(nextObserved.toolCalls).toEqual([]);
      expect(nextObserved.toolResults).toEqual([]);
      const independentSignal = new AbortController().signal;
      const independentParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "independent-next-input", parameters: independentParameters });
      const independentCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages: [{ role: "user", content: "A separate synthetic capture conversation." }],
          tools: [],
          parameters: independentParameters,
          signal: independentSignal,
        },
      });
      captures.push(independentCapture);
      await independentCapture.completion;
      replay.endNativeRequest();
      const independentObserved = independentCapture.snapshot();
      expect(independentObserved.settlement).toEqual({ status: 'fulfilled' });
      expect(independentObserved.responses.map(chunks => chunks.join(''))).toEqual(["I"]);
      expect(independentObserved.preStartChunks).toEqual([]);
      expect(independentObserved.lateEvents).toEqual([]);
      expect(independentObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(independentObserved.toolEvents).toEqual([]);
      expect(independentObserved.toolCalls).toEqual([]);
      expect(independentObserved.toolResults).toEqual([]);
      replay.assertComplete({ requests: 3, nativeCalls: 3 });
    } finally {
      await replay.close();
    }
    for (const capture of captures) expect(capture.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
});

describe('Qwen3.5 2B Provider / reasoning', () => {
  it('rejects historical none output at the repaired native input without a legacy adapter', async () => {
    {
      const control = await createCurrentQwenHistoricalOutputControl({ capture: disabledQwenCapture, effort: 'none', expectedNativePrompt: recordedQwenUserPrompt + `\
<think>

</think>

` });
      let capture: ProviderChatCapture | undefined;
      try {
        capture = captureProviderChat({
          provider: control.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-2B-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }],
            tools: [],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: { effort: 'none' },
            },
          },
        });
        await expect(capture.completion).rejects.toThrow(control.stop);
        const observed = capture.snapshot();
        expect(observed.settlement).toMatchObject({ status: 'rejected' });
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        control.verifyNativeInput();
      } finally {
        await control.harness.close();
      }
      expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('rejects historical high output at the repaired native input without a legacy adapter', async () => {
    {
      const control = await createCurrentQwenHistoricalOutputControl({ capture: enabledQwenCapture, effort: 'high', expectedNativePrompt: recordedQwenUserPrompt + '<think>\n' });
      let capture: ProviderChatCapture | undefined;
      try {
        capture = captureProviderChat({
          provider: control.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-2B-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }],
            tools: [],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: { effort: 'high' },
            },
          },
        });
        await expect(capture.completion).rejects.toThrow(control.stop);
        const observed = capture.snapshot();
        expect(observed.settlement).toMatchObject({ status: 'rejected' });
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        control.verifyNativeInput();
      } finally {
        await control.harness.close();
      }
      expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('rejects equal-length native 17 IDs without streaming and replays only the historical none input via its adapter', async () => {
    expect(disabledQwenCapture.replay.modelReplay.sourceInputTokenIds.slice(-4)).toEqual([248068, 271, 248069, 1358]);
    expect(disabledQwenCapture.replay.modelReplay.sourceInputTokenIds).not.toEqual(evidence.nativeTemplate.inputIds);
    {
      const control = await createRecordedQwenOutputControl({
        capture: disabledQwenCapture, effort: reasoningSelection.disabledEffort, expectedMode: 'disabled',
        expectedPrompt: recordedQwenUserPrompt + `\
<think>

</think>


`,
        verifyBeforeRelease: ({ context: { tokenizer, runtime, options } }) => {
          if (!(options.input_ids instanceof runtime.Tensor)) throw new Error('Expected actual Qwen input Tensor');
          const native = tokenizer.apply_chat_template(evidence.nativeTemplate.messages, {
            tokenize: true, return_dict: true, add_generation_prompt: true,
          });
          const nativeTensors = z.object({
            input_ids: z.instanceof(runtime.Tensor), attention_mask: z.instanceof(runtime.Tensor),
          }).parse(native);
          expect(nativeTensors.input_ids.dims).toEqual([1, 17]);
          expect(options.input_ids.dims).toEqual([1, 17]);
          expect(Array.from(nativeTensors.input_ids.data, Number)).toEqual(evidence.nativeTemplate.inputIds);
          if (!(options.streamer instanceof runtime.TextStreamer)) throw new Error('Expected actual Qwen TextStreamer');
          const put = vi.spyOn(options.streamer, 'put');
          const end = vi.spyOn(options.streamer, 'end');
          try {
            const before = { put: put.mock.calls.length, end: end.mock.calls.length };
            // Explicit negative control only; the actual public input is untouched.
            expect(() => replayRecordedText({
              evidence: disabledQwenCapture.replay,
              options: { ...options, input_ids: nativeTensors.input_ids, attention_mask: nativeTensors.attention_mask },
            })).toThrow('Replay causal mismatch: actual source input');
            expect({ put: put.mock.calls.length, end: end.mock.calls.length }).toStrictEqual(before);
          } finally {
            put.mockRestore();
            end.mockRestore();
          }
          expect(disabledQwenCapture.replay.modelReplay.generatedTokenIds).toEqual([40]);
        },
      });
      let capture: ProviderChatCapture | undefined;
      try {
        capture = captureProviderChat({
          provider: control.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-2B-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }],
            tools: [],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: { effort: reasoningSelection.disabledEffort },
            },
          },
        });
        await capture.completion;
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["I"]);
        expect(observed.chunks).toEqual(disabledQwenCapture.streamChunks);
        expect(observed.responses).toHaveLength(1);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(['assistant-start', 'settled']);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        control.verifyNativeInput();
      } finally {
        await control.close();
      }
      expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('replays the historical double-newline high input via its adapter before its one-token closing think output', async () => {
    expect(enabledQwenCapture.replay.modelReplay.sourceInputTokenIds.slice(-2)).toEqual([248068, 271]);
    {
      const control = await createRecordedQwenOutputControl({
        capture: enabledQwenCapture, effort: reasoningSelection.enabledEffort, expectedMode: 'enabled',
        expectedPrompt: recordedQwenUserPrompt + '<think>\n\n',
        verifyBeforeRelease: ({ context }) => {
          if (!(context.options.input_ids instanceof context.runtime.Tensor)) throw new Error('Expected actual Qwen input Tensor');
          expect(context.options.input_ids.dims).toEqual([1, 15]);
          expect(enabledQwenCapture.replay.modelReplay.generatedTokenIds).toEqual([248069]);
        },
      });
      let capture: ProviderChatCapture | undefined;
      try {
        capture = captureProviderChat({
          provider: control.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-2B-ONNX",
            messages: [{ role: "user", content: "Template probe user message." }],
            tools: [],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: { effort: reasoningSelection.enabledEffort },
            },
          },
        });
        await capture.completion;
        const observed = capture.snapshot();
        expect(observed.settlement).toEqual({ status: 'fulfilled' });
        expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["<think></think>"]);
        expect(observed.chunks).toEqual(['<think>', ...enabledQwenCapture.streamChunks]);
        expect(observed.responses).toHaveLength(1);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(['assistant-start', 'settled']);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        control.verifyNativeInput();
      } finally {
        await control.close();
      }
      expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
    }
  }, 30_000);
  it('reasoning: preserves the recorded none-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["reasoning-none"], artifactPaths: ["onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: "none" } };
      replay.beginNativeRequest({ caseId: "reasoning-none", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages: [{ role: "user", content: "Template probe user message." }],
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["It"]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('reasoning: preserves the recorded low-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["reasoning-low"], artifactPaths: ["onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: "low" } };
      replay.beginNativeRequest({ caseId: "reasoning-low", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages: [{ role: "user", content: "Template probe user message." }],
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["<think>Okay"]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('reasoning: preserves the recorded medium-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["reasoning-medium"], artifactPaths: ["onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: "medium" } };
      replay.beginNativeRequest({ caseId: "reasoning-medium", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages: [{ role: "user", content: "Template probe user message." }],
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["<think>Okay"]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('reasoning: preserves the recorded high-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["reasoning-high"], artifactPaths: ["onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: "high" } };
      replay.beginNativeRequest({ caseId: "reasoning-high", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages: [{ role: "user", content: "Template probe user message." }],
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["<think>Okay"]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
});

describe('Qwen3.5 2B Provider / tools', () => {
  it('tools-generation preserves the complete public schema through the native XML template and actual processor', async () => {
    const scenario = toolInputEvidence.cases[0];
    const replay = await createQwenToolInputReplay();
    const captures: ProviderChatCapture[] = [];
    try {
      const { tokenizer } = replay;
      expect(createHash('sha256').update(tokenizer.get_chat_template({ tools: scenario.tools })).digest('hex')).toBe(scenario.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: scenario.tools,
      })).toBe(scenario.renderedText);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: true, return_tensor: false, return_dict: false, add_generation_prompt: true, tools: scenario.tools,
      })).toEqual(scenario.inputTokenIds);
      expect(scenario.renderedText.split('"required": ["city"]')).toHaveLength(2);
      const strictNativePrompt = scenario.renderedText.replace('"required": ["city"]', '"required": ["city"], "additionalProperties": false');
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: strictQwenTools,
      })).toBe(strictNativePrompt);
      const strictNativeIds = tokenizer.encode(strictNativePrompt, { add_special_tokens: false });
      expect(strictNativeIds).not.toEqual(scenario.inputTokenIds);
      const expectedJsonPrompt = qwenJsonToolPrelude + `\

<|im_start|>user
Use the weather tool for Tokyo.<|im_end|>
<|im_start|>assistant
`;
      // Strictness alone is not the protocol difference: native uses XML
      // function/parameter blocks and a default closed-thinking prefix. The
      // historical JSON protocol must not be mistaken for this native input.
      expect(strictNativePrompt).toContain('<function=example_function_name>');
      expect(expectedJsonPrompt).not.toBe(strictNativePrompt);
      {
        const before = replay.generate.mock.calls.length;
        const capture = captureProviderChat({
          provider: replay.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-2B-ONNX",
            messages: scenario.messages,
            tools: [replay.publicTool],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: { effort: undefined },
            },
          },
        });
        captures.push(capture);
        await expect(capture.completion).rejects.toThrow(QWEN_TOOL_INPUT_STOP);
        const observed = capture.snapshot();
        expect(observed.settlement).toMatchObject({ status: 'rejected' });
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        expect(replay.execute).not.toHaveBeenCalled();
        verifyQwenToolInput({ ...{
          replay, messages: scenario.messages, publicTool: replay.publicTool,
          expectedToolDefinition: strictQwenTools[0], expectedPrompt: strictNativePrompt,
        }, before });
      }

      // Exercise actual public sensitivity, not only a second native render:
      // preserve both changed description and user message in the complete prompt.
      const changedDescription = 'Changed synthetic tool description.';
      const changedContent = 'Use the weather tool for Osaka.';
      expect(expectedJsonPrompt.split(replay.publicTool.description)).toHaveLength(2);
      expect(expectedJsonPrompt.split(scenario.messages[0].content)).toHaveLength(2);
      {
        const before = replay.generate.mock.calls.length;
        const capture = captureProviderChat({
          provider: replay.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-2B-ONNX",
            messages: [{ role: 'user', content: changedContent }],
            tools: [{ ...replay.publicTool, description: changedDescription }],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: { effort: undefined },
            },
          },
        });
        captures.push(capture);
        await expect(capture.completion).rejects.toThrow(QWEN_TOOL_INPUT_STOP);
        const observed = capture.snapshot();
        expect(observed.settlement).toMatchObject({ status: 'rejected' });
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        expect(replay.execute).not.toHaveBeenCalled();
        verifyQwenToolInput({ ...{
          replay, messages: [{ role: 'user', content: changedContent }],
          publicTool: { ...replay.publicTool, description: changedDescription },
          expectedToolDefinition: { ...strictQwenTools[0], function: { ...strictQwenTools[0].function, description: changedDescription } },
          expectedPrompt: strictNativePrompt.replace(replay.publicTool.description, changedDescription).replace(scenario.messages[0].content, changedContent),
        }, before });
      }
      expect(replay.harness.observations.inferenceCalls).toHaveLength(2);
    } finally {
      await replay.close();
    }
    for (const capture of captures) expect(capture.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('tool-result-continuation preserves argument types and result body through native mapping while retaining the raw string-argument failure', async () => {
    const scenario = toolInputEvidence.cases[1];
    const replay = await createQwenToolInputReplay();
    const captures: ProviderChatCapture[] = [];
    const messages: ChatMessage[] = [
      scenario.messages[0],
      { role: 'assistant', content: '', tool_calls: [{
        id: toToolCallId({ raw: 'call_template_probe_1' }), type: 'function',
        function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' },
      }] },
      { role: 'tool', tool_call_id: toToolCallId({ raw: 'call_template_probe_1' }), content: scenario.messages[2].content },
    ];
    try {
      expect(messages).toStrictEqual(scenario.messages);
      const { tokenizer } = replay;
      expect(createHash('sha256').update(tokenizer.get_chat_template({ tools: scenario.tools })).digest('hex')).toBe(scenario.selectedTemplateSha256);
      expect(() => tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: scenario.tools,
      })).toThrow(scenario.error.message);
      expect(() => tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: strictQwenTools,
      })).toThrow(scenario.error.message);

      // Current native XML oracle for an explicit mapping. The handoff captured
      // no successful input IDs for this history; never claim these were recorded.
      const nativeMessages = [
        scenario.messages[0],
        { role: 'assistant', content: '', tool_calls: [{
          id: 'call_template_probe_1', type: 'function',
          function: { name: 'lookup_weather', arguments: { city: 'Tokyo' } },
        }] },
        scenario.messages[2],
      ];
      const nativeFirst = toolInputEvidence.cases[0];
      const userHeader = '<|im_start|>user\n';
      expect(nativeFirst.renderedText.split(userHeader)).toHaveLength(2);
      const nativeSystem = nativeFirst.renderedText.split(userHeader)[0];
      if (nativeSystem === undefined) throw new Error('Missing recorded native tool prelude');
      const strictNativeSystem = nativeSystem.replace('"required": ["city"]', '"required": ["city"], "additionalProperties": false');
      const nativeSuffix = `\
<|im_start|>user
Use the weather tool for Tokyo.<|im_end|>
<|im_start|>assistant
<think>

</think>

<tool_call>
<function=lookup_weather>
<parameter=city>
Tokyo
</parameter>
</function>
</tool_call><|im_end|>
<|im_start|>user
<tool_response>
{"temperatureC":20,"condition":"clear"}
</tool_response><|im_end|>
<|im_start|>assistant
<think>

</think>

`;
      expect(tokenizer.apply_chat_template(nativeMessages, {
        tokenize: false, add_generation_prompt: true, tools: scenario.tools,
      })).toBe(nativeSystem + nativeSuffix);
      expect(tokenizer.apply_chat_template(nativeMessages, {
        tokenize: false, add_generation_prompt: true, tools: strictQwenTools,
      })).toBe(strictNativeSystem + nativeSuffix);
      const expectedJsonPrompt = qwenJsonToolPrelude + `\

<|im_start|>user
Use the weather tool for Tokyo.<|im_end|>
<|im_start|>assistant
<tool_call>
{"name":"lookup_weather","arguments":{"city":"Tokyo"}}
</tool_call>
<|im_end|>
<|im_start|>user
<tool_response>
{"temperatureC":20,"condition":"clear"}
</tool_response>
<|im_end|>
<|im_start|>assistant
`;
      expect(expectedJsonPrompt).not.toBe(strictNativeSystem + nativeSuffix);
      // The parser accepts both syntaxes, but that alone does not establish
      // natural model/tool interoperability. No source output crosses the gap.
      {
        const before = replay.generate.mock.calls.length;
        const capture = captureProviderChat({
          provider: replay.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-2B-ONNX",
            messages,
            tools: [replay.publicTool],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: { effort: undefined },
            },
          },
        });
        captures.push(capture);
        await expect(capture.completion).rejects.toThrow(QWEN_TOOL_INPUT_STOP);
        const observed = capture.snapshot();
        expect(observed.settlement).toMatchObject({ status: 'rejected' });
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        expect(replay.execute).not.toHaveBeenCalled();
        verifyQwenToolInput({ ...{
          replay, messages, publicTool: replay.publicTool,
          expectedToolDefinition: strictQwenTools[0], expectedPrompt: strictNativeSystem + nativeSuffix,
        }, before });
      }

      // Another actual public invocation detects dropped arguments/results.
      // The city stays a string; no expected value is derived from actual output.
      const changedArguments = '{"city":"Osaka"}';
      const changedResult = '{"temperatureC":18,"condition":"rain"}';
      expect(expectedJsonPrompt.split('{"city":"Tokyo"}')).toHaveLength(2);
      expect(expectedJsonPrompt.split(scenario.messages[2].content)).toHaveLength(2);
      {
        const before = replay.generate.mock.calls.length;
        const changedMessages: ChatMessage[] = [
          scenario.messages[0],
          { role: 'assistant', content: '', tool_calls: [{
            id: toToolCallId({ raw: 'call_template_probe_1' }), type: 'function',
            function: { name: 'lookup_weather', arguments: changedArguments },
          }] },
          { role: 'tool', tool_call_id: toToolCallId({ raw: 'call_template_probe_1' }), content: changedResult },
        ];
        const capture = captureProviderChat({
          provider: replay.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-2B-ONNX",
            messages: changedMessages,
            tools: [replay.publicTool],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: { effort: undefined },
            },
          },
        });
        captures.push(capture);
        await expect(capture.completion).rejects.toThrow(QWEN_TOOL_INPUT_STOP);
        const observed = capture.snapshot();
        expect(observed.settlement).toMatchObject({ status: 'rejected' });
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        expect(replay.execute).not.toHaveBeenCalled();
        verifyQwenToolInput({ ...{
          replay,
          messages: changedMessages,
          publicTool: replay.publicTool, expectedToolDefinition: strictQwenTools[0],
          expectedPrompt: (strictNativeSystem + nativeSuffix).replace('\nTokyo\n', '\nOsaka\n').replace(scenario.messages[2].content, changedResult),
        }, before });
      }
      expect(replay.harness.observations.inferenceCalls).toHaveLength(2);
    } finally {
      await replay.close();
    }
    for (const capture of captures) expect(capture.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('tools: executes the recorded minimal Tokyo call once and continues with its result', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["natural-tool-minimal"], artifactPaths: ["onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      const executedSignals: Array<AbortSignal | undefined> = [];
      const executedArgs: unknown[] = [];
      const execute = vi.fn<Tool['execute']>(async ({ args, signal }) => {
        executedArgs.push(structuredClone(args));
        executedSignals.push(signal);
        return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
      });
      const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.", parametersSchema: z.object({ city: z.string() }), execute: execute }];
      replay.beginNativeRequest({ caseId: "natural-tool-minimal", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages: [{ role: "user", content: "Use the weather tool for Tokyo." }],
          tools,
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["", `\
Here is the weather for Tokyo:

*   **Temperature:** 20°C
*   **Condition:** Clear`]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "tool-call", "tool-result", "assistant-start", "settled"]);
      expect(observed.toolEvents).toEqual([]);
      expect(executedArgs).toEqual([{ city: 'Tokyo' }]);
      expect(execute).toHaveBeenCalledOnce();
      expect(executedSignals).toHaveLength(1);
      expect(executedSignals[0]).toBe(signal);
      expect(observed.toolCalls).toHaveLength(1);
      expect(observed.toolCalls[0]).toEqual({ id: expect.any(String), toolName: 'lookup_weather', modelVisibleArguments: '{"city":"Tokyo"}' });
      expect(observed.toolResults).toEqual([{  id: observed.toolCalls[0]!.id, result: { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }  }]);
      replay.assertComplete({ requests: 1, nativeCalls: 2 });
    } finally {
      await replay.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('tools: executes the recorded representative Tokyo call once and continues with its result', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["natural-tool-representative"], artifactPaths: ["onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      const executedSignals: Array<AbortSignal | undefined> = [];
      const executedArgs: unknown[] = [];
      const execute = vi.fn<Tool['execute']>(async ({ args, signal }) => {
        executedArgs.push(structuredClone(args));
        executedSignals.push(signal);
        return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
      });
      const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.", parametersSchema: z.object({ city: z.string() }), execute: execute }];
      replay.beginNativeRequest({ caseId: "natural-tool-representative", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages: [{ role: "user", content: "Use lookup_weather for Tokyo, then give a short answer based on the tool result." }],
          tools,
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["", "Based on the tool result, the weather in Tokyo is **20°C** with **clear** conditions."]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "tool-call", "tool-result", "assistant-start", "settled"]);
      expect(observed.toolEvents).toEqual([]);
      expect(executedArgs).toEqual([{ city: 'Tokyo' }]);
      expect(execute).toHaveBeenCalledOnce();
      expect(executedSignals).toHaveLength(1);
      expect(executedSignals[0]).toBe(signal);
      expect(observed.toolCalls).toHaveLength(1);
      expect(observed.toolCalls[0]).toEqual({ id: expect.any(String), toolName: 'lookup_weather', modelVisibleArguments: '{"city":"Tokyo"}' });
      expect(observed.toolResults).toEqual([{  id: observed.toolCalls[0]!.id, result: { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }  }]);
      replay.assertComplete({ requests: 1, nativeCalls: 2 });
    } finally {
      await replay.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('tools: preserves structured caller history and the recorded response', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["structured-tool-history"], artifactPaths: ["onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"], imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const messages: ChatMessage[] = [{ role: "user", content: "Use the weather tool for Tokyo." }, { role: "assistant", content: "", tool_calls: [{ id: toToolCallId({ raw: "call_model_support_probe_1" }), type: "function", function: { name: "lookup_weather", arguments: "{\"city\":\"Tokyo\"}" } }] }, { role: "tool", content: "{\"temperatureC\":20,\"condition\":\"clear\"}", tool_call_id: toToolCallId({ raw: "call_model_support_probe_1" }) }];
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      const executedSignals: Array<AbortSignal | undefined> = [];
      const executedArgs: unknown[] = [];
      const execute = vi.fn<Tool['execute']>(async ({ args, signal }) => {
        executedArgs.push(structuredClone(args));
        executedSignals.push(signal);
        return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
      });
      const tools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.", parametersSchema: z.object({ city: z.string() }), execute: execute }];
      replay.beginNativeRequest({ caseId: "structured-tool-history", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages,
          tools,
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual([`\
Here is the weather for Tokyo:

*   **Temperature:** 20°C
*   **Condition:** Clear`]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
});

describe('Qwen3.5 2B Provider / images', () => {
  it('images: loads the current vision route and delivers the recorded image token before settlement', async () => {
    const catalog = { context: imageOutputContext, provenance: imageOutputProvenance, sequence: imageOutputSequence, cases: { image: completeImage } } satisfies ProviderReplayCatalog;
    const { context, evidence: recorded } = readProviderRequestEvidence({ catalog, caseId: 'image' });
    const request = recorded.request;
    const invocation = recorded.invocations[0];
    if (request === undefined || invocation === undefined) throw new Error('Missing complete image request');
    expect(recorded.invocations).toHaveLength(1);
    expect(recorded.inputGaps).toEqual([]); expect(recorded.unavailableOutputOrdinals).toEqual([]);
    const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
    const revision = 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb';
    expect([context.modelId, context.metadataRevision, context.observedCacheRevision]).toEqual([modelId, revision, revision]);
    // This is the new source receipt, not a rewrite of the historical Causal
    // receipt. The test verifies actual route/sessions below; it does not issue
    // another collector certificate or replay GPU forward computation.
    expect(context.loadReceipt.autoClass).toBe('AutoModelForImageTextToText');
    expect(context.loadReceipt.processor).toBe('qwen3_5-processor');
    const fixture = readModelFixture({ modelId });
    expect(context.metadata.map(row => row.path).sort()).toEqual([...fixture.files.keys()].sort());
    for (const row of context.metadata) expect(createHash('sha256').update(fixture.files.get(row.path)!).digest('hex')).toBe(row.sha256);
    const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const messages: ChatMessage[] = [{ role: 'user', content: [
      { type: 'text', text: 'Describe the single synthetic image in one short phrase.' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ] }];
    const parameters = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
    expect(request.input).toEqual({ messages, tools: [], parameters: { ...parameters, presencePenalty: null, frequencyPenalty: null, stop: null, reasoning: { effort: null } } });
    const artifacts = ['onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
      'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data'];
    const platform = createProviderReplayTestImagePlatform();
    let generations = 0;
    const harness = await createProviderReplayTestRuntime({ modelId, expectedRevision: revision, cacheRevision: revision,
      metadataCache: context.localMetadataPaths, artifacts: artifacts.map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
      imagePlatform: { platform, allowedDataUrls: [imageUrl] },
      generate: async ({ options, runtime, model }) => {
        ++generations;
        expect(generations).toBe(1);
        expect(Object.keys(model.sessions).sort()).toEqual(['decoder_model_merged', 'embed_tokens', 'vision_encoder']);
        const { localOrdinal, ...facts } = invocation;
        return replayCapturedFullInvocation({ invocation: { ...facts, callOrdinal: localOrdinal, scenario: 'image' }, options, runtime, modelConfig: model.config, parameters });
      },
    });
    let capture: ProviderChatCapture | undefined;
    try {
      await harness.service.loadDownloadedModel({ modelId });
      expect(harness.observations.modelLoadCalls).toEqual(['AutoModelForImageTextToText']);
      expect(harness.observations.processors).toHaveLength(1);
      expect(harness.observations.processors[0]!.constructor.name).toBe('Qwen3VLProcessor');
      const expectedSessions = ['decoder_model_merged_q4f16', 'embed_tokens_q4f16', 'vision_encoder_q4f16'].map(name => ({
        modelId, revision, corePath: `onnx/${name}.onnx`,
        externalData: [{ path: `${name}.onnx_data`, artifactPath: `onnx/${name}.onnx_data` }], executionProviders: ['webgpu'],
      }));
      expect(harness.observations.ortCalls.map(([core, options]) => inspectSyntheticOrtSession({ modelId, revision, repositoryPaths: new Set(artifacts), core, options }))
        .sort((a, b) => a.corePath.localeCompare(b.corePath))).toEqual(expectedSessions);
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: modelId,
          messages,
          tools: [],
          parameters,
          signal: new AbortController().signal,
        },
      });
      await capture.completion;
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(['A']);
      expect(observed.chunks).toEqual(['A']);
      expect(observed.events.map(event => event.kind)).toEqual(['assistant-start', 'chunk', 'settled']);
      expect(request.events).toEqual([
        { sequence: 0, phase: 'before-settlement', kind: 'assistant-start' },
        { sequence: 1, phase: 'before-settlement', kind: 'chunk', chunk: 'A' },
      ]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(generations).toBe(1); expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(platform.observations.decodes).toHaveLength(1);
      expect(harness.observations.localImageFetchCalls).toEqual([imageUrl]);
      expect(harness.observations.workers).toHaveLength(1);
      const loadMessage = z.object({ type: z.literal('APPLY'), path: z.tuple([z.literal('loadDownloadedModel')]) });
      expect(harness.observations.workers[0]!.hostMessages.filter(message => loadMessage.safeParse(message).success)).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
      expect(harness.observations.workers.every(worker => worker.terminated)).toBe(true);
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it.each(qwen2ImageCases)('$name has independently derived pixels, grid and complete native text input', async ({ imageUrl, rgba, rescaled }) => {
    const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
    const revision = 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb';
    const metadata = readModelFixture({ modelId });
    expect(metadata.summary.revision).toBe(revision);
    expect(createHash('sha256').update(metadata.files.get('preprocessor_config.json')!).digest('hex'))
      .toBe('6a970fd06f30e6943b3e2c14d5d3b42d49b06cf99b99103d56689bef462d90f8');
    expect(createHash('sha256').update(metadata.files.get('processor_config.json')!).digest('hex'))
      .toBe('14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b');
    const selectedConfig = z.object({
      size: z.object({ longest_edge: z.literal(16777216), shortest_edge: z.literal(65536) }).strict(),
      patch_size: z.literal(16), temporal_patch_size: z.literal(2), merge_size: z.literal(2),
      image_mean: z.tuple([z.literal(0.5), z.literal(0.5), z.literal(0.5)]),
      image_std: z.tuple([z.literal(0.5), z.literal(0.5), z.literal(0.5)]),
      processor_class: z.literal('Qwen3VLProcessor'), image_processor_type: z.literal('Qwen2VLImageProcessorFast'),
    }).strict().parse(JSON.parse(new TextDecoder().decode(metadata.files.get('preprocessor_config.json')!)));
    const nestedConfig = z.object({ image_processor: z.object({ do_normalize: z.literal(true) }) })
      .parse(JSON.parse(new TextDecoder().decode(metadata.files.get('processor_config.json')!)));
    expect(nestedConfig.image_processor.do_normalize).toBe(true);
    const messages: ChatMessage[] = [{ role: 'user', content: [
      { type: 'text', text: 'Describe this synthetic Qwen2 image.' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ] }];
    const platform = createProviderReplayTestImagePlatform();
    const generate = vi.fn<ProviderReplayGenerate>(async () => {
      throw new Error('Native image control must never generate');
    });
    const harness = await createProviderReplayTestRuntime({
      modelId, expectedRevision: revision, cacheRevision: revision, metadataCache: "all-fixture", imagePlatform: { platform, allowedDataUrls: [imageUrl] },
      // This model's own inventory, with synthetic native-weight substitutes.
      // Current routing also loads the vision session; input-only controls
      // still do not claim to execute native image inference.
      artifacts: [
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
      generate,
    });
    try {
      await harness.service.loadDownloadedModel({ modelId });
      expect(harness.observations.processors).toHaveLength(1);
      const processor = harness.observations.processors[0];
      if (!processor?.tokenizer) throw new Error('Expected actual Qwen2 processor/tokenizer');
      expect(processor.constructor.name).toBe('Qwen3VLProcessor');
      expect(harness.runtime.env.version).toBe('4.2.0');
      expect(createHash('sha256').update(processor.tokenizer.get_chat_template()).digest('hex'))
        .toBe('273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80');
      expect(processor.tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true }))
        .toBe(qwen2NativeImagePrompt);
      const imageProcessor = processor.image_processor;
      if (typeof imageProcessor !== 'function') throw new Error('Expected actual callable image processor');
      expect(Reflect.get(imageProcessor, 'config')).toEqual(selectedConfig);
      // TJS 4.2 AutoImageProcessor reads preprocessor_config; inherited
      // uses_processor_config=false leaves the separate nested normalize=true
      // unused. The selected file omits do_normalize, so current native output
      // is 0/1, NOT the -1/+1 that normalization would produce. This records the
      // selected native route, not correctness for the model's vision weights.
      expect({
        rescale: Reflect.get(imageProcessor, 'do_rescale'),
        scale: Reflect.get(imageProcessor, 'rescale_factor'),
        normalize: Reflect.get(imageProcessor, 'do_normalize'),
        rgb: Reflect.get(imageProcessor, 'do_convert_rgb'),
      }).toEqual({ rescale: true, scale: 1 / 255, normalize: undefined, rgb: true });
      const rawImage = await harness.runtime.RawImage.read(imageUrl);
      expect(rawImage).toBeInstanceOf(harness.runtime.RawImage);
      expect({ width: rawImage.width, height: rawImage.height, channels: rawImage.channels })
        .toEqual({ width: 1, height: 1, channels: 4 });
      expect(rawImage.data).toEqual(rgba);
      const native = z.object({
        input_ids: z.instanceof(harness.runtime.Tensor), attention_mask: z.instanceof(harness.runtime.Tensor),
        pixel_values: z.instanceof(harness.runtime.Tensor), image_grid_thw: z.instanceof(harness.runtime.Tensor),
      }).parse(await processor(qwen2NativeImagePrompt, rawImage));
      // Own min-area 65536 and aspect 1 yield 256x256; patch16 gives 16x16.
      // Temporal2 duplicates the frame: 3 * 2 * 16 * 16 = 1536 per patch.
      // Grid product / merge_size^2 expands the one image marker to 64 tokens.
      const expectedPixels = new Float32Array(256 * 1536).fill(rescaled);
      const expectedGrid = BigInt64Array.of(1n, 16n, 16n);
      const expectedText = qwen2NativeImagePrompt.replace('<|image_pad|>', '<|image_pad|>'.repeat(64));
      const expectedIds = processor.tokenizer.encode(expectedText, { add_special_tokens: false });
      expect({ type: native.pixel_values.type, location: native.pixel_values.location, dims: native.pixel_values.dims })
        .toEqual({ type: 'float32', location: 'cpu', dims: [256, 1536] });
      // Every value is compared; avoid constructing a huge diff on failure.
      expect(isDeepStrictEqual(native.pixel_values.data, expectedPixels)).toBe(true);
      expect({ type: native.image_grid_thw.type, location: native.image_grid_thw.location, dims: native.image_grid_thw.dims })
        .toEqual({ type: 'int64', location: 'cpu', dims: [1, 3] });
      expect(native.image_grid_thw.data).toEqual(expectedGrid);
      expect(Array.from(native.input_ids.data, Number)).toEqual(expectedIds);
      expect(native.attention_mask.data).toEqual(new BigInt64Array(expectedIds.length).fill(1n));
      for (const tensor of [native.input_ids, native.attention_mask]) {
        expect({ type: tensor.type, location: tensor.location, dims: tensor.dims })
          .toEqual({ type: 'int64', location: 'cpu', dims: [1, expectedIds.length] });
      }
      expect(platform.observations.decodes).toEqual([{
        bytes: Uint8Array.from(Buffer.from(imageUrl.split(',')[1]!, 'base64')), rgba,
      }]);
      expect(platform.observations.draws).toEqual([
        { sourceWidth: 1, sourceHeight: 1, targetWidth: 1, targetHeight: 1 },
        { sourceWidth: 1, sourceHeight: 1, targetWidth: 256, targetHeight: 256 },
      ]);
      expect(harness.observations.localImageFetchCalls).toEqual([imageUrl]);
      expect(generate).not.toHaveBeenCalled();
      expect(harness.observations.inferenceCalls).toEqual([]);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.ortCalls).toHaveLength(3);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
  it.each(qwen2ImageCases)('$name reaches generation as actual image tensors, not serialized URL text', async ({ imageUrl, rgba, rescaled }) => {
    const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
    const revision = 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb';
    const messages: ChatMessage[] = [{ role: 'user', content: [
      { type: 'text', text: 'Describe this synthetic Qwen2 image.' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ] }];
    const boundary = 'Qwen2 public image input observed; no image generation tokens supplied';
    const platform = createProviderReplayTestImagePlatform();
    const inputs: ReturnType<typeof snapshotQwenInput>[] = [];
    const harness = await createProviderReplayTestRuntime({
      modelId, expectedRevision: revision, cacheRevision: revision, metadataCache: "all-fixture", imagePlatform: { platform, allowedDataUrls: [imageUrl] },
      artifacts: [
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
      generate: async context => {
        inputs.push(snapshotQwenInput({ context }));
        // Inspect only. No source image tensor/capture authorizes output here.
        throw new Error(boundary);
      },
    });
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: modelId,
          messages,
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
        },
      });
      await expect(capture.completion).rejects.toThrow(boundary);
      const observed = capture.snapshot();
      expect(observed.settlement).toMatchObject({ status: 'rejected' });
      expect(inputs).toHaveLength(1);
      const actual = inputs[0];
      if (!actual) throw new Error('Public Qwen2 image input did not reach generation');
      expect(harness.observations.processors).toHaveLength(1);
      const processor = harness.observations.processors[0];
      if (!processor?.tokenizer) throw new Error('Expected actual Qwen2 processor/tokenizer');
      expect(actual.tokenizer).toBe(processor.tokenizer);
      expect(processor.constructor.name).toBe('Qwen3VLProcessor');
      expect(createHash('sha256').update(actual.tokenizer.get_chat_template()).digest('hex'))
        .toBe('273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80');
      expect(actual.options.input_ids).toBeDefined();
      expect(actual.options.attention_mask).toBeDefined();
      expect(actual.options.past_key_values).toBeNull();
      expect({
        maxNewTokens: actual.options.max_new_tokens, temperature: actual.options.temperature,
        topP: actual.options.top_p, doSample: actual.options.do_sample,
      }).toEqual({ maxNewTokens: 1, temperature: 0, topP: 1, doSample: false });
      expect(actual.options.return_dict_in_generate).toBe(true);
      expect(actual.streamerIsTextStreamer).toBe(true);
      expect(actual.stoppingCriteriaType).toBe('function');
      expect(observed.chunks).toEqual([]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.ortCalls).toHaveLength(3);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // This test never invokes a separate RawImage/processor control. Every
      // image fetch/decode here must come from the actual public request.
      // The known missing-image RED is independent of the native-default
      // thinking suffix discrepancy protected in the earlier text scenarios.
      const imageInput = {
        imageFetches: harness.observations.localImageFetchCalls,
        hasPixels: actual.options.pixel_values !== undefined,
        hasGrid: actual.options.image_grid_thw !== undefined,
      };
      expect(imageInput, JSON.stringify(imageInput)).toEqual({ imageFetches: [imageUrl], hasPixels: true, hasGrid: true });
      const { input_ids, attention_mask, pixel_values, image_grid_thw } = actual.options;
      if (!input_ids || !attention_mask || !pixel_values || !image_grid_thw) throw new Error('Expected four actual image Tensor snapshots');
      const tensors = { input_ids, attention_mask, pixel_values, image_grid_thw };
      expect(actual.optionKeys).toEqual([
        'attention_mask', 'do_sample', 'image_grid_thw', 'input_ids', 'max_new_tokens', 'past_key_values',
        'pixel_values', 'original_sizes', 'reshaped_input_sizes', 'return_dict_in_generate', 'stopping_criteria', 'streamer', 'temperature', 'top_p',
      ].sort());
      expect(actual.options.original_sizes).toEqual([[1, 1]]);
      expect(actual.options.reshaped_input_sizes).toEqual([[256, 256]]);
      expect(qwen2NativeImagePrompt).not.toBe(qwen2ProductionImagePrompt);
      const expectedText = qwen2NativeImagePrompt.replace('<|image_pad|>', '<|image_pad|>'.repeat(64));
      const expectedIds = actual.tokenizer.encode(expectedText, { add_special_tokens: false });
      expect(Array.from(tensors.input_ids.data, Number)).toEqual(expectedIds);
      expect(tensors.attention_mask.data).toEqual(new BigInt64Array(expectedIds.length).fill(1n));
      for (const tensor of [tensors.input_ids, tensors.attention_mask]) {
        expect({ type: tensor.type, location: tensor.location, dims: tensor.dims })
          .toEqual({ type: 'int64', location: 'cpu', dims: [1, expectedIds.length] });
      }
      expect({ type: tensors.pixel_values.type, location: tensors.pixel_values.location, dims: tensors.pixel_values.dims })
        .toEqual({ type: 'float32', location: 'cpu', dims: [256, 1536] });
      expect(isDeepStrictEqual(tensors.pixel_values.data, new Float32Array(256 * 1536).fill(rescaled))).toBe(true);
      expect({ type: tensors.image_grid_thw.type, location: tensors.image_grid_thw.location, dims: tensors.image_grid_thw.dims })
        .toEqual({ type: 'int64', location: 'cpu', dims: [1, 3] });
      expect(tensors.image_grid_thw.data).toEqual(BigInt64Array.of(1n, 16n, 16n));
      expect(platform.observations.decodes).toEqual([{
        bytes: Uint8Array.from(Buffer.from(imageUrl.split(',')[1]!, 'base64')), rgba,
      }]);
    } finally {
      await harness.close();
    }
    expect(capture?.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
});

describe('Qwen3.5 2B Provider / sequences', () => {
  it('sequences: builds continuation from actually delivered first-request settlement', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ["first-turn","continuity"], artifactPaths: ["onnx/decoder_model_merged_q4f16.onnx","onnx/decoder_model_merged_q4f16.onnx_data","onnx/embed_tokens_q4f16.onnx","onnx/embed_tokens_q4f16.onnx_data","onnx/vision_encoder_q4f16.onnx","onnx/vision_encoder_q4f16.onnx_data"], imagePlatform: undefined });
    const captures: ProviderChatCapture[] = [];
    try {
      const firstSignal = new AbortController().signal;
      const firstParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "first-turn", parameters: firstParameters });
      const firstCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages: [{ role: "user", content: "Template probe user message." }],
          tools: [],
          parameters: firstParameters,
          signal: firstSignal,
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;
      replay.endNativeRequest();
      const firstObserved = firstCapture.snapshot();
      expect(firstObserved.settlement).toEqual({ status: 'fulfilled' });
      expect(firstObserved.responses.map(chunks => chunks.join(''))).toEqual(["It looks like you might be looking for a **prompt template** to use with"]);
      expect(firstObserved.preStartChunks).toEqual([]);
      expect(firstObserved.lateEvents).toEqual([]);
      expect(firstObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(firstObserved.toolEvents).toEqual([]);
      expect(firstObserved.toolCalls).toEqual([]);
      expect(firstObserved.toolResults).toEqual([]);
      const nextMessages: ChatMessage[] = [{ role: "user", content: "Template probe user message." }, { role: "assistant", content: firstObserved.responses[0]!.join('') }, { role: "user", content: "Continue the synthetic conversation with a short response." }];
      const nextSignal = new AbortController().signal;
      const nextParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "continuity", parameters: nextParameters });
      const nextCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-2B-ONNX",
          messages: nextMessages,
          tools: [],
          parameters: nextParameters,
          signal: nextSignal,
        },
      });
      captures.push(nextCapture);
      await nextCapture.completion;
      replay.endNativeRequest();
      const nextObserved = nextCapture.snapshot();
      expect(nextObserved.settlement).toEqual({ status: 'fulfilled' });
      expect(nextObserved.responses.map(chunks => chunks.join(''))).toEqual(["Got it! I'm ready to continue the conversation. What would you like to"]);
      expect(nextObserved.preStartChunks).toEqual([]);
      expect(nextObserved.lateEvents).toEqual([]);
      expect(nextObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(nextObserved.toolEvents).toEqual([]);
      expect(nextObserved.toolCalls).toEqual([]);
      expect(nextObserved.toolResults).toEqual([]);
      replay.assertComplete({ requests: 2, nativeCalls: 2 });
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents), 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('preserves twelve recorded text/tool requests and verifies the recorded image input without inventing image output', async () => {
    const fullEvidenceJson = assembleProviderSequenceEvidence({ catalog: providerReplayCatalog });
    const recorded = parseCapturedFullReplay({ value: fullEvidenceJson });
    expect(recorded.modelId).toBe('onnx-community/Qwen3.5-2B-ONNX');
    expect(recorded.metadataRevision).toBe('b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb');
    expect(recorded.loadReceipt.autoClass).toBe('AutoModelForCausalLM');
    const platform = createProviderReplayTestImagePlatform();
    const gap = recorded.nativeInputGaps?.[0];
    if (gap === undefined) throw new Error('Missing observed Qwen image input');
    const vision = ['onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data'];
    // The source local inventory already held vision files. Current routing now
    // actually plans them; this is an intentional source correction, not the
    // historical CausalLM receipt or proof of successful native image inference.
    const currentReceipt = { ...recorded.loadReceipt, autoClass: 'AutoModelForImageTextToText' as const,
      plannedRequiredPaths: [...recorded.loadReceipt.plannedRequiredPaths, ...vision].sort(),
      cacheLookup: { ...recorded.loadReceipt.cacheLookup, hitPaths: [...new Set([...recorded.loadReceipt.cacheLookup.hitPaths, ...vision])].sort() },
    };
    const imageInputs: ReturnType<typeof snapshotQwenInput>[] = [];
    await verifyCapturedFullReplay({ evidence: recorded, completeResult: undefined, expectedLoadReceipt: currentReceipt,
      reviewedPublicContract: {
        correctedEvents: recorded.requests.filter(request => ['reasoning-low', 'reasoning-medium', 'reasoning-high'].includes(request.scenario)).map(request => ({
          scenario: request.scenario,
          reason: 'The explicitly enabled native prompt owns the opening thinking tag; preserve all recorded chunks after restoring it.',
          expectedEvents: [
            { sequence: 0, phase: 'before-settlement', kind: 'assistant-start' },
            { sequence: 1, phase: 'before-settlement', kind: 'chunk', chunk: '<think>' },
            { sequence: 2, phase: 'before-settlement', kind: 'chunk', chunk: 'Okay' },
          ],
        })),
        invalidatedOutputs: [],
      },
      imagePlatform: { platform, allowedDataUrls: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='] },
      artifactPaths: ['onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data', 'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data', ...vision],
      unavailableOutputs: [{ callOrdinal: 15, scenario: 'image', requestInput: gap.requestInput,
        expectedEventsBeforeGap: [{ sequence: 0, phase: 'before-settlement', kind: 'assistant-start' }],
        verifyInput: context => {
          imageInputs.push(snapshotQwenInput({ context }));
          // The Full harness unconditionally stops this unavailable-output
          // invocation after observation; no recorded stream is released here.
        },
      }],
    });
    expect(imageInputs).toHaveLength(1);
    const actualInput = imageInputs[0]!;
    const { options } = actualInput;
    expect(gap.callOrdinal).toBe(15);
    expect(gap.scenario).toBe('image');
    expect(actualInput.optionKeys).toEqual([...gap.settings.kwargs.keys.values].sort());
    expect(gap.preInputs).toEqual(gap.inputs);
    const tensors = { input_ids: options.input_ids, attention_mask: options.attention_mask, pixel_values: options.pixel_values, image_grid_thw: options.image_grid_thw };
    const values: Record<string, unknown> = options;
    for (const input of gap.inputs) {
      switch (input.value.kind) {
      case 'tensor': {
        const tensor = tensors[z.enum(['input_ids', 'attention_mask', 'pixel_values', 'image_grid_thw']).parse(input.name)];
        if (!tensor || !ArrayBuffer.isView(tensor.data)) throw new Error('Missing actual Qwen image Tensor snapshot');
        const { kind: _kind, ...fact } = input.value;
        const bytes = new Uint8Array(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength);
        expect({ dtype: tensor.type, dims: tensor.dims, byteLength: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }, input.name).toEqual(fact);
        break;
      }
      case 'image-sizes': case 'scalar': expect(values[input.name], input.name).toEqual(input.value.value); break;
      default: { const exhaustive: never = input.value; throw new Error(String(exhaustive)); }
      }
    }
    expect(options.past_key_values).toBeNull();
    expect([options.max_new_tokens, options.temperature, options.top_p, options.do_sample, options.return_dict_in_generate]).toEqual([1, 0, 1, false, true]);
    expect(actualInput.streamerIsTextStreamer).toBe(true);
    expect(actualInput.stoppingCriteriaType).toBe('function');
    expect(platform.observations.decodes).toHaveLength(1);
  }, 30_000);
});
