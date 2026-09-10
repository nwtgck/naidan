// @vitest-environment node
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, vi, type MockInstance } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';
import evidenceJson from './production-replay-qwen3.5-2b.evidence.json';
import inputJson from './production-replay-qwen3.5-2b.input.evidence.json';
import toolInputJson from './production-replay-qwen3.5-2b.tool-input.evidence.json';
import productionJson from './production-replay-qwen3.5-2b.production.evidence.json';
import continuityJson from './production-replay-qwen3.5-2b.continuity.evidence.json';
import reasoningJson from './production-replay-qwen3.5-2b.reasoning.evidence.json';
import { parseProductionReplayTextEvidence, replayRecordedText } from './production-replay-test-causal-gate';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from './download-verification/fixtures/raw-download-replay/synthetic-session-oracle';
import { createProductionReplayTestRuntime, type ProductionReplayGenerate } from './production-replay-test-runtime';
import { createProductionReplayTestImagePlatform } from './production-replay-test-image-platform';
import { readModelFixture } from '@/features/transformers-js/download-verification/fixtures/model-runtime-fixture';

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
  const generate = vi.fn<ProductionReplayGenerate>(async () => {
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
  const harness = await createProductionReplayTestRuntime({
    modelId: toolInputEvidence.modelId, expectedRevision: toolInputEvidence.revision, imagePlatform: undefined,
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
    const serializer = await import('./models/qwen3_5');
    const builderSpy = vi.spyOn(serializer, 'buildQwen3_5Prompt');
    const processorSpy = vi.spyOn(processor, '_call');
    return {
      harness, generate, execute, publicTool, processor, tokenizer: processor.tokenizer, builderSpy, processorSpy,
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
async function captureQwenToolInput({
  replay, messages, publicTool, expectedToolDefinition, expectedPrompt,
}: {
  replay: Awaited<ReturnType<typeof createQwenToolInputReplay>>,
  messages: ChatMessage[],
  publicTool: Tool,
  expectedToolDefinition: z.infer<typeof publicToolDefinitionSchema>,
  expectedPrompt: string,
}) {
  const before = replay.generate.mock.calls.length;
  const chunks: string[] = [];
  const onToolCall = vi.fn();
  const onToolResult = vi.fn();
  await expect(replay.harness.provider.chat({
    model: toolInputEvidence.modelId, messages, tools: [publicTool],
    parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
    onChunk: ({ chunk }) => chunks.push(chunk), onToolCall, onToolResult,
  })).rejects.toThrow(QWEN_TOOL_INPUT_STOP);
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
  const context = replay.generate.mock.calls[before]?.[0];
  if (!context) throw new Error('No actual inference boundary');
  const { options, runtime } = context;
  if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) {
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
  expect(chunks).toEqual([]);
  expect(replay.execute).not.toHaveBeenCalled();
  expect(onToolCall).not.toHaveBeenCalled();
  expect(onToolResult).not.toHaveBeenCalled();
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
  const replay = parseProductionReplayTextEvidence({ value: rawReplay });
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
  harness: Awaited<ReturnType<typeof createProductionReplayTestRuntime>>,
  capture: ReturnType<typeof parseRecordedQwenCapture>, effort: 'none' | 'high' | undefined,
  expectedMode: 'default' | 'disabled' | 'enabled', expectedPrompt: string,
}) {
  const serializer = await import('./models/qwen3_5');
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

async function verifyRecordedQwenOutput({ capture, effort, expectedMode, expectedPrompt, verifyBeforeRelease }: {
  capture: ReturnType<typeof parseRecordedQwenCapture>,
  effort: 'none' | 'high' | undefined, expectedMode: 'default' | 'disabled' | 'enabled', expectedPrompt: string,
  verifyBeforeRelease: ({ context }: { context: Parameters<ProductionReplayGenerate>[0] }) => void,
}) {
  const { replay } = capture;
  let releasedTokenCount = 0;
  let gateAccepted = false;
  let builderSpy: MockInstance<typeof import('./models/qwen3_5').buildQwen3_5Prompt> | undefined;
  let historicalAdapter: Awaited<ReturnType<typeof installHistoricalQwenSerializer>> | undefined;
  const harness = await createProductionReplayTestRuntime({
    modelId: 'onnx-community/Qwen3.5-2B-ONNX', expectedRevision: 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb',
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
    try {
      let assistantStarts = 0;
      const chunks: string[] = [];
      const toolCalls: unknown[] = [];
      const toolEvents: unknown[] = [];
      const toolResults: unknown[] = [];
      await harness.provider.chat({
        model: replay.identity.modelId, messages: replay.scenario.messages, tools: [],
        parameters: {
          ...replay.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined,
          stop: undefined, reasoning: { effort },
        },
        onAssistantMessageStart: () => {
          assistantStarts += 1;
        },
        onChunk: ({ chunk }) => chunks.push(chunk),
        onToolCall: event => toolCalls.push(event),
        onToolEvent: event => toolEvents.push(event),
        onToolResult: event => toolResults.push(event),
      });
      // Snapshot immediately on Provider settlement. No sleep, message drain,
      // replayed callback queue, or browser scheduling claim is added here.
      const settled = { assistantStarts, chunks: [...chunks], toolCalls: [...toolCalls], toolEvents: [...toolEvents], toolResults: [...toolResults] };
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
      expect(settled).toStrictEqual({
        assistantStarts: 1, chunks: capture.streamChunks, toolCalls: [], toolEvents: [], toolResults: [],
      });
    } finally {
      processorSpy.mockRestore();
    }
  } finally {
    historicalAdapter?.restore();
    await harness.close();
  }
}

function createQwenReplay({ generate }: { generate: ProductionReplayGenerate }) {
  const metadata = readModelFixture({ modelId: evidence.identity.modelId });
  expect(createHash('sha256').update(metadata.files.get('tokenizer.json')!).digest('hex')).toBe('89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b');
  expect(createHash('sha256').update(metadata.files.get('tokenizer_config.json')!).digest('hex')).toBe('fccbff64ebe09343aa2171028657f5b038db96fb4f657609bc76743eddfa3b9d');
  expect(evidence.productionInput.messages).toEqual(evidence.nativeTemplate.messages);
  return createProductionReplayTestRuntime({
    imagePlatform: undefined,
    modelId: evidence.identity.modelId, expectedRevision: evidence.identity.resolvedRevision,
    artifacts: [
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
    ].map(path => ({ path, bytes: new TextEncoder().encode(`synthetic Qwen model artifact: ${path}`) })),
    generate,
  });
}

async function createHistoricalMutationControl() {
  const generate = vi.fn<ProductionReplayGenerate>(async () => {
    throw new Error('Historical mutation must stop before native token release');
  });
  const harness = await createQwenReplay({ generate });
  await harness.service.loadDownloadedModel({ modelId: firstQwenCapture.replay.identity.modelId });
  const adapter = await installHistoricalQwenSerializer({ harness, capture: firstQwenCapture, effort: undefined, expectedMode: 'default', expectedPrompt: recordedQwenUserPrompt });
  const chunks: string[] = [];
  const request = {
    model: firstQwenCapture.replay.identity.modelId, messages: structuredClone(firstQwenCapture.replay.scenario.messages), tools: [],
    parameters: { ...firstQwenCapture.replay.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined,
      stop: undefined, reasoning: { effort: undefined } },
    onChunk: ({ chunk }: { chunk: string }) => chunks.push(chunk), onToolCall: vi.fn(), onToolEvent: vi.fn(), onToolResult: vi.fn(),
  };
  return { harness, adapter, generate, request, chunks, async close() {
    adapter.restore(); await harness.close();
  } };
}

async function verifyCurrentQwenRejectsHistoricalOutput({ capture, effort, expectedNativePrompt }: {
  capture: ReturnType<typeof parseRecordedQwenCapture>, effort: 'none' | 'high' | undefined, expectedNativePrompt: string,
}) {
  const stop = 'Current native Qwen input verified; historical output is ineligible';
  let rejectedLegacyGates = 0;
  const harness = await createQwenReplay({ generate: async ({ options, tokenizer, runtime }) => {
    const thinking = effort === undefined ? {} : { enable_thinking: effort !== 'none' };
    expect(tokenizer.apply_chat_template(capture.replay.scenario.messages, { tokenize: false, add_generation_prompt: true, ...thinking })).toBe(expectedNativePrompt);
    const expectedIds = tokenizer.encode(expectedNativePrompt, { add_special_tokens: false });
    if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor) || !(options.streamer instanceof runtime.TextStreamer)) throw new Error('Expected actual current native Qwen tensors and streamer');
    expect(Array.from(options.input_ids.data, Number)).toEqual(expectedIds);
    expect(Array.from(options.attention_mask.data, BigInt)).toEqual(expectedIds.map(() => 1n));
    expect(options.past_key_values).toBeNull();
    const put = vi.spyOn(options.streamer, 'put');
    const end = vi.spyOn(options.streamer, 'end');
    try {
      expect(() => replayRecordedText({ evidence: capture.replay, options })).toThrow('Replay causal mismatch: actual source input');
      rejectedLegacyGates++;
      expect(put).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
    } finally {
      put.mockRestore(); end.mockRestore();
    }
    throw new Error(stop);
  } });
  try {
    const chunks: string[] = [];
    await expect(harness.provider.chat({
      model: capture.replay.identity.modelId, messages: capture.replay.scenario.messages, tools: [],
      parameters: { ...capture.replay.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort } },
      onChunk: ({ chunk }) => chunks.push(chunk),
    })).rejects.toThrow(stop);
    expect(rejectedLegacyGates).toBe(1);
    expect(chunks).toEqual([]);
    expect(harness.observations.inferenceCalls).toHaveLength(1);
    expect(harness.observations.workers).toHaveLength(1);
    expect(harness.observations.ortCalls).toHaveLength(2);
    expect(harness.observations.localImageFetchCalls).toEqual([]);
    expect(harness.observations.forbiddenTransport).toEqual([]);
    expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  } finally {
    await harness.close();
  }
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

describe('Qwen2 recorded Production text output with exact causal input; native parity remains separate', () => {
  it('rejects changed messages at the historical adapter before releasing any native tokens', async () => {
    const control = await createHistoricalMutationControl();
    try {
      control.request.messages[0]!.content = 'Changed synthetic message.';
      await expect(control.harness.provider.chat(control.request)).rejects.toThrow();
      expect(control.adapter.serviceSpy).toHaveBeenCalledOnce();
      expect(control.adapter.builderSpy).not.toHaveBeenCalled();
      expect(control.generate).not.toHaveBeenCalled();
      expect(control.harness.observations.inferenceCalls).toHaveLength(0);
      expect(control.chunks).toEqual([]);
    } finally {
      await control.close();
    }
  }, 30_000);

  it('rejects changed generation parameters at the historical adapter before releasing any native tokens', async () => {
    const control = await createHistoricalMutationControl();
    try {
      await expect(control.harness.provider.chat({ ...control.request, parameters: { ...control.request.parameters, maxCompletionTokens: 15 } })).rejects.toThrow();
      expect(control.adapter.serviceSpy).toHaveBeenCalledOnce();
      expect(control.adapter.builderSpy).not.toHaveBeenCalled();
      expect(control.generate).not.toHaveBeenCalled();
      expect(control.harness.observations.inferenceCalls).toHaveLength(0);
      expect(control.chunks).toEqual([]);
    } finally {
      await control.close();
    }
  }, 30_000);

  it('rejects a changed selected template at the historical adapter before releasing any native tokens', async () => {
    const control = await createHistoricalMutationControl();
    const tokenizer = control.harness.observations.processors[0]!.tokenizer;
    if (tokenizer === undefined) throw new Error('Expected the selected native tokenizer');
    const template = vi.spyOn(tokenizer, 'get_chat_template').mockReturnValue('changed synthetic template');
    try {
      await expect(control.harness.provider.chat(control.request)).rejects.toThrow();
      expect(control.adapter.serviceSpy).toHaveBeenCalledOnce();
      expect(control.adapter.builderSpy).toHaveBeenCalledOnce();
      expect(template).toHaveBeenCalledOnce();
      expect(control.generate).not.toHaveBeenCalled();
      expect(control.harness.observations.inferenceCalls).toHaveLength(0);
      expect(control.chunks).toEqual([]);
    } finally {
      template.mockRestore(); await control.close();
    }
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
    let verifiedInputs = 0;
    const harness = await createProductionReplayTestRuntime({
      modelId: 'onnx-community/Qwen3.5-2B-ONNX', expectedRevision: source.identity.resolvedRevision, imagePlatform: undefined,
      // Identifiable synthetic bodies replace native weight execution only.
      artifacts: ['onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data', 'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data'].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: 'onnx-community/Qwen3.5-2B-ONNX', revision: source.identity.resolvedRevision, path }),
      })),
      generate: async ({ options, tokenizer, runtime }) => {
        expect(runtime.env.version).toBe(source.identity.transformersJsVersion);
        expect(tokenizer).toBeInstanceOf(runtime.PreTrainedTokenizer);
        expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'))
          .toBe('273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80');
        expect(tokenizer).toBe(harness.observations.processors[0]?.tokenizer);
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
        expect(options.streamer).toBeInstanceOf(runtime.TextStreamer);
        expect(typeof options.stopping_criteria).toBe('function');
        ++verifiedInputs;
        // Never call replayRecordedText, streamer.put/end or return sequences.
        // This positive input test remains independent of callback delivery.
        throw new Error(stop);
      },
    });
    const historicalAdapter = await installHistoricalQwenSerializer({ harness, capture: firstQwenCapture, effort: undefined, expectedMode: 'default', expectedPrompt: recordedQwenUserPrompt });
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
      expect(historicalAdapter.builderSpy).toHaveBeenCalledOnce();
      expect(chunks).toEqual([]);
      expect(onToolCall).not.toHaveBeenCalled();
      expect(onToolEvent).not.toHaveBeenCalled();
      expect(onToolResult).not.toHaveBeenCalled();
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
  }, 30_000);
});

describe('Qwen3.5 2B public Provider input contract; no inference replay', () => {
  it('rejects historical first-turn output at the repaired native input without a legacy adapter', async () => {
    await verifyCurrentQwenRejectsHistoricalOutput({ capture: firstQwenCapture, effort: undefined, expectedNativePrompt: recordedQwenUserPrompt + `\
<think>

</think>

` });
  }, 30_000);

  it('rejects historical raw-history output at the repaired native input without a legacy adapter', async () => {
    await verifyCurrentQwenRejectsHistoricalOutput({ capture: historyQwenCapture, effort: undefined, expectedNativePrompt: `\
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
  }, 30_000);

  it('rejects historical none output at the repaired native input without a legacy adapter', async () => {
    await verifyCurrentQwenRejectsHistoricalOutput({ capture: disabledQwenCapture, effort: 'none', expectedNativePrompt: recordedQwenUserPrompt + `\
<think>

</think>

` });
  }, 30_000);

  it('rejects historical high output at the repaired native input without a legacy adapter', async () => {
    await verifyCurrentQwenRejectsHistoricalOutput({ capture: enabledQwenCapture, effort: 'high', expectedNativePrompt: recordedQwenUserPrompt + '<think>\n' });
  }, 30_000);

  it('preserves the native default template and its independently recorded 17 tokens', async () => {
    const generate = vi.fn<ProductionReplayGenerate>(async () => {
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
    let actualInput: bigint[] | undefined;
    const stop = new Error('Qwen input captured; native inference intentionally not executed');
    const generate = vi.fn<ProductionReplayGenerate>(async ({ options, tokenizer, runtime }) => {
      const input = options.input_ids;
      const mask = options.attention_mask;
      if (!(input instanceof runtime.Tensor) || !(mask instanceof runtime.Tensor)) throw new Error('Expected actual processor tensors');
      actualInput = Array.from(input.data, BigInt);
      expect(Array.from(mask.data, BigInt)).toEqual(actualInput.map(() => 1n));
      expect(input.dims).toEqual([1, actualInput.length]);
      expect({ maxNewTokens: options.max_new_tokens, temperature: options.temperature, topP: options.top_p, doSample: options.do_sample }).toEqual(evidence.productionInput.effectiveGenerationConfig);
      expect(tokenizer.apply_chat_template(evidence.nativeTemplate.messages, { tokenize: true, add_generation_prompt: true, return_tensor: false, return_dict: false })).toEqual(evidence.nativeTemplate.inputIds);
      // No captured generation token IDs are present in this fixture. Never
      // call streamer.put/end or invent KV state for an unmatched input.
      throw stop;
    });
    const harness = await createQwenReplay({ generate });
    const chunks: string[] = [];
    try {
      await expect(harness.provider.chat({
        model: `hf.co/${evidence.identity.modelId}`, messages: evidence.productionInput.messages, tools: [],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => chunks.push(chunk),
      })).rejects.toThrow(stop.message);
      expect(generate).toHaveBeenCalledOnce();
      expect(harness.observations.processors).toHaveLength(1);
      expect(chunks).toEqual([]);
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
  }, 30_000);

  it.each(inputEvidence.cases)('$caseId retains the recorded native default input through public Provider', async scenario => {
    expect(inputEvidence.modelId).toBe(evidence.identity.modelId);
    expect(inputEvidence.revision).toBe(evidence.identity.resolvedRevision);
    let actualInput: bigint[] | undefined;
    const boundary = 'Qwen system/history input captured; native inference intentionally not executed';
    const generate = vi.fn<ProductionReplayGenerate>(async ({ options, runtime }) => {
      if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) {
        throw new Error('Expected actual Qwen processor tensors');
      }
      actualInput = Array.from(options.input_ids.data, BigInt);
      expect(options.input_ids.type).toBe('int64');
      expect(options.input_ids.location).toBe('cpu');
      expect(options.input_ids.dims).toEqual([1, actualInput.length]);
      expect(options.attention_mask.type).toBe('int64');
      expect(options.attention_mask.location).toBe('cpu');
      expect(options.attention_mask.dims).toEqual([1, actualInput.length]);
      expect(options.attention_mask.data).toEqual(new BigInt64Array(actualInput.length).fill(1n));
      expect(options.past_key_values).toBeNull();
      // Input-only capture. Never use the first-turn output to cross a mismatch.
      throw new Error(boundary);
    });
    const harness = await createQwenReplay({ generate });
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
      const chunks: string[] = [];
      await expect(harness.provider.chat({
        model: inputEvidence.modelId, messages: scenario.messages, tools: [],
        parameters: {
          temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined,
          frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined },
        },
        onChunk: ({ chunk }) => chunks.push(chunk),
      })).rejects.toThrow(boundary);
      expect(generate).toHaveBeenCalledOnce();
      expect(chunks).toEqual([]);
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
  }, 30_000);
});

describe('Qwen2 recorded Production text output with exact causal input; native parity remains separate', () => {
  it('delivers the historical 13-input prefix through the legacy serializer adapter before Provider settlement', async () => {
    expect(firstQwenCapture.replay.scenario.messages).toEqual(evidence.productionInput.messages);
    expect(firstQwenCapture.replay.modelReplay.sourceInputTokenIds).toEqual(evidence.productionInput.inputTokenIds);
    expect(firstQwenCapture.sourceFacts.cacheDecision.reason).toBe('qwen3_5-missing-conversation-state');
    await verifyRecordedQwenOutput({
      capture: firstQwenCapture, effort: undefined, expectedMode: 'default', expectedPrompt: recordedQwenUserPrompt,
      verifyBeforeRelease: ({ context }) => {
        if (!(context.options.input_ids instanceof context.runtime.Tensor)) throw new Error('Expected actual Qwen input Tensor');
        expect(context.options.input_ids.dims).toEqual([1, 13]);
        expect(firstQwenCapture.replay.modelReplay.generatedTokenIds).toHaveLength(16);
      },
    });
  }, 30_000);

  it('replays historical raw assistant-history through the legacy serializer adapter without inventing output KV', async () => {
    expect(continuitySelection.assistantMessage).toStrictEqual({ role: 'assistant', content: firstQwenCapture.replay.modelReplay.generatedText });
    expect(historyQwenCapture.replay.scenario.messages).toEqual([
      firstQwenCapture.replay.scenario.messages[0], continuitySelection.assistantMessage, continuitySelection.followUpMessage,
    ]);
    expect(historyQwenCapture.sourceFacts.cacheDecision.reason).toBe('qwen3_5-message-count-mismatch');
    // The investigation supplied raw decoded model text, not a completed
    // assistant reconstructed from a successful Provider callback sequence.
    await verifyRecordedQwenOutput({
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
  }, 30_000);

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
    const contexts: Parameters<ProductionReplayGenerate>[0][] = [];
    let firstReleased = 0;
    const invocations: ProductionReplayGenerate[] = [
      async context => {
        contexts.push(context);
        const { options, tokenizer, runtime } = context;
        expect(tokenizer.decode(source.modelReplay.generatedTokenIds, { skip_special_tokens: false })).toBe(source.modelReplay.generatedText);
        const replay = replayRecordedText({ evidence: source, options });
        firstReleased = replay.releasedTokenCount;
        return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
      },
      async context => {
        contexts.push(context);
        const { options, tokenizer, runtime } = context;
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
        if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) throw new Error('Expected actual next-input tensors');
        expect(options.input_ids.type).toBe('int64');
        expect(options.input_ids.location).toBe('cpu');
        expect(options.input_ids.dims).toEqual([1, ids.length]);
        expect(Array.from(options.input_ids.data, Number)).toEqual(ids);
        expect(options.attention_mask.type).toBe('int64');
        expect(options.attention_mask.location).toBe('cpu');
        expect(options.attention_mask.dims).toEqual([1, ids.length]);
        expect(Array.from(options.attention_mask.data, BigInt)).toEqual(ids.map(() => 1n));
        expect(Object.keys(options).sort()).toEqual([
          'attention_mask', 'do_sample', 'input_ids', 'max_new_tokens', 'past_key_values',
          'return_dict_in_generate', 'stopping_criteria', 'streamer', 'temperature', 'top_p',
        ].sort());
        expect({ maxNewTokens: options.max_new_tokens, temperature: options.temperature, topP: options.top_p, doSample: options.do_sample })
          .toEqual({ maxNewTokens: 1, temperature: 0, topP: 1, doSample: false });
        expect(options.return_dict_in_generate).toBe(true);
        expect(options.streamer).toBeInstanceOf(runtime.TextStreamer);
        expect(typeof options.stopping_criteria).toBe('function');
        expect(options.past_key_values).toBeNull();
        // No captured response exists for this changed input. This tests input
        // isolation with null KV, not native KV invalidation or generation.
        throw new Error(stop);
      },
    ];
    const harness = await createProductionReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, imagePlatform: undefined,
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
    try {
      const firstChunks: string[] = [];
      await harness.provider.chat({
        model: source.identity.modelId, messages: source.scenario.messages, tools: [],
        parameters: { ...source.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => firstChunks.push(chunk),
      });
      expect(historicalAdapter.builderSpy).toHaveBeenCalledOnce();
      historicalAdapter.restore();
      expect(firstChunks).toEqual(firstQwenCapture.streamChunks);
      const ortCountAfterFirst = harness.observations.ortCalls.length;
      expect(harness.observations.processors).toHaveLength(1);
      const processorAfterFirst = harness.observations.processors[0];
      const secondChunks: string[] = [];
      await expect(harness.provider.chat({
        model: source.identity.modelId, messages: nextMessages, tools: [],
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
  }, 30_000);

  it('rejects equal-length native 17 IDs without streaming and replays only the historical none input via its adapter', async () => {
    expect(disabledQwenCapture.replay.modelReplay.sourceInputTokenIds.slice(-4)).toEqual([248068, 271, 248069, 1358]);
    expect(disabledQwenCapture.replay.modelReplay.sourceInputTokenIds).not.toEqual(evidence.nativeTemplate.inputIds);
    await verifyRecordedQwenOutput({
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
  }, 30_000);

  it('replays the historical double-newline high input via its adapter before its one-token closing think output', async () => {
    expect(enabledQwenCapture.replay.modelReplay.sourceInputTokenIds.slice(-2)).toEqual([248068, 271]);
    await verifyRecordedQwenOutput({
      capture: enabledQwenCapture, effort: reasoningSelection.enabledEffort, expectedMode: 'enabled',
      expectedPrompt: recordedQwenUserPrompt + '<think>\n\n',
      verifyBeforeRelease: ({ context }) => {
        if (!(context.options.input_ids instanceof context.runtime.Tensor)) throw new Error('Expected actual Qwen input Tensor');
        expect(context.options.input_ids.dims).toEqual([1, 15]);
        expect(enabledQwenCapture.replay.modelReplay.generatedTokenIds).toEqual([248069]);
      },
    });
  }, 30_000);
});

describe('Qwen3.5 2B native tool input contract; natural tool generation is unobserved', () => {
  it('tools-generation preserves the complete public schema through the native XML template and actual processor', async () => {
    const scenario = toolInputEvidence.cases[0];
    const replay = await createQwenToolInputReplay();
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
      await captureQwenToolInput({
        replay, messages: scenario.messages, publicTool: replay.publicTool,
        expectedToolDefinition: strictQwenTools[0], expectedPrompt: strictNativePrompt,
      });

      // Exercise actual public sensitivity, not only a second native render:
      // preserve both changed description and user message in the complete prompt.
      const changedDescription = 'Changed synthetic tool description.';
      const changedContent = 'Use the weather tool for Osaka.';
      expect(expectedJsonPrompt.split(replay.publicTool.description)).toHaveLength(2);
      expect(expectedJsonPrompt.split(scenario.messages[0].content)).toHaveLength(2);
      await captureQwenToolInput({
        replay, messages: [{ role: 'user', content: changedContent }],
        publicTool: { ...replay.publicTool, description: changedDescription },
        expectedToolDefinition: { ...strictQwenTools[0], function: { ...strictQwenTools[0].function, description: changedDescription } },
        expectedPrompt: strictNativePrompt.replace(replay.publicTool.description, changedDescription).replace(scenario.messages[0].content, changedContent),
      });
      expect(replay.harness.observations.inferenceCalls).toHaveLength(2);
    } finally {
      await replay.close();
    }
  }, 30_000);

  it('tool-result-continuation preserves argument types and result body through native mapping while retaining the raw string-argument failure', async () => {
    const scenario = toolInputEvidence.cases[1];
    const replay = await createQwenToolInputReplay();
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
      await captureQwenToolInput({
        replay, messages, publicTool: replay.publicTool,
        expectedToolDefinition: strictQwenTools[0], expectedPrompt: strictNativeSystem + nativeSuffix,
      });

      // Another actual public invocation detects dropped arguments/results.
      // The city stays a string; no expected value is derived from actual output.
      const changedArguments = '{"city":"Osaka"}';
      const changedResult = '{"temperatureC":18,"condition":"rain"}';
      expect(expectedJsonPrompt.split('{"city":"Tokyo"}')).toHaveLength(2);
      expect(expectedJsonPrompt.split(scenario.messages[2].content)).toHaveLength(2);
      await captureQwenToolInput({
        replay,
        messages: [
          scenario.messages[0],
          { role: 'assistant', content: '', tool_calls: [{
            id: toToolCallId({ raw: 'call_template_probe_1' }), type: 'function',
            function: { name: 'lookup_weather', arguments: changedArguments },
          }] },
          { role: 'tool', tool_call_id: toToolCallId({ raw: 'call_template_probe_1' }), content: changedResult },
        ],
        publicTool: replay.publicTool, expectedToolDefinition: strictQwenTools[0],
        expectedPrompt: (strictNativeSystem + nativeSuffix).replace('\nTokyo\n', '\nOsaka\n').replace(scenario.messages[2].content, changedResult),
      });
      expect(replay.harness.observations.inferenceCalls).toHaveLength(2);
    } finally {
      await replay.close();
    }
  }, 30_000);
});

describe('Qwen3.5 2B independent native image controls; no captured vision output', () => {
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
    const platform = createProductionReplayTestImagePlatform();
    const generate = vi.fn<ProductionReplayGenerate>(async () => {
      throw new Error('Native image control must never generate');
    });
    const harness = await createProductionReplayTestRuntime({
      modelId, expectedRevision: revision, imagePlatform: { platform, allowedDataUrls: [imageUrl] },
      // This model's own inventory, with synthetic native-weight substitutes.
      // Loading the current text-only route is not proof of vision inference.
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
      expect(harness.observations.ortCalls).toHaveLength(2);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});

describe('Qwen3.5 2B public image preservation, separately from native reasoning parity', () => {
  it.each(qwen2ImageCases)('$name reaches generation as actual image tensors, not serialized URL text', async ({ imageUrl, rgba, rescaled }) => {
    const modelId = 'onnx-community/Qwen3.5-2B-ONNX';
    const revision = 'b1fc7ca3afafcb8e4b13d29715a6b9ea5af1d1cb';
    const messages: ChatMessage[] = [{ role: 'user', content: [
      { type: 'text', text: 'Describe this synthetic Qwen2 image.' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ] }];
    const boundary = 'Qwen2 public image input observed; no image generation tokens supplied';
    const platform = createProductionReplayTestImagePlatform();
    let actual: Parameters<ProductionReplayGenerate>[0] | undefined;
    const harness = await createProductionReplayTestRuntime({
      modelId, expectedRevision: revision, imagePlatform: { platform, allowedDataUrls: [imageUrl] },
      artifacts: [
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
      generate: async context => {
        actual = context;
        // Inspect only. No source image tensor/capture authorizes output here.
        throw new Error(boundary);
      },
    });
    try {
      const chunks: string[] = [];
      const onToolCall = vi.fn();
      const onToolEvent = vi.fn();
      const onToolResult = vi.fn();
      await expect(harness.provider.chat({
        model: modelId, messages, tools: [],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => chunks.push(chunk), onToolCall, onToolEvent, onToolResult,
      })).rejects.toThrow(boundary);
      if (!actual) throw new Error('Public Qwen2 image input did not reach generation');
      expect(harness.observations.processors).toHaveLength(1);
      const processor = harness.observations.processors[0];
      if (!processor?.tokenizer) throw new Error('Expected actual Qwen2 processor/tokenizer');
      expect(actual.tokenizer).toBe(processor.tokenizer);
      expect(processor.constructor.name).toBe('Qwen3VLProcessor');
      expect(createHash('sha256').update(actual.tokenizer.get_chat_template()).digest('hex'))
        .toBe('273d8e0e683b885071fb17e08d71e5f2a5ddfb5309756181681de4f5a1822d80');
      expect(actual.options.input_ids).toBeInstanceOf(harness.runtime.Tensor);
      expect(actual.options.attention_mask).toBeInstanceOf(harness.runtime.Tensor);
      expect(actual.options.past_key_values).toBeNull();
      expect({
        maxNewTokens: actual.options.max_new_tokens, temperature: actual.options.temperature,
        topP: actual.options.top_p, doSample: actual.options.do_sample,
      }).toEqual({ maxNewTokens: 1, temperature: 0, topP: 1, doSample: false });
      expect(actual.options.return_dict_in_generate).toBe(true);
      expect(actual.options.streamer).toBeInstanceOf(harness.runtime.TextStreamer);
      expect(typeof actual.options.stopping_criteria).toBe('function');
      expect(chunks).toEqual([]);
      expect(onToolCall).not.toHaveBeenCalled();
      expect(onToolEvent).not.toHaveBeenCalled();
      expect(onToolResult).not.toHaveBeenCalled();
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.ortCalls).toHaveLength(2);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // This test never invokes a separate RawImage/processor control. Every
      // image fetch/decode here must come from the actual public request.
      // The known missing-image RED is independent of the native-default
      // thinking suffix discrepancy protected in the earlier text scenarios.
      const imageInput = {
        imageFetches: harness.observations.localImageFetchCalls,
        hasPixels: actual.options.pixel_values instanceof harness.runtime.Tensor,
        hasGrid: actual.options.image_grid_thw instanceof harness.runtime.Tensor,
      };
      expect(imageInput, JSON.stringify(imageInput)).toEqual({ imageFetches: [imageUrl], hasPixels: true, hasGrid: true });
      const tensors = z.object({
        input_ids: z.instanceof(harness.runtime.Tensor), attention_mask: z.instanceof(harness.runtime.Tensor),
        pixel_values: z.instanceof(harness.runtime.Tensor), image_grid_thw: z.instanceof(harness.runtime.Tensor),
      }).parse(actual.options);
      expect(Object.keys(actual.options).sort()).toEqual([
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
  }, 30_000);
});
