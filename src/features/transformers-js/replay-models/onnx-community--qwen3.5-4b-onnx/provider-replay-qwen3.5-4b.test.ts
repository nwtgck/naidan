// @vitest-environment node
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import { createProviderReplayTestImagePlatform } from '@/features/transformers-js/replay-models/support/provider-replay-test-image-platform';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { captureProviderChat, type ProviderChatCapture } from '@/features/transformers-js/replay-models/support/capture-provider-chat';
import { readModelFixture } from '@/features/transformers-js/replay-models/support/model-runtime-fixture';
import { providerReplayCatalog } from './provider-evidence-catalog';
import { assembleProviderSequenceEvidence, readProviderRequestEvidence, type ProviderReplayCatalog } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';
import { createProviderRequestReplay } from '@/features/transformers-js/replay-models/support/provider-replay-request';
import { replayCapturedFullInvocation, verifyCapturedFullReplay } from '@/features/transformers-js/replay-models/support/provider-replay-test-captured-full';
import correctedFirst from './provider-first-turn-corrected.evidence.json';
import correctedContinuity from './provider-continuity-corrected.evidence.json';
import correctedProvenance from './provider-corrected-continuity-provenance.evidence.json';
import correctedSequence from './provider-corrected-continuity-sequence.evidence.json';

const modelId = 'onnx-community/Qwen3.5-4B-ONNX';
const revision = '74d8caba2117fd5f41d655e9cc27eda1338662b3';

// Synthetic input, not a captured native generation invocation. The original
// investigation had no accepted cached Qwen4 model and no generation evidence.
const messages = [{ role: 'user' as const, content: 'Template probe user message.' }];
// Independent Qwen4 contract derived from its own original template. Its
// default opens a thinking block; disabling thinking closes an empty block.
const defaultText = `\
<|im_start|>user
Template probe user message.<|im_end|>
<|im_start|>assistant
<think>
`;
const disabledThinkingText = `\
<|im_start|>user
Template probe user message.<|im_end|>
<|im_start|>assistant
<think>

</think>

`;
const defaultIds = [248045, 846, 198, 7048, 21059, 1156, 1876, 13, 248046, 198, 248045, 74455, 198, 248068, 198];
const disabledThinkingIds = [248045, 846, 198, 7048, 21059, 1156, 1876, 13, 248046, 198, 248045, 74455, 198, 248068, 271, 248069, 271];

// These inputs and expected texts are independently specified from this exact
// model's checked-in template, not a browser matrix or another model's capture.
const historyCases: Array<{ name: string, messages: ChatMessage[], expectedText: string }> = [
  {
    name: 'system and user',
    messages: [
      { role: 'system', content: 'Template probe system instruction.' },
      { role: 'user', content: 'Template probe user message.' },
    ],
    expectedText: `\
<|im_start|>system
Template probe system instruction.<|im_end|>
<|im_start|>user
Template probe user message.<|im_end|>
<|im_start|>assistant
<think>
`,
  },
  {
    name: 'supplied assistant history',
    messages: [
      { role: 'user', content: 'Template probe first user message.' },
      { role: 'assistant', content: 'Template probe assistant response.' },
      { role: 'user', content: 'Template probe second user message.' },
    ],
    expectedText: `\
<|im_start|>user
Template probe first user message.<|im_end|>
<|im_start|>assistant
Template probe assistant response.<|im_end|>
<|im_start|>user
Template probe second user message.<|im_end|>
<|im_start|>assistant
<think>
`,
  },
];

function createQwen4Replay({ generate }: { generate: ProviderReplayGenerate }) {
  const metadata = readModelFixture({ modelId });
  expect(metadata.summary.revision).toBe(revision);
  expect(createHash('sha256').update(metadata.files.get('tokenizer_config.json')!).digest('hex')).toBe('2de621ec071dd61438efdd6d0183bd3d612e98d05ac10d19ed75f1fef9299bc9');
  expect(createHash('sha256').update(metadata.files.get('tokenizer.json')!).digest('hex')).toBe('89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b');
  return createProviderReplayTestRuntime({
    imagePlatform: undefined,
    modelId, expectedRevision: revision, cacheRevision: revision, metadataCache: "all-fixture",
    // Synthetic native-session boundary only; these bytes do not prove that
    // original multi-GB weights execute successfully or are locally present.
    artifacts: [
      'onnx/decoder_model_merged_q4f16.onnx',
      'onnx/decoder_model_merged_q4f16.onnx_data',
      'onnx/decoder_model_merged_q4f16.onnx_data_1',
      'onnx/embed_tokens_q4f16.onnx',
      'onnx/embed_tokens_q4f16.onnx_data',
    ].map(path => ({ path, bytes: new TextEncoder().encode(`synthetic Qwen4 model artifact: ${path}`) })),
    generate,
  });
}

// Input-only observations detach tensor storage before rejection or disposal.
// Identity checks retain references; no inference output is supplied here.
function captureQwen4NativeInput({ options, tokenizer, runtime }: Parameters<ProviderReplayGenerate>[0]) {
  const tensor = ({ value }: { value: unknown }) => value instanceof runtime.Tensor
    ? { isTensor: true as const, type: value.type, location: value.location, dims: [...value.dims], data: value.data.slice() }
    : { isTensor: false as const };
  return {
    tokenizer,
    input: tensor({ value: options.input_ids }),
    mask: tensor({ value: options.attention_mask }),
    pixels: tensor({ value: options.pixel_values }),
    grid: tensor({ value: options.image_grid_thw }),
    pastIsNull: options.past_key_values === null,
    settings: { maxNewTokens: options.max_new_tokens, temperature: options.temperature, topP: options.top_p, doSample: options.do_sample },
    returnDict: options.return_dict_in_generate,
    isTextStreamer: options.streamer instanceof runtime.TextStreamer,
    stoppingCriteriaType: typeof options.stopping_criteria,
  };
}

// Model-specific input-boundary mechanics only. Callers own the native options,
// public reasoning request and independently expected text. No generation result
// exists for these scenarios, and no prior answer or KV state is invented.
async function createQwen4PublicInputControl({ inputMessages, expectedText, nativeRenderOptions, effort: _effort }: {
  inputMessages: ChatMessage[], expectedText: string,
  nativeRenderOptions: {
    tokenize: false, add_generation_prompt: true,
  } | {
    tokenize: false, add_generation_prompt: true, enable_thinking: boolean,
  },
  effort: 'none' | 'low' | 'medium' | 'high' | undefined,
}) {
  const stop = 'Qwen4 input-only comparison; no output tokens supplied';
  const nativeInputs: ReturnType<typeof captureQwen4NativeInput>[] = [];
  const generate = vi.fn<ProviderReplayGenerate>(async context => {
    nativeInputs.push(captureQwen4NativeInput(context));
    throw new Error(stop);
  });
  const harness = await createQwen4Replay({ generate });
  try {
    await harness.service.loadDownloadedModel({ modelId });
    expect(harness.observations.processors).toHaveLength(1);
    const processor = harness.observations.processors[0];
    if (!processor?.tokenizer) throw new Error('Actual Qwen4 processor/tokenizer unavailable');
    expect(processor.constructor.name).toBe('Qwen3VLProcessor');
    const tokenizer = processor.tokenizer;
    expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'))
      .toBe('a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715');
    expect(tokenizer.apply_chat_template(inputMessages, nativeRenderOptions)).toBe(expectedText);
    const expectedIds = tokenizer.encode(expectedText, { add_special_tokens: false });
    expect(tokenizer.apply_chat_template(inputMessages, {
      ...nativeRenderOptions, tokenize: true, return_dict: false, return_tensor: false,
    })).toEqual(expectedIds);
    return { harness, stop, verifyNativeInput() {
      expect(generate).toHaveBeenCalledOnce();
      expect(nativeInputs).toHaveLength(1);
      const actual = nativeInputs[0];
      expect(actual?.tokenizer).toBe(harness.observations.processors[0]?.tokenizer);
      expect(actual?.input.isTensor).toBe(true);
      expect(actual?.mask.isTensor).toBe(true);
      if (!actual?.input.isTensor || !actual.mask.isTensor) throw new Error('Expected actual Qwen4 processor input/mask');
      const actualInput = Array.from(actual.input.data, Number);
      expect(actual.input.type).toBe('int64');
      expect(actual.input.location).toBe('cpu');
      expect(actual.input.dims).toEqual([1, actualInput.length]);
      expect(actual.mask.type).toBe('int64');
      expect(actual.mask.location).toBe('cpu');
      expect(actual.mask.dims).toEqual([1, actualInput.length]);
      expect(Array.from(actual.mask.data, BigInt)).toEqual(actualInput.map(() => 1n));
      expect(actual.pastIsNull).toBe(true);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Only compare after native control and offline/sentinel checks. Default
      // parity does not by itself define the application's reasoning policy.
      expect(actualInput).toEqual(expectedIds);
    } };
  } catch (error) {
    await harness.close();
    throw error;
  }
}

// Entirely synthetic Qwen4 inputs. There was no accepted source generation
// capture for this model; no prompts/IDs below are labelled recorded evidence.
const qwen4ToolDefinitionSchema = z.object({
  type: z.literal('function'), function: z.object({
    name: z.literal('lookup_temperature'), description: z.string(),
    parameters: z.object({
      type: z.literal('object'), properties: z.object({ place: z.object({ type: z.literal('string') }).strict() }).strict(),
      required: z.tuple([z.literal('place')]), additionalProperties: z.literal(false),
    }).strict(),
  }).strict(),
}).strict();
const qwen4StrictTools: [z.infer<typeof qwen4ToolDefinitionSchema>] = [{ type: 'function', function: {
  name: 'lookup_temperature', description: 'Return synthetic fixture temperature.',
  parameters: { type: 'object', properties: { place: { type: 'string' } }, required: ['place'], additionalProperties: false },
} }];
const qwen4BuilderInputSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'tool']), content: z.string(), tool_call_id: z.string().optional(),
    tool_calls: z.tuple([z.object({
      id: z.string(), type: z.literal('function'),
      function: z.object({ name: z.literal('lookup_temperature'), arguments: z.string() }).strict(),
    }).strict()]).optional(),
  }).strict()),
  tools: z.tuple([qwen4ToolDefinitionSchema]), reasoningMode: z.literal('default'),
}).strict();
const QWEN4_TOOL_BOUNDARY = 'Synthetic Qwen4 tool input only; no output or KV supplied';
const qwen4ToolUser = { role: 'user' as const, content: 'Read the fixture temperature for Oslo.' };
const qwen4SuppliedCall = {
  role: 'assistant' as const, content: 'Checking the supplied place.', tool_calls: [{
    id: toToolCallId({ raw: 'qwen4_synthetic_call_1' }), type: 'function' as const,
    function: { name: 'lookup_temperature', arguments: '{"place":"Oslo"}' },
  }],
};
const qwen4MappedCall = {
  role: 'assistant', content: 'Checking the supplied place.', tool_calls: [{
    id: 'qwen4_synthetic_call_1', type: 'function',
    function: { name: 'lookup_temperature', arguments: { place: 'Oslo' } },
  }],
};
const qwen4SuppliedResult = {
  role: 'tool' as const, content: '{"celsius":7,"source":"synthetic"}',
  tool_call_id: toToolCallId({ raw: 'qwen4_synthetic_call_1' }),
};

// Independently transcribed from Qwen4's own exact original template, including
// XML instructions and its distinct default thinking suffix. Not Qwen2 IDs.
const qwen4NativeToolSystem = `\
<|im_start|>system
# Tools

You have access to the following functions:

<tools>
{"type": "function", "function": {"name": "lookup_temperature", "description": "Return synthetic fixture temperature.", "parameters": {"type": "object", "properties": {"place": {"type": "string"}}, "required": ["place"], "additionalProperties": false}}}
</tools>

If you choose to call a function ONLY reply in the following format with NO suffix:

<tool_call>
<function=example_function_name>
<parameter=example_parameter_1>
value_1
</parameter>
<parameter=example_parameter_2>
This is the value for the second parameter
that can span
multiple lines
</parameter>
</function>
</tool_call>

<IMPORTANT>
Reminder:
- Function calls MUST follow the specified format: an inner <function=...></function> block must be nested within <tool_call></tool_call> XML tags
- Required parameters MUST be specified
- You may provide optional reasoning for your function call in natural language BEFORE the function call, but NOT after
- If there is no function call available, answer the question like normal with your current knowledge and do not tell the user about function calls
</IMPORTANT><|im_end|>
`;
// Historical Naidan JSON protocol is retained as a contrast, not an assertion
// of equivalent model behavior or a replacement for existing native-parity RED.
const qwen4JsonToolSystem = `\
<|im_start|>system
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{"type":"function","function":{"name":"lookup_temperature","description":"Return synthetic fixture temperature.","parameters":{"type":"object","properties":{"place":{"type":"string"}},"required":["place"],"additionalProperties":false}}}
</tools>

For each function call, return a json object with function name and arguments within <tool_call></tool_call> XML tags:
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call><|im_end|>
`;
const qwen4ToolUserText = `\
<|im_start|>user
Read the fixture temperature for Oslo.<|im_end|>
`;
const qwen4NativeCallText = `\
<|im_start|>assistant
<think>

</think>

Checking the supplied place.

<tool_call>
<function=lookup_temperature>
<parameter=place>
Oslo
</parameter>
</function>
</tool_call><|im_end|>
`;
const qwen4JsonCallText = `\
<|im_start|>assistant
Checking the supplied place.
<tool_call>
{"name":"lookup_temperature","arguments":{"place":"Oslo"}}
</tool_call>
<|im_end|>
`;
const qwen4NativeGenerationPrefix = `<|im_start|>assistant\n<think>\n`;
const qwen4JsonGenerationPrefix = `<|im_start|>assistant\n`;

async function createQwen4ToolReplay() {
  const metadata = readModelFixture({ modelId });
  expect(metadata.summary.revision).toBe(revision);
  const config = metadata.files.get('tokenizer_config.json');
  const template = metadata.files.get('chat_template.jinja');
  if (!config || !template) throw new Error('Qwen4 exact metadata missing');
  expect(createHash('sha256').update(config).digest('hex')).toBe('2de621ec071dd61438efdd6d0183bd3d612e98d05ac10d19ed75f1fef9299bc9');
  expect(createHash('sha256').update(template).digest('hex')).toBe('a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715');
  const nativeInputs: Array<ReturnType<typeof captureQwen4NativeInput> & { runtime: Parameters<ProviderReplayGenerate>[0]['runtime'] }> = [];
  const generate = vi.fn<ProviderReplayGenerate>(async context => {
    nativeInputs.push({ ...captureQwen4NativeInput(context), runtime: context.runtime });
    throw new Error(QWEN4_TOOL_BOUNDARY);
  });
  const execute = vi.fn<Tool['execute']>(async () => {
    throw new Error('No natural tool invocation in this fixture');
  });
  const publicTool: Tool = {
    name: 'lookup_temperature', description: 'Return synthetic fixture temperature.', parametersSchema: z.object({ place: z.string() }), execute,
  };
  const harness = await createProviderReplayTestRuntime({
    modelId, expectedRevision: revision, cacheRevision: revision, metadataCache: "all-fixture", imagePlatform: undefined,
    artifacts: [
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data', 'onnx/decoder_model_merged_q4f16.onnx_data_1',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
    ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
    generate,
  });
  try {
    await harness.service.loadDownloadedModel({ modelId });
    expect(harness.observations.processors).toHaveLength(1);
    const processor = harness.observations.processors[0];
    if (!processor?.tokenizer) throw new Error('Actual Qwen4 processor/tokenizer missing');
    expect(processor.constructor.name).toBe('Qwen3VLProcessor');
    expect(processor.tokenizer).toBeInstanceOf(harness.runtime.PreTrainedTokenizer);
    expect(createHash('sha256').update(processor.tokenizer.get_chat_template()).digest('hex')).toBe('a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715');
    const serializer = await import('@/features/transformers-js/models/qwen3_5');
    const builderSpy = vi.spyOn(serializer, 'buildQwen3_5Prompt');
    const processorSpy = vi.spyOn(processor, '_call');
    return { harness, generate, nativeInputs, execute, publicTool, tokenizer: processor.tokenizer, builderSpy, processorSpy, async close() {
      processorSpy.mockRestore();
      builderSpy.mockRestore();
      await harness.close();
    } };
  } catch (error) {
    try {
      await harness.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Qwen4 tool setup and cleanup failed', { cause: error });
    }
    throw error;
  }
}

function verifyQwen4ToolInput({ replay, inputMessages, publicTool: _publicTool, expectedDefinition, expectedPrompt, before }: {
  replay: Awaited<ReturnType<typeof createQwen4ToolReplay>>, inputMessages: ChatMessage[], publicTool: Tool,
  expectedDefinition: z.infer<typeof qwen4ToolDefinitionSchema>, expectedPrompt: string, before: number,
}) {
  expect(replay.generate).toHaveBeenCalledTimes(before + 1);
  expect(replay.builderSpy).toHaveBeenCalledTimes(before + 1);
  expect(replay.processorSpy).toHaveBeenCalledTimes(before + 1);
  const builderCall = replay.builderSpy.mock.calls[before];
  if (!builderCall) throw new Error('Expected actual Qwen4 serializer invocation');
  const { tokenizer: actualTokenizer, ...builderInput } = builderCall[0];
  expect(actualTokenizer).toBe(replay.tokenizer);
  const observed = qwen4BuilderInputSchema.parse(builderInput);
  const { messages: observedMessages, tools, reasoningMode, ...unhandled } = observed;
  unhandled satisfies Record<PropertyKey, never>;
  expect(observedMessages.map(message => {
    const { role, content, tool_calls, tool_call_id, ...rest } = message;
    rest satisfies Record<PropertyKey, never>;
    return { role, content, tool_calls, tool_call_id };
  })).toStrictEqual(inputMessages.map(message => ({
    role: message.role, content: message.content, tool_calls: message.tool_calls, tool_call_id: message.tool_call_id,
  })));
  expect(tools).toStrictEqual([expectedDefinition]);
  expect(reasoningMode).toBe('default');
  // Call-through spies preserve both receiver and results. Native controls use
  // tokenizer directly; this is the real processor called by the Worker strategy.
  expect(replay.processorSpy.mock.calls[before]).toStrictEqual([expectedPrompt]);
  expect(replay.nativeInputs).toHaveLength(before + 1);
  const inference = replay.nativeInputs[before];
  if (!inference) throw new Error('Expected actual Qwen4 inference boundary');
  expect(inference.tokenizer).toBe(replay.tokenizer);
  const { input, mask, runtime } = inference;
  expect(input.isTensor).toBe(true);
  expect(mask.isTensor).toBe(true);
  if (!input.isTensor || !mask.isTensor) throw new Error('Expected actual Qwen4 tensors');
  const currentNative = replay.tokenizer(expectedPrompt);
  expect(currentNative.input_ids).toBeInstanceOf(runtime.Tensor);
  const ids = Array.from(currentNative.input_ids.data, Number);
  expect(input.type).toBe('int64');
  expect(input.location).toBe('cpu');
  expect(input.dims).toEqual([1, ids.length]);
  expect(Array.from(input.data, Number)).toEqual(ids);
  expect(mask.type).toBe('int64');
  expect(mask.location).toBe('cpu');
  expect(mask.dims).toEqual([1, ids.length]);
  expect(Array.from(mask.data, BigInt)).toEqual(ids.map(() => 1n));
  expect(inference.pastIsNull).toBe(true);
  expect(replay.harness.observations.runtimeAssetFetchCalls).toEqual([replay.harness.observations.expectedRuntimeAssetUrl]);
  expect(replay.harness.observations.localImageFetchCalls).toEqual([]);
  expect(replay.harness.observations.forbiddenTransport).toEqual([]);
  expect(replay.harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  expect(replay.harness.observations.ortCalls.map(([core, options]) => inspectSyntheticOrtSession({
    modelId, revision, repositoryPaths: new Set([
      'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data', 'onnx/decoder_model_merged_q4f16.onnx_data_1',
      'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
    ]), core, options,
  })).toSorted((a, b) => a.corePath.localeCompare(b.corePath))).toEqual([
    { modelId, revision, corePath: 'onnx/decoder_model_merged_q4f16.onnx', externalData: [
      { path: 'decoder_model_merged_q4f16.onnx_data', artifactPath: 'onnx/decoder_model_merged_q4f16.onnx_data' },
      { path: 'decoder_model_merged_q4f16.onnx_data_1', artifactPath: 'onnx/decoder_model_merged_q4f16.onnx_data_1' },
    ], executionProviders: ['webgpu'] },
    { modelId, revision, corePath: 'onnx/embed_tokens_q4f16.onnx', externalData: [
      { path: 'embed_tokens_q4f16.onnx_data', artifactPath: 'onnx/embed_tokens_q4f16.onnx_data' },
    ], executionProviders: ['webgpu'] },
  ]);
}

const boundary = 'Qwen4 image input observed; no native generation evidence';
// Independent synthetic inputs using the exact model's original processor and
// template. No browser image capture or successful vision inference is claimed.
const nativePrompt = `\
<|im_start|>user
Describe this synthetic image.<|vision_start|><|image_pad|><|vision_end|><|im_end|>
<|im_start|>assistant
<think>
`;

describe('Qwen3.5 4B Provider / basic', () => {
  it('matches native-default input through public Provider before releasing any tokens', async () => {
    const nativeInputs: ReturnType<typeof captureQwen4NativeInput>[] = [];
    const nativeTemplateIds: unknown[] = [];
    const stop = new Error('Qwen4 inference intentionally stopped at input boundary');
    const generate = vi.fn<ProviderReplayGenerate>(async context => {
      nativeInputs.push(captureQwen4NativeInput(context));
      nativeTemplateIds.push(structuredClone(context.tokenizer.apply_chat_template(messages, { tokenize: true, add_generation_prompt: true, return_tensor: false, return_dict: false })));
      // Neither captured nor invented generation tokens are released. Native
      // default parity alone does not establish a correct user reasoning policy.
      throw stop;
    });
    const harness = await createQwen4Replay({ generate });
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: `hf.co/${modelId}`,
          messages,
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
      expect(nativeInputs).toHaveLength(1);
      const actual = nativeInputs[0];
      expect(actual?.tokenizer).toBe(harness.observations.processors[0]?.tokenizer);
      expect(actual?.input.isTensor).toBe(true);
      expect(actual?.mask.isTensor).toBe(true);
      if (!actual?.input.isTensor || !actual.mask.isTensor) throw new Error('Expected actual Qwen4 processor tensors');
      const actualInput = Array.from(actual.input.data, BigInt);
      expect(actual.input.type).toBe('int64');
      expect(actual.mask.type).toBe('int64');
      expect(actual.input.dims).toEqual([1, actualInput.length]);
      expect(actual.mask.dims).toEqual(actual.input.dims);
      expect(Array.from(actual.mask.data, BigInt)).toEqual(actualInput.map(() => 1n));
      expect(nativeTemplateIds).toEqual([defaultIds]);
      expect(harness.observations.processors).toHaveLength(1);
      expect(observed.chunks).toEqual([]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      expect(actualInput).toEqual(defaultIds.map(BigInt));
    } finally {
      await harness.close();
    }
    expect(capture?.snapshot().lateEvents).toEqual([]);
  }, 30_000);
});

describe('Qwen3.5 4B Provider / history', () => {
  it.each(historyCases)('$name retains the independently specified native input through Provider', async scenario => {
    {
      const control = await createQwen4PublicInputControl({
        inputMessages: scenario.messages, expectedText: scenario.expectedText,
        nativeRenderOptions: { tokenize: false, add_generation_prompt: true }, effort: undefined,
      });
      let capture: ProviderChatCapture | undefined;
      try {
        capture = captureProviderChat({
          provider: control.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-4B-ONNX",
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
        await expect(capture.completion).rejects.toThrow(control.stop);
        const observed = capture.snapshot();
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
});

describe('Qwen3.5-4B source-derived history/cache control, not recorded KV', () => {
  it('discards owned state when the original template removes prior thinking and supplies the exact fresh next input', async () => {
    const inputs: ReturnType<typeof captureQwen4NativeInput>[] = [];
    const captures: ProviderChatCapture[] = [];
    let ownedSequence: bigint[] = [];
    let consumedTokenCount = 0;
    let cacheLengthReads = 0;
    const harness = await createQwen4Replay({ generate: async context => {
      const { options, tokenizer, runtime } = context;
      inputs.push(captureQwen4NativeInput(context));
      if (inputs.length !== 1) throw new Error('Fresh Qwen history input observed; no continuation output supplied');
      if (!(options.input_ids instanceof runtime.Tensor) || !(options.streamer instanceof runtime.TextStreamer)) throw new Error('Expected actual Qwen tensors and TextStreamer');
      const generated = tokenizer.encode(`\
Reason</think>

Answer<|im_end|>`, { add_special_tokens: false });
      const prompt = Array.from(options.input_ids.data, BigInt);
      options.streamer.put([prompt]);
      for (const token of generated) options.streamer.put([[BigInt(token)]]);
      options.streamer.end();
      ownedSequence = [...prompt, ...generated.map(BigInt)];
      // Explicit synthetic cache metadata: the last sampled token is not yet
      // consumed. This exercises ownership/prefix logic, not GPU KV contents.
      consumedTokenCount = ownedSequence.length - 1;
      const cache = new runtime.DynamicCache();
      vi.spyOn(cache, 'get_seq_length').mockImplementation(() => {
        cacheLengthReads++;
        return consumedTokenCount;
      });
      return { sequences: new runtime.Tensor('int64', BigInt64Array.from(ownedSequence), [1, ownedSequence.length]), past_key_values: cache };
    } });
    try {
      const parameters = { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined,
        frequencyPenalty: undefined, stop: undefined, reasoning: { effort: 'high' as const } };
      const first = captureProviderChat({ provider: harness.provider, request: {
        model: 'onnx-community/Qwen3.5-4B-ONNX',
        messages: [{ role: 'system', content: 'Keep the system instruction.' }, { role: 'user', content: 'First synthetic request.' }],
        parameters, tools: [], signal: new AbortController().signal,
      } });
      captures.push(first);
      await first.completion;
      const observed = first.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual([`\
<think>Reason</think>

Answer`]);
      expect(cacheLengthReads, 'the first generation must actually retain the supplied owned cache').toBe(1);
      const history: ChatMessage[] = [
        { role: 'system', content: 'Keep the system instruction.' },
        { role: 'user', content: 'First synthetic request.' },
        { role: 'assistant', content: observed.responses[0]!.join('') },
        { role: 'user', content: 'Continue.' },
      ];
      const next = captureProviderChat({ provider: harness.provider, request: {
        model: 'onnx-community/Qwen3.5-4B-ONNX', messages: history,
        parameters, tools: [], signal: new AbortController().signal,
      } });
      captures.push(next);
      await expect(next.completion).rejects.toThrow('Fresh Qwen history input observed; no continuation output supplied');
      expect(inputs).toHaveLength(2);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(cacheLengthReads, 'the next eligible conversation must inspect the retained state before rejecting its prefix').toBe(2);
      expect(inputs.map(input => input.pastIsNull)).toEqual([true, true]);
      const actual = inputs[1]!;
      if (!actual.input.isTensor) throw new Error('Expected the detached actual next-input tensor');
      const freshIds = actual.tokenizer.encode(`\
<|im_start|>system
Keep the system instruction.<|im_end|>
<|im_start|>user
First synthetic request.<|im_end|>
<|im_start|>assistant
Answer<|im_end|>
<|im_start|>user
Continue.<|im_end|>
<|im_start|>assistant
<think>
`, { add_special_tokens: false });
      expect(Array.from(actual.input.data, Number)).toEqual(freshIds);
      expect(consumedTokenCount).toBe(ownedSequence.length - 1);
      expect(consumedTokenCount).toBeLessThan(freshIds.length);
      expect(ownedSequence.slice(0, consumedTokenCount)).not.toEqual(freshIds.slice(0, consumedTokenCount).map(BigInt));
      expect(history[2]!.content, 'Naidan must not rewrite the delivered thinking to manufacture cache compatibility').toBe(observed.responses[0]!.join(''));
      expect(next.snapshot().responses).toEqual([[]]);
      expect(captures.flatMap(capture => capture.snapshot().toolCalls)).toEqual([]);
      expect(captures.flatMap(capture => capture.snapshot().preStartChunks)).toEqual([]);
    } finally {
      await harness.close();
      expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
    }
  }, 30_000);
});

describe('Qwen3.5 4B Provider / reasoning', () => {
  it('independently preserves native default thinking and explicit disabled-thinking input', async () => {
    const generate = vi.fn<ProviderReplayGenerate>(async () => {
      throw new Error('Native input oracle must not generate');
    });
    const harness = await createQwen4Replay({ generate });
    try {
      await harness.service.loadDownloadedModel({ modelId });
      expect(harness.observations.processors).toHaveLength(1);
      const processor = harness.observations.processors[0]!;
      expect(processor.constructor.name).toBe('Qwen3VLProcessor');
      const tokenizer = processor.tokenizer;
      if (!tokenizer) throw new Error('Actual Qwen4 processor has no tokenizer');
      expect(tokenizer).toBeInstanceOf(harness.runtime.PreTrainedTokenizer);
      expect(tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true })).toBe(defaultText);
      expect(tokenizer.apply_chat_template(messages, { tokenize: true, add_generation_prompt: true, return_tensor: false, return_dict: false })).toEqual(defaultIds);
      // The upstream options declaration omits template-specific kwargs, but
      // apply_chat_template forwards its remaining kwargs to compiledTemplate.render.
      const disabledRenderOptions = { tokenize: false, add_generation_prompt: true, enable_thinking: false } as const;
      const disabledTokenOptions = { tokenize: true, add_generation_prompt: true, enable_thinking: false, return_tensor: false, return_dict: false } as const;
      expect(tokenizer.apply_chat_template(messages, disabledRenderOptions)).toBe(disabledThinkingText);
      expect(tokenizer.apply_chat_template(messages, disabledTokenOptions)).toEqual(disabledThinkingIds);
      expect(generate).not.toHaveBeenCalled();
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
  it.each([
    { effort: 'none', enableThinking: false, expectedText: disabledThinkingText },
    { effort: 'low', enableThinking: true, expectedText: defaultText },
    { effort: 'medium', enableThinking: true, expectedText: defaultText },
    { effort: 'high', enableThinking: true, expectedText: defaultText },
  ] as const)('explicit $effort reasoning preserves the corresponding native thinking prefix', async scenario => {
    // Qwen's native switch is boolean; this does not claim that low/medium/high
    // produce different reasoning quality or that reasoning reaches completion.
    {
      const control = await createQwen4PublicInputControl({
        inputMessages: messages, expectedText: scenario.expectedText,
        nativeRenderOptions: { tokenize: false, add_generation_prompt: true, enable_thinking: scenario.enableThinking },
        effort: scenario.effort,
      });
      let capture: ProviderChatCapture | undefined;
      try {
        capture = captureProviderChat({
          provider: control.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-4B-ONNX",
            messages,
            tools: [],
            parameters: {
              temperature: 0,
              topP: 1,
              maxCompletionTokens: 1,
              presencePenalty: undefined,
              frequencyPenalty: undefined,
              stop: undefined,
              reasoning: { effort: scenario.effort },
            },
          },
        });
        await expect(capture.completion).rejects.toThrow(control.stop);
        const observed = capture.snapshot();
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
});

describe('Qwen3.5 4B Provider / tools', () => {
  it('preserves the complete strict public tool schema independently of Qwen4 native XML and default thinking', async () => {
    const replay = await createQwen4ToolReplay();
    const captures: ProviderChatCapture[] = [];
    try {
      const inputMessages = [qwen4ToolUser];
      const nativePrompt = qwen4NativeToolSystem + qwen4ToolUserText + qwen4NativeGenerationPrefix;
      expect(replay.tokenizer.apply_chat_template(inputMessages, {
        tokenize: false, add_generation_prompt: true, tools: qwen4StrictTools,
      })).toBe(nativePrompt);
      const nativeIds = replay.tokenizer.encode(nativePrompt, { add_special_tokens: false });
      expect(replay.tokenizer.apply_chat_template(inputMessages, {
        tokenize: true, return_dict: false, return_tensor: false, add_generation_prompt: true, tools: qwen4StrictTools,
      })).toEqual(nativeIds);
      const disabledOptions = { tokenize: false, add_generation_prompt: true, tools: qwen4StrictTools, enable_thinking: false } as const;
      expect(replay.tokenizer.apply_chat_template(inputMessages, disabledOptions))
        .toBe(nativePrompt + '\n</think>\n\n');
      // This explicit open-schema control is synthetic, not a claimed capture.
      const openTools = [{ type: 'function', function: {
        name: 'lookup_temperature', description: 'Return synthetic fixture temperature.',
        parameters: { type: 'object', properties: { place: { type: 'string' } }, required: ['place'] },
      } }];
      const openPrompt = nativePrompt.replace(', "additionalProperties": false', '');
      expect(replay.tokenizer.apply_chat_template(inputMessages, {
        tokenize: false, add_generation_prompt: true, tools: openTools,
      })).toBe(openPrompt);
      expect(replay.tokenizer.encode(openPrompt, { add_special_tokens: false })).not.toEqual(nativeIds);
      const jsonPrompt = qwen4JsonToolSystem + qwen4ToolUserText + qwen4JsonGenerationPrefix;
      expect(jsonPrompt).not.toBe(nativePrompt);
      {
        const before = replay.generate.mock.calls.length;
        const capture = captureProviderChat({
          provider: replay.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-4B-ONNX",
            messages: inputMessages,
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
        await expect(capture.completion).rejects.toThrow(QWEN4_TOOL_BOUNDARY);
        const observed = capture.snapshot();
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        expect(replay.execute).not.toHaveBeenCalled();
        verifyQwen4ToolInput({ ...{
          replay, inputMessages, publicTool: replay.publicTool, expectedDefinition: qwen4StrictTools[0], expectedPrompt: nativePrompt,
        }, before });
      }
      // Observe an actual second public request with both changes, not only a
      // native render after a serializer that might have dropped the definition.
      const changedDescription = 'Read a different synthetic temperature source.';
      const changedContent = 'Read the fixture temperature for Bergen.';
      expect(jsonPrompt.split(replay.publicTool.description)).toHaveLength(2);
      expect(jsonPrompt.split(qwen4ToolUser.content)).toHaveLength(2);
      const changedDefinition = {
        ...qwen4StrictTools[0], function: { ...qwen4StrictTools[0].function, description: changedDescription },
      };
      {
        const before = replay.generate.mock.calls.length;
        const capture = captureProviderChat({
          provider: replay.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-4B-ONNX",
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
        await expect(capture.completion).rejects.toThrow(QWEN4_TOOL_BOUNDARY);
        const observed = capture.snapshot();
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        expect(replay.execute).not.toHaveBeenCalled();
        verifyQwen4ToolInput({ ...{
          replay, inputMessages: [{ role: 'user', content: changedContent }],
          publicTool: { ...replay.publicTool, description: changedDescription }, expectedDefinition: changedDefinition,
          expectedPrompt: nativePrompt.replace(replay.publicTool.description, changedDescription).replace(qwen4ToolUser.content, changedContent),
        }, before });
      }
      expect(replay.tokenizer.apply_chat_template([{ role: 'user', content: changedContent }], {
        tokenize: false, add_generation_prompt: true, tools: [changedDefinition],
      })).toBe(nativePrompt.replace(replay.publicTool.description, changedDescription).replace(qwen4ToolUser.content, changedContent));
      expect(replay.harness.observations.inferenceCalls).toHaveLength(2);
    } finally {
      await replay.close();
    }
    for (const capture of captures) expect(capture.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('retains supplied call content and string-valued arguments through the public native mapping', async () => {
    const replay = await createQwen4ToolReplay();
    const captures: ProviderChatCapture[] = [];
    try {
      const inputMessages = [qwen4ToolUser, qwen4SuppliedCall];
      // Neither this failure nor its mapped success is taken from a captured
      // invocation; both are current controls against Qwen4's original template.
      expect(() => replay.tokenizer.apply_chat_template(inputMessages, {
        tokenize: false, add_generation_prompt: true, tools: qwen4StrictTools,
      })).toThrow('Unknown StringValue filter: items');
      const mappedMessages = [qwen4ToolUser, qwen4MappedCall];
      const nativePrompt = qwen4NativeToolSystem + qwen4ToolUserText + qwen4NativeCallText + qwen4NativeGenerationPrefix;
      expect(replay.tokenizer.apply_chat_template(mappedMessages, {
        tokenize: false, add_generation_prompt: true, tools: qwen4StrictTools,
      })).toBe(nativePrompt);
      expect(replay.tokenizer.apply_chat_template(mappedMessages, {
        tokenize: true, return_dict: false, return_tensor: false, add_generation_prompt: true, tools: qwen4StrictTools,
      })).toEqual(replay.tokenizer.encode(nativePrompt, { add_special_tokens: false }));
      // false omits only the final generation prefix. This is not the public
      // chat setting, and it does not remove the supplied assistant's thinking.
      expect(replay.tokenizer.apply_chat_template(mappedMessages, {
        tokenize: false, add_generation_prompt: false, tools: qwen4StrictTools,
      })).toBe(qwen4NativeToolSystem + qwen4ToolUserText + qwen4NativeCallText);
      const jsonPrompt = qwen4JsonToolSystem + qwen4ToolUserText + qwen4JsonCallText + qwen4JsonGenerationPrefix;
      expect(jsonPrompt).not.toBe(nativePrompt);
      {
        const before = replay.generate.mock.calls.length;
        const capture = captureProviderChat({
          provider: replay.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-4B-ONNX",
            messages: inputMessages,
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
        await expect(capture.completion).rejects.toThrow(QWEN4_TOOL_BOUNDARY);
        const observed = capture.snapshot();
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        expect(replay.execute).not.toHaveBeenCalled();
        verifyQwen4ToolInput({ ...{
          replay, inputMessages, publicTool: replay.publicTool, expectedDefinition: qwen4StrictTools[0], expectedPrompt: nativePrompt,
        }, before });
      }
      const changedContent = 'Checking a second supplied place.';
      const changedCall = {
        role: 'assistant' as const, content: changedContent, tool_calls: [{
          id: toToolCallId({ raw: 'qwen4_synthetic_call_2' }), type: 'function' as const,
          function: { name: 'lookup_temperature', arguments: '{"place":"Bergen"}' },
        }],
      };
      expect(jsonPrompt.split(qwen4SuppliedCall.content)).toHaveLength(2);
      expect(jsonPrompt.split('{"place":"Oslo"}')).toHaveLength(2);
      {
        const before = replay.generate.mock.calls.length;
        const capture = captureProviderChat({
          provider: replay.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-4B-ONNX",
            messages: [qwen4ToolUser, changedCall],
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
        await expect(capture.completion).rejects.toThrow(QWEN4_TOOL_BOUNDARY);
        const observed = capture.snapshot();
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        expect(replay.execute).not.toHaveBeenCalled();
        verifyQwen4ToolInput({ ...{
          replay, inputMessages: [qwen4ToolUser, changedCall], publicTool: replay.publicTool, expectedDefinition: qwen4StrictTools[0],
          expectedPrompt: nativePrompt.replace(qwen4SuppliedCall.content, changedContent).replace('\nOslo\n', '\nBergen\n'),
        }, before });
      }
      const changedMapped = [qwen4ToolUser, { role: 'assistant', content: changedContent, tool_calls: [{
        id: 'qwen4_synthetic_call_2', type: 'function', function: { name: 'lookup_temperature', arguments: { place: 'Bergen' } },
      }] }];
      expect(replay.tokenizer.apply_chat_template(changedMapped, {
        tokenize: false, add_generation_prompt: true, tools: qwen4StrictTools,
      })).toBe(nativePrompt.replace(qwen4SuppliedCall.content, changedContent).replace('\nOslo\n', '\nBergen\n'));
      expect(replay.harness.observations.inferenceCalls).toHaveLength(2);
    } finally {
      await replay.close();
    }
    for (const capture of captures) expect(capture.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
  it('retains supplied association IDs at builder entry and serializes result content without natural generation output', async () => {
    const replay = await createQwen4ToolReplay();
    const captures: ProviderChatCapture[] = [];
    try {
      const inputMessages = [qwen4ToolUser, qwen4SuppliedCall, qwen4SuppliedResult];
      expect(() => replay.tokenizer.apply_chat_template(inputMessages, {
        tokenize: false, add_generation_prompt: true, tools: qwen4StrictTools,
      })).toThrow('Unknown StringValue filter: items');
      const nativePrompt = qwen4NativeToolSystem + qwen4ToolUserText + qwen4NativeCallText + `\
<|im_start|>user
<tool_response>
{"celsius":7,"source":"synthetic"}
</tool_response><|im_end|>
` + qwen4NativeGenerationPrefix;
      const mappedMessages = [qwen4ToolUser, qwen4MappedCall, qwen4SuppliedResult];
      expect(replay.tokenizer.apply_chat_template(mappedMessages, {
        tokenize: false, add_generation_prompt: true, tools: qwen4StrictTools,
      })).toBe(nativePrompt);
      expect(replay.tokenizer.apply_chat_template(mappedMessages, {
        tokenize: true, return_dict: false, return_tensor: false, add_generation_prompt: true, tools: qwen4StrictTools,
      })).toEqual(replay.tokenizer.encode(nativePrompt, { add_special_tokens: false }));
      const jsonPrompt = qwen4JsonToolSystem + qwen4ToolUserText + qwen4JsonCallText + `\
<|im_start|>user
<tool_response>
{"celsius":7,"source":"synthetic"}
</tool_response>
<|im_end|>
` + qwen4JsonGenerationPrefix;
      expect(jsonPrompt).not.toBe(nativePrompt);
      {
        const before = replay.generate.mock.calls.length;
        const capture = captureProviderChat({
          provider: replay.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-4B-ONNX",
            messages: inputMessages,
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
        await expect(capture.completion).rejects.toThrow(QWEN4_TOOL_BOUNDARY);
        const observed = capture.snapshot();
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        expect(replay.execute).not.toHaveBeenCalled();
        verifyQwen4ToolInput({ ...{
          replay, inputMessages, publicTool: replay.publicTool, expectedDefinition: qwen4StrictTools[0], expectedPrompt: nativePrompt,
        }, before });
      }
      const changedResult = { ...qwen4SuppliedResult, content: '{"celsius":11,"source":"synthetic-second"}' };
      expect(jsonPrompt.split(qwen4SuppliedResult.content)).toHaveLength(2);
      {
        const before = replay.generate.mock.calls.length;
        const capture = captureProviderChat({
          provider: replay.harness.provider,
          request: {
            model: "onnx-community/Qwen3.5-4B-ONNX",
            messages: [qwen4ToolUser, qwen4SuppliedCall, changedResult],
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
        await expect(capture.completion).rejects.toThrow(QWEN4_TOOL_BOUNDARY);
        const observed = capture.snapshot();
        expect(observed.chunks.join('')).toBe('');
        expect(observed.chunks).toEqual([]);
        expect(observed.preStartChunks).toEqual([]);
        expect(observed.lateEvents).toEqual([]);
        expect(observed.toolCalls).toEqual([]);
        expect(observed.toolResults).toEqual([]);
        expect(observed.toolEvents).toEqual([]);
        expect(replay.execute).not.toHaveBeenCalled();
        verifyQwen4ToolInput({ ...{
          replay, inputMessages: [qwen4ToolUser, qwen4SuppliedCall, changedResult], publicTool: replay.publicTool,
          expectedDefinition: qwen4StrictTools[0], expectedPrompt: nativePrompt.replace(qwen4SuppliedResult.content, changedResult.content),
        }, before });
      }
      expect(replay.tokenizer.apply_chat_template([qwen4ToolUser, qwen4MappedCall, changedResult], {
        tokenize: false, add_generation_prompt: true, tools: qwen4StrictTools,
      })).toBe(nativePrompt.replace(qwen4SuppliedResult.content, changedResult.content));
      // The native template serializes result content, not the association ID.
      // Actual builder argument validation above checks the ID independently;
      // rendered-token equality alone must not masquerade as tool resolution.
      expect(replay.tokenizer.apply_chat_template([qwen4ToolUser, qwen4MappedCall, { role: 'tool', content: qwen4SuppliedResult.content }], {
        tokenize: false, add_generation_prompt: true, tools: qwen4StrictTools,
      })).toBe(nativePrompt);
      expect(replay.harness.observations.inferenceCalls).toHaveLength(2);
    } finally {
      await replay.close();
    }
    for (const capture of captures) expect(capture.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);
});

describe('Qwen3.5-4B source-derived XML type controls, not recorded inference', () => {
  it.each([
    { name: 'scalar overflow', schema: z.number().nullable(), raw: '1e999' },
    { name: 'nested overflow', schema: z.object({ value: z.number().nullable() }), raw: '{"value":1e999}' },
  ])('rejects $name through authoritative Provider validation without executing a null substitute', async ({ schema, raw }) => {
    const executions: unknown[] = [];
    let nativeCalls = 0;
    const harness = await createQwen4Replay({ generate: async ({ options, tokenizer, runtime }) => {
      nativeCalls++;
      if (!(options.input_ids instanceof runtime.Tensor) || !(options.streamer instanceof runtime.TextStreamer)) throw new Error('Expected actual Qwen tensors and TextStreamer');
      if (nativeCalls > 2) throw new Error('Unexpected synthetic generation');
      const text = nativeCalls === 1
        ? `<tool_call><function=probe><parameter=value>${raw}</parameter></function></tool_call>`
        : 'Synthetic completion after rejected arguments.';
      const ids = tokenizer.encode(text, { add_special_tokens: false });
      const input = Array.from(options.input_ids.data, BigInt);
      options.streamer.put([input]);
      for (const id of ids) options.streamer.put([[BigInt(id)]]);
      options.streamer.end();
      return { sequences: new runtime.Tensor('int64', BigInt64Array.from([...input, ...ids.map(BigInt)]), [1, input.length + ids.length]), past_key_values: null };
    } });
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({ provider: harness.provider, request: {
        model: 'onnx-community/Qwen3.5-4B-ONNX', messages: [{ role: 'user', content: 'Synthetic overflow control.' }],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined,
          frequencyPenalty: undefined, stop: undefined, reasoning: { effort: 'none' } },
        tools: [{ name: 'probe', description: 'Must reject invalid numeric arguments.', parametersSchema: z.object({ value: schema }),
          execute: async ({ args }) => {
            executions.push(structuredClone(args)); return { status: 'success', content: 'Must not execute.' };
          } }],
      } });
      await capture.completion;
      const observed = capture.snapshot();
      expect(observed.toolCalls).toHaveLength(1);
      expect(observed.toolResults).toHaveLength(1);
      expect(observed.toolResults[0]?.result).toMatchObject({ status: 'error', code: 'invalid_arguments' });
      expect(executions).toEqual([]);
      expect(nativeCalls).toBe(2);
      expect(observed.responses.map(response => response.join(''))).toEqual(['', 'Synthetic completion after rejected arguments.']);
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
    } finally {
      await harness.close();
      expect(capture?.snapshot().lateEvents).toEqual([]);
      expect(executions).toEqual([]);
    }
  }, 30_000);

  it.each([
    { name: 'JSON-looking string', schema: z.string(), expected: '{"city":"Tokyo"}' },
    { name: 'object', schema: z.object({ city: z.string() }), expected: { city: 'Tokyo' } },
  ])('passes the $name through Provider schema serialization and actual tool execution', async ({ schema, expected }) => {
    const executions: unknown[] = [];
    let nativeCalls = 0;
    const harness = await createQwen4Replay({ generate: async ({ options, tokenizer, runtime }) => {
      nativeCalls++;
      if (!(options.input_ids instanceof runtime.Tensor) || !(options.streamer instanceof runtime.TextStreamer)) throw new Error('Expected actual Qwen tensors and TextStreamer');
      if (nativeCalls > 2) throw new Error('Unexpected synthetic generation');
      const text = nativeCalls === 1
        ? '<tool_call><function=write_file><parameter=content>{"city":"Tokyo"}</parameter></function></tool_call>'
        : 'Synthetic completion.';
      const ids = tokenizer.encode(text, { add_special_tokens: false });
      const input = Array.from(options.input_ids.data, BigInt);
      options.streamer.put([input]);
      for (const id of ids) options.streamer.put([[BigInt(id)]]);
      options.streamer.end();
      return { sequences: new runtime.Tensor('int64', BigInt64Array.from([...input, ...ids.map(BigInt)]), [1, input.length + ids.length]), past_key_values: null };
    } });
    let capture: ProviderChatCapture | undefined;
    try {
      capture = captureProviderChat({ provider: harness.provider, request: {
        model: 'onnx-community/Qwen3.5-4B-ONNX',
        messages: [{ role: 'user', content: 'Use the synthetic write_file tool.' }],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined,
          frequencyPenalty: undefined, stop: undefined, reasoning: { effort: 'none' } },
        tools: [{ name: 'write_file', description: 'Synthetic XML schema control.', parametersSchema: z.object({ content: schema }),
          execute: async ({ args }) => {
            executions.push(structuredClone(args));
            return { status: 'success', content: 'Synthetic tool result.' };
          } }],
      } });
      await capture.completion;
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(executions).toEqual([{ content: expected }]);
      expect(observed.toolCalls).toHaveLength(1);
      expect(observed.toolResults).toHaveLength(1);
      expect(observed.responses.map(response => response.join(''))).toEqual(['', 'Synthetic completion.']);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(nativeCalls).toBe(2);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
    } finally {
      await harness.close();
      expect(capture?.snapshot().lateEvents).toEqual([]);
    }
  }, 30_000);
});

describe('Qwen3.5 4B Provider / images', () => {
  it.each([
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
  ])('$name retains image content through actual processor input', async ({ imageUrl, rgba, rescaled }) => {
    const metadata = readModelFixture({ modelId });
    expect(metadata.summary.revision).toBe(revision);
    expect(createHash('sha256').update(metadata.files.get('processor_config.json')!).digest('hex'))
      .toBe('14932921ca485d458a04dafd8069fbb0a4505622a48208d19ed247115801385b');
    expect(createHash('sha256').update(metadata.files.get('preprocessor_config.json')!).digest('hex'))
      .toBe('6a970fd06f30e6943b3e2c14d5d3b42d49b06cf99b99103d56689bef462d90f8');
    const messages: ChatMessage[] = [{ role: 'user', content: [
      { type: 'text', text: 'Describe this synthetic image.' },
      { type: 'image_url', image_url: { url: imageUrl } },
    ] }];
    const platform = createProviderReplayTestImagePlatform();
    const nativeInputs: ReturnType<typeof captureQwen4NativeInput>[] = [];
    const harness = await createProviderReplayTestRuntime({
      modelId, expectedRevision: revision, cacheRevision: revision, metadataCache: "all-fixture", imagePlatform: { platform, allowedDataUrls: [imageUrl] },
      artifacts: [
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/decoder_model_merged_q4f16.onnx_data_1', 'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
      generate: async context => {
        nativeInputs.push(captureQwen4NativeInput(context));
        throw new Error(boundary);
      },
    });
    let capture: ProviderChatCapture | undefined;
    try {
      await harness.service.loadDownloadedModel({ modelId });
      expect(harness.observations.processors).toHaveLength(1);
      const processor = harness.observations.processors[0];
      if (!processor?.tokenizer) throw new Error('Expected actual Qwen4 processor/tokenizer');
      expect(processor.constructor.name).toBe('Qwen3VLProcessor');
      expect(createHash('sha256').update(processor.tokenizer.get_chat_template()).digest('hex'))
        .toBe('a4aee8afcf2e0711942cf848899be66016f8d14a889ff9ede07bca099c28f715');
      expect(processor.tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true })).toBe(nativePrompt);

      // Current TJS 4.2.0 selects preprocessor_config.json for this class.
      // Processor.uses_processor_config is false, and ImageProcessor enables
      // normalization only when do_normalize is set. The separate nested config
      // declares true, but is not consumed by this route. Preserve that mismatch
      // explicitly: 0/1 below is current native behavior, not certification that
      // omitting normalization is correct for this model's vision weights.
      const nestedConfig = z.object({ image_processor: z.object({ do_normalize: z.literal(true) }) })
        .parse(JSON.parse(new TextDecoder().decode(metadata.files.get('processor_config.json')!)));
      expect(nestedConfig.image_processor.do_normalize).toBe(true);
      const selectedConfig = z.object({ do_normalize: z.undefined().optional() })
        .parse(JSON.parse(new TextDecoder().decode(metadata.files.get('preprocessor_config.json')!)));
      expect(selectedConfig.do_normalize).toBeUndefined();
      const actualImageProcessor = processor.image_processor;
      if (typeof actualImageProcessor !== 'function') throw new Error('Expected actual callable image processor');
      // Read fields without replacing the callable instance with a parsed object.
      const imageProcessor = z.object({ do_rescale: z.literal(true), do_normalize: z.undefined(), rescale_factor: z.number() }).parse({
        do_rescale: Reflect.get(actualImageProcessor, 'do_rescale'),
        do_normalize: Reflect.get(actualImageProcessor, 'do_normalize'),
        rescale_factor: Reflect.get(actualImageProcessor, 'rescale_factor'),
      });
      expect(imageProcessor.rescale_factor).toBe(1 / 255);

      // Native control uses actual offline RawImage and actual callable
      // processor, not a stand-in that fabricates pixels or output tensors.
      const rawImage = await harness.runtime.RawImage.read(imageUrl);
      const tensorSchema = z.object({
        input_ids: z.instanceof(harness.runtime.Tensor), attention_mask: z.instanceof(harness.runtime.Tensor),
        pixel_values: z.instanceof(harness.runtime.Tensor), image_grid_thw: z.instanceof(harness.runtime.Tensor),
      });
      const native = tensorSchema.parse(await processor(nativePrompt, rawImage));
      // From this model's config: min area 65536 -> 256x256, patch 16,
      // temporal patch 2, merge 2. This is independently derived geometry,
      // not a browser observation or a reuse of another model's dimensions.
      const expectedPixels = new Float32Array(256 * 1536).fill(rescaled);
      const expectedGrid = BigInt64Array.of(1n, 16n, 16n);
      const expandedText = nativePrompt.replace('<|image_pad|>', '<|image_pad|>'.repeat(64));
      const expectedIds = processor.tokenizer.encode(expandedText, { add_special_tokens: false });
      expect({ type: native.pixel_values.type, location: native.pixel_values.location, dims: native.pixel_values.dims })
        .toEqual({ type: 'float32', location: 'cpu', dims: [256, 1536] });
      // Compare every typed value, without constructing a 393216-value failure
      // diff that can dominate the test runtime when the contract differs.
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
      const nativeFetchCount = harness.observations.localImageFetchCalls.length;
      expect(nativeFetchCount).toBe(1);

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
      expect(nativeInputs).toHaveLength(1);
      const actual = nativeInputs[0];
      if (!actual) throw new Error('Actual public image request never reached inference');
      expect(actual.tokenizer).toBe(processor.tokenizer);
      expect(actual.pastIsNull).toBe(true);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(observed.chunks).toEqual([]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      expect(observed.toolCalls).toEqual([]);
      expect(observed.toolResults).toEqual([]);
      expect(observed.toolEvents).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Keep the native control's fetch separate from Production. Passing the
      // control must not conceal that Production discarded the image content.
      expect({
        productionImageFetches: harness.observations.localImageFetchCalls.slice(nativeFetchCount),
        hasPixels: actual.pixels.isTensor,
        hasGrid: actual.grid.isTensor,
      }).toEqual({ productionImageFetches: [imageUrl], hasPixels: true, hasGrid: true });
      expect(actual.input.isTensor).toBe(true);
      expect(actual.mask.isTensor).toBe(true);
      if (!actual.input.isTensor || !actual.mask.isTensor || !actual.pixels.isTensor || !actual.grid.isTensor) throw new Error('Expected actual Qwen4 image tensors');
      const actualTensors = { input_ids: actual.input, attention_mask: actual.mask, pixel_values: actual.pixels, image_grid_thw: actual.grid };
      for (const { tensor, type } of [
        { tensor: actualTensors.input_ids, type: 'int64' },
        { tensor: actualTensors.attention_mask, type: 'int64' },
        { tensor: actualTensors.pixel_values, type: 'float32' },
        { tensor: actualTensors.image_grid_thw, type: 'int64' },
      ]) {
        expect({ type: tensor.type, location: tensor.location }).toEqual({ type, location: 'cpu' });
      }
      expect(isDeepStrictEqual(actualTensors.pixel_values.data, expectedPixels)).toBe(true);
      expect(actualTensors.pixel_values.dims).toEqual([256, 1536]);
      expect(actualTensors.image_grid_thw.data).toEqual(expectedGrid);
      expect(actualTensors.image_grid_thw.dims).toEqual([1, 3]);
      expect(Array.from(actualTensors.input_ids.data, Number)).toEqual(expectedIds);
      expect(actualTensors.input_ids.dims).toEqual([1, expectedIds.length]);
      expect(actualTensors.attention_mask.data).toEqual(new BigInt64Array(expectedIds.length).fill(1n));
      expect(actualTensors.attention_mask.dims).toEqual([1, expectedIds.length]);
    } finally {
      await harness.close();
    }
    expect(capture?.snapshot().lateEvents).toEqual([]);
  }, 30_000);
});

// This later capture has an accepted immutable offline ImageTextToText Load.
// Original input-only controls above retain their independent expectations.
// These recorded executions are complete at their explicit token budgets;
// short text and the one-token image result do not certify answer quality.
const recordedArtifacts = [
  'onnx/decoder_model_merged_q4f16.onnx',
  'onnx/decoder_model_merged_q4f16.onnx_data',
  'onnx/decoder_model_merged_q4f16.onnx_data_1',
  'onnx/embed_tokens_q4f16.onnx',
  'onnx/embed_tokens_q4f16.onnx_data',
  'onnx/vision_encoder_q4f16.onnx',
  'onnx/vision_encoder_q4f16.onnx_data',
];
const recordedImageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

describe('Qwen3.5 4B Provider / recorded request contracts', () => {
  it('delivers the recorded first-turn callbacks before settlement', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['first-turn'], artifactPaths: recordedArtifacts, imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "first-turn", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses).toHaveLength(1);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(observed.chunks.join('')).toBe("<think>Okay, the user just said \"Template probe user message.\" Hmm, that's");
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
      replay.assertComplete({ requests: 1, nativeCalls: 1 });
    } finally {
      await replay.close();
    }
    expect(capture?.snapshot().lateEvents).toEqual([]);
    expect(capture?.snapshot().toolCalls).toEqual([]);
    expect(capture?.snapshot().toolResults).toEqual([]);
    expect(capture?.snapshot().toolEvents).toEqual([]);
  }, 30_000);

  it('preserves system instructions and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['system-user'], artifactPaths: recordedArtifacts, imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "system-user", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
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
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses).toHaveLength(1);
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["<think>Thinking"]);
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

  it('preserves supplied assistant history and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['supplied-history'], artifactPaths: recordedArtifacts, imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "supplied-history", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
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
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses).toHaveLength(1);
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["<think>Thinking"]);
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

  it('preserves corrected settled history at the native input boundary without borrowing output from the historical source', async () => {
    const { context, evidence } = readProviderRequestEvidence({ catalog: providerReplayCatalog, caseId: 'first-turn' });
    const firstInvocation = evidence.invocations[0];
    if (firstInvocation === undefined) throw new Error('Missing first-request native evidence');
    const parameters = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
    const stop = new Error('This historical Qwen4 source has no output for corrected history');
    let nativeCalls = 0;
    let releasedRecordedInvocations = 0;
    const observedNativeIds: number[][] = [];
    const stoppedNativeInputs: ReturnType<typeof captureQwen4NativeInput>[] = [];
    const expectedNextIds = [248045, 846, 198, 7048, 21059, 1156, 1876, 13, 248046, 198, 248045, 74455, 198,
      248068, 31248, 11, 279, 1156, 1066, 1018, 328, 7048, 21059, 1156, 1876, 1149, 85152, 11, 421, 579,
      248046, 198, 248045, 846, 198, 22791, 279, 26388, 10125, 440, 264, 2716, 1965, 13, 248046, 198,
      248045, 74455, 198, 248068, 198];
    // This source-derived input adds the delivered prompt-owned opening token.
    // The historical 50-token invocation remains unchanged in its own replay.
    const replay = await createProviderReplayTestRuntime({ modelId, expectedRevision: revision, cacheRevision: revision,
      metadataCache: context.localMetadataPaths, imagePlatform: undefined,
      artifacts: recordedArtifacts.map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
      generate: async context => {
        const { options, runtime, model } = context;
        ++nativeCalls;
        if (nativeCalls === 1) {
          if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) throw new Error('Expected native Qwen4 text tensors');
          observedNativeIds.push(Array.from(options.input_ids.data, Number));
          const { localOrdinal, ...facts } = firstInvocation;
          const result = replayCapturedFullInvocation({ invocation: { ...facts, callOrdinal: localOrdinal, scenario: 'first-turn' }, options, runtime, modelConfig: model.config, parameters });
          ++releasedRecordedInvocations;
          return result;
        }
        const input = captureQwen4NativeInput(context);
        stoppedNativeInputs.push(input);
        if (input.input.isTensor) observedNativeIds.push(Array.from(input.input.data, Number));
        throw stop;
      },
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const firstCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: modelId,
          messages: [
            {
              role: 'user',
              content: 'Template probe user message.',
            },
          ],
          tools: [],
          parameters,
          signal: new AbortController().signal,
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;
      const firstObserved = firstCapture.snapshot();
      expect(firstObserved.settlement).toEqual({ status: 'fulfilled' });
      expect(firstObserved.responses.map(chunks => chunks.join(''))).toEqual(['<think>Okay, the user just said "Template probe user message." Hmm, that\'s']);
      const nextCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: modelId,
          messages: [
            {
              role: 'user',
              content: 'Template probe user message.',
            },
            {
              role: 'assistant',
              content: firstObserved.responses[0]!.join(''),
            },
            {
              role: 'user',
              content: 'Continue the synthetic conversation with a short response.',
            },
          ],
          tools: [],
          parameters,
          signal: new AbortController().signal,
        },
      });
      captures.push(nextCapture);
      await expect(nextCapture.completion).rejects.toThrow(stop.message);
      const nextObserved = nextCapture.snapshot();
      expect(stoppedNativeInputs).toHaveLength(1);
      const stoppedInput = stoppedNativeInputs[0];
      expect(stoppedInput?.input.isTensor).toBe(true);
      expect(stoppedInput?.mask.isTensor).toBe(true);
      if (!stoppedInput?.input.isTensor || !stoppedInput.mask.isTensor) throw new Error('Expected native Qwen4 text tensors');
      expect(Array.from(stoppedInput.input.data, Number)).toEqual(expectedNextIds);
      expect(stoppedInput.input.dims).toEqual([1, 51]);
      expect(stoppedInput.mask.dims).toEqual([1, 51]);
      expect(stoppedInput.mask.data).toEqual(new BigInt64Array(51).fill(1n));
      expect(stoppedInput.pastIsNull).toBe(true);
      expect(stoppedInput.settings).toEqual({ maxNewTokens: 16, temperature: 0, topP: 1, doSample: false });
      expect(nextObserved.settlement).toMatchObject({ status: 'rejected' });
      expect(firstObserved.responses).toHaveLength(1);
      expect(firstObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(['assistant-start', 'settled']);
      expect(nextObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(['assistant-start', 'settled']);
      expect(nextObserved.chunks).toEqual([]);
      expect(firstObserved.preStartChunks).toEqual([]);
      expect(nextObserved.preStartChunks).toEqual([]);
      expect(firstObserved.lateEvents).toEqual([]);
      expect(nextObserved.lateEvents).toEqual([]);
      expect(firstObserved.toolCalls).toEqual([]);
      expect(firstObserved.toolResults).toEqual([]);
      expect(firstObserved.toolEvents).toEqual([]);
      expect(nextObserved.toolCalls).toEqual([]);
      expect(nextObserved.toolResults).toEqual([]);
      expect(nextObserved.toolEvents).toEqual([]);
      expect(nativeCalls).toBe(2);
      expect(releasedRecordedInvocations).toBe(1);
      expect(observedNativeIds).toEqual([defaultIds, expectedNextIds]);
      expect(replay.observations.inferenceCalls).toHaveLength(2);
      expect(replay.observations.workers).toHaveLength(1);
      expect(replay.observations.modelLoadCalls).toEqual(['AutoModelForImageTextToText']);
      expect(replay.observations.forbiddenTransport).toEqual([]);
      expect(replay.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await replay.close();
      expect(replay.observations.workers.every(worker => worker.terminated)).toBe(true);
    }
    for (const capture of captures) expect(capture.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);

  it('delivers the newly recorded continuity from the actually settled corrected first response in one loaded runtime', async () => {
    // This two-request capture has its own source pins. The older Full capture
    // and its mismatched-continuation rejection remain separate contracts.
    const catalog = {
      context: providerReplayCatalog.context,
      provenance: correctedProvenance,
      sequence: correctedSequence,
      cases: { 'first-turn': correctedFirst, continuity: correctedContinuity },
    } satisfies ProviderReplayCatalog;
    const replay = await createProviderRequestReplay({
      catalog,
      caseIds: ['first-turn', 'continuity'],
      artifactPaths: recordedArtifacts,
      imagePlatform: undefined,
    });
    const captures: ProviderChatCapture[] = [];
    try {
      const parameters = {
        temperature: 0,
        topP: 1,
        maxCompletionTokens: 16,
        presencePenalty: undefined,
        frequencyPenalty: undefined,
        stop: undefined,
        reasoning: { effort: undefined },
      };
      replay.beginNativeRequest({ caseId: 'first-turn', parameters });
      const firstCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: 'onnx-community/Qwen3.5-4B-ONNX',
          messages: [{ role: 'user', content: 'Template probe user message.' }],
          tools: [],
          parameters,
          signal: new AbortController().signal,
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;
      replay.endNativeRequest();
      const firstObserved = firstCapture.snapshot();
      const firstChunks = [
        '<think>', 'Okay, ', 'the ', 'user ', 'just ', 'said ', '"Template ',
        'probe ', 'user ', 'message." ', 'Hmm, ', "that's",
      ];
      expect(firstObserved.settlement).toEqual({ status: 'fulfilled' });
      expect(firstObserved.responses.map(chunks => chunks.join(''))).toEqual([
        '<think>Okay, the user just said "Template probe user message." Hmm, that\'s',
      ]);
      expect(firstObserved.responses).toEqual([firstChunks]);
      expect(firstObserved.chunks).toEqual(firstChunks);
      expect(firstObserved.events).toEqual([
        { kind: 'assistant-start', assistantIndex: 0 },
        ...firstChunks.map(chunk => ({ kind: 'chunk', assistantIndex: 0, chunk })),
        { kind: 'settled', outcome: 'fulfilled' },
      ]);
      expect(firstObserved.preStartChunks).toEqual([]);
      expect(firstObserved.lateEvents).toEqual([]);
      expect(firstObserved.toolCalls).toEqual([]);
      expect(firstObserved.toolResults).toEqual([]);
      expect(firstObserved.toolEvents).toEqual([]);
      replay.beginNativeRequest({ caseId: 'continuity', parameters });
      const nextCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: 'onnx-community/Qwen3.5-4B-ONNX',
          messages: [
            { role: 'user', content: 'Template probe user message.' },
            { role: 'assistant', content: firstObserved.responses[0]!.join('') },
            { role: 'user', content: 'Continue the synthetic conversation with a short response.' },
          ],
          tools: [],
          parameters,
          signal: new AbortController().signal,
        },
      });
      captures.push(nextCapture);
      await nextCapture.completion;
      replay.endNativeRequest();
      const nextObserved = nextCapture.snapshot();
      const nextChunks = [
        '<think>', 'Thinking ', 'Process:\n\n', '1. ', ' ', '**Analyze ',
        'the ', 'Request:**\n', '   ', ' ', '*',
      ];
      expect(nextObserved.settlement).toEqual({ status: 'fulfilled' });
      expect(nextObserved.responses.map(chunks => chunks.join(''))).toEqual([
        `\
<think>Thinking Process:

1.  **Analyze the Request:**
    *`,
      ]);
      expect(nextObserved.responses).toEqual([nextChunks]);
      expect(nextObserved.chunks).toEqual(nextChunks);
      expect(nextObserved.events).toEqual([
        { kind: 'assistant-start', assistantIndex: 0 },
        ...nextChunks.map(chunk => ({ kind: 'chunk', assistantIndex: 0, chunk })),
        { kind: 'settled', outcome: 'fulfilled' },
      ]);
      expect(nextObserved.preStartChunks).toEqual([]);
      expect(nextObserved.lateEvents).toEqual([]);
      expect(nextObserved.toolCalls).toEqual([]);
      expect(nextObserved.toolResults).toEqual([]);
      expect(nextObserved.toolEvents).toEqual([]);
      expect(firstCapture.snapshot()).toEqual(firstObserved);
      // Both requests are complete bounded 16-token executions. Their open
      // thinking prefixes do not assert completion of a natural-language answer.
      replay.assertComplete({ requests: 2, nativeCalls: 2 });
      expect(replay.observations.modelLoadCalls).toEqual(['AutoModelForImageTextToText']);
    } finally {
      await replay.close();
    }
    for (const capture of captures) expect(capture.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);

  it('replays historical supplied assistant text after first-request settlement without treating it as corrected continuity', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['first-turn', 'continuity'], artifactPaths: recordedArtifacts, imagePlatform: undefined });
    const captures: ProviderChatCapture[] = [];
    try {
      const firstSignal = new AbortController().signal;
      const firstParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "first-turn", parameters: firstParameters });
      const firstCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
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
      expect(firstObserved.responses.map(chunks => chunks.join(''))).toEqual(["<think>Okay, the user just said \"Template probe user message.\" Hmm, that's"]);
      expect(firstObserved.preStartChunks).toEqual([]);
      expect(firstObserved.lateEvents).toEqual([]);
      expect(firstObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(firstObserved.toolEvents).toEqual([]);
      expect(firstObserved.toolCalls).toEqual([]);
      expect(firstObserved.toolResults).toEqual([]);
      const nextSignal = new AbortController().signal;
      const nextParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "continuity", parameters: nextParameters });
      const nextCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
            {
              role: "assistant",
              content: "Okay, the user just said \"Template probe user message.\" Hmm, that's",
            },
            {
              role: "user",
              content: "Continue the synthetic conversation with a short response.",
            },
          ],
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
      expect(nextObserved.responses.map(chunks => chunks.join(''))).toEqual([`\
<think>Thinking Process:

1.  **Analyze the Request:**
    *`]);
      expect(nextObserved.responses).toHaveLength(1);
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
    for (const capture of captures) expect(capture.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);

  it('keeps a new conversation independent after settled requests in the same runtime', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['first-turn', 'continuity', 'independent-next-input'], artifactPaths: recordedArtifacts, imagePlatform: undefined });
    const captures: ProviderChatCapture[] = [];
    try {
      const firstSignal = new AbortController().signal;
      const firstParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "first-turn", parameters: firstParameters });
      const firstCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
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
      expect(firstObserved.responses.map(chunks => chunks.join(''))).toEqual(["<think>Okay, the user just said \"Template probe user message.\" Hmm, that's"]);
      expect(firstObserved.preStartChunks).toEqual([]);
      expect(firstObserved.lateEvents).toEqual([]);
      expect(firstObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(firstObserved.toolEvents).toEqual([]);
      expect(firstObserved.toolCalls).toEqual([]);
      expect(firstObserved.toolResults).toEqual([]);
      const nextSignal = new AbortController().signal;
      const nextParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "continuity", parameters: nextParameters });
      const nextCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
            {
              role: "assistant",
              content: "Okay, the user just said \"Template probe user message.\" Hmm, that's",
            },
            {
              role: "user",
              content: "Continue the synthetic conversation with a short response.",
            },
          ],
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
      expect(nextObserved.responses.map(chunks => chunks.join(''))).toEqual([`\
<think>Thinking Process:

1.  **Analyze the Request:**
    *`]);
      expect(nextObserved.responses).toHaveLength(1);
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
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "A separate synthetic capture conversation.",
            },
          ],
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
      expect(independentObserved.responses.map(chunks => chunks.join(''))).toEqual(["<think>Okay"]);
      expect(independentObserved.responses).toHaveLength(1);
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

  it('preserves the recorded none-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['reasoning-none'], artifactPaths: recordedArtifacts, imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: "none" } };
      replay.beginNativeRequest({ caseId: "reasoning-none", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses).toHaveLength(1);
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

  it('preserves the recorded low-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['reasoning-low'], artifactPaths: recordedArtifacts, imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: "low" } };
      replay.beginNativeRequest({ caseId: "reasoning-low", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses).toHaveLength(1);
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

  it('preserves the recorded medium-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['reasoning-medium'], artifactPaths: recordedArtifacts, imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: "medium" } };
      replay.beginNativeRequest({ caseId: "reasoning-medium", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses).toHaveLength(1);
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

  it('preserves the recorded high-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['reasoning-high'], artifactPaths: recordedArtifacts, imagePlatform: undefined });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: "high" } };
      replay.beginNativeRequest({ caseId: "reasoning-high", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "Template probe user message.",
            },
          ],
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses).toHaveLength(1);
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

  it('executes the recorded minimal weather call once with Tokyo arguments and continues to settlement', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['natural-tool-minimal'], artifactPaths: recordedArtifacts, imagePlatform: undefined });
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
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "Use the weather tool for Tokyo.",
            },
          ],
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
<think>The user is asking me to use the weather tool for Tokyo. I have a function called "lookup_weather" that takes a city parameter. I should call this function with "Tokyo" as the city parameter.
</think>

`, `\
<think>The weather tool has returned data for Tokyo. I can see that the temperature is 20°C and the condition is clear. I should present this information to the user in a clear and helpful way.
</think>

The current weather in Tokyo is:

- **Temperature:** 20°C
- **Condition:** Clear

This looks like a pleasant day in Tokyo! Enjoy the clear weather.
`]);
      expect(observed.responses).toHaveLength(2);
      expect(observed.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "tool-call", "tool-result", "assistant-start", "settled"]);
      expect(observed.preStartChunks).toEqual([]);
      expect(observed.lateEvents).toEqual([]);
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
    expect(capture?.snapshot().lateEvents).toEqual([]);
  }, 30_000);

  it('executes the recorded representative weather call once with Tokyo arguments and continues to settlement', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['natural-tool-representative'], artifactPaths: recordedArtifacts, imagePlatform: undefined });
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
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "Use lookup_weather for Tokyo, then give a short answer based on the tool result.",
            },
          ],
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
<think>The user wants me to use the lookup_weather function for Tokyo and then provide a short answer based on the result. I need to call the function with "Tokyo" as the city parameter.
</think>

`, `\
<think>The tool returned weather data for Tokyo showing a temperature of 20°C and clear conditions. I should provide a short answer based on this result.
</think>

The weather in Tokyo is currently 20°C with clear conditions.
`]);
      expect(observed.responses).toHaveLength(2);
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

  it('keeps supplied tool history independent after a settled tool request without executing its supplied call', async () => {
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['natural-tool-representative', 'structured-tool-history'], artifactPaths: recordedArtifacts, imagePlatform: undefined });
    const captures: ProviderChatCapture[] = [];
    try {
      const firstSignal = new AbortController().signal;
      const firstParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      const firstExecutedArgs: unknown[] = [];
      const firstExecutedSignals: Array<AbortSignal | undefined> = [];
      const firstExecute = vi.fn<Tool['execute']>(async ({ args, signal }) => {
        firstExecutedArgs.push(structuredClone(args));
        firstExecutedSignals.push(signal);
        return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
      });
      const firstTools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.", parametersSchema: z.object({ city: z.string() }), execute: firstExecute }];
      replay.beginNativeRequest({ caseId: "natural-tool-representative", parameters: firstParameters });
      const firstCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
          messages: [
            {
              role: "user",
              content: "Use lookup_weather for Tokyo, then give a short answer based on the tool result.",
            },
          ],
          tools: firstTools,
          parameters: firstParameters,
          signal: firstSignal,
        },
      });
      captures.push(firstCapture);
      await firstCapture.completion;
      replay.endNativeRequest();
      const firstObserved = firstCapture.snapshot();
      expect(firstObserved.settlement).toEqual({ status: 'fulfilled' });
      expect(firstObserved.responses.map(chunks => chunks.join(''))).toEqual([`\
<think>The user wants me to use the lookup_weather function for Tokyo and then provide a short answer based on the result. I need to call the function with "Tokyo" as the city parameter.
</think>

`, `\
<think>The tool returned weather data for Tokyo showing a temperature of 20°C and clear conditions. I should provide a short answer based on this result.
</think>

The weather in Tokyo is currently 20°C with clear conditions.
`]);
      expect(firstObserved.responses).toHaveLength(2);
      expect(firstObserved.preStartChunks).toEqual([]);
      expect(firstObserved.lateEvents).toEqual([]);
      expect(firstObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "tool-call", "tool-result", "assistant-start", "settled"]);
      expect(firstObserved.toolEvents).toEqual([]);
      expect(firstExecutedArgs).toEqual([{ city: 'Tokyo' }]);
      expect(firstExecute).toHaveBeenCalledOnce();
      expect(firstExecutedSignals).toHaveLength(1);
      expect(firstExecutedSignals[0]).toBe(firstSignal);
      expect(firstObserved.toolCalls).toHaveLength(1);
      expect(firstObserved.toolCalls[0]).toEqual({ id: expect.any(String), toolName: 'lookup_weather', modelVisibleArguments: '{"city":"Tokyo"}' });
      expect(firstObserved.toolResults).toEqual([{  id: firstObserved.toolCalls[0]!.id, result: { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }  }]);
      const nextSignal = new AbortController().signal;
      const nextParameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 128, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      const nextExecutedArgs: unknown[] = [];
      const nextExecute = vi.fn<Tool['execute']>(async ({ args }) => {
        nextExecutedArgs.push(structuredClone(args));
        return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
      });
      const nextTools: Tool[] = [{ name: "lookup_weather", description: "Return deterministic weather fixture data.", parametersSchema: z.object({ city: z.string() }), execute: nextExecute }];
      replay.beginNativeRequest({ caseId: "structured-tool-history", parameters: nextParameters });
      const nextCapture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
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
          tools: nextTools,
          parameters: nextParameters,
          signal: nextSignal,
        },
      });
      captures.push(nextCapture);
      await nextCapture.completion;
      replay.endNativeRequest();
      const nextObserved = nextCapture.snapshot();
      expect(nextObserved.settlement).toEqual({ status: 'fulfilled' });
      expect(nextObserved.responses.map(chunks => chunks.join(''))).toEqual([`\
<think>The user asked me to use the weather tool for Tokyo. I have the result from the tool call. Now I should present this information in a clear and helpful way.

The weather data for Tokyo shows:
- Temperature: 20°C
- Condition: clear

I'll present this information clearly to the user.
</think>

Here is the current weather forecast for Tokyo:

*   **Temperature:** 20°C
*   **Condition:** Clear

It looks like a pleasant day in Tokyo right now!
`]);
      expect(nextObserved.responses).toHaveLength(1);
      expect(nextObserved.preStartChunks).toEqual([]);
      expect(nextObserved.lateEvents).toEqual([]);
      expect(nextObserved.events.filter(event => event.kind !== 'chunk').map(event => event.kind)).toEqual(["assistant-start", "settled"]);
      expect(nextObserved.toolEvents).toEqual([]);
      expect(nextObserved.toolCalls).toEqual([]);
      expect(nextObserved.toolResults).toEqual([]);
      expect(nextExecute).not.toHaveBeenCalled();
      replay.assertComplete({ requests: 2, nativeCalls: 3 });
    } finally {
      await replay.close();
    }
    for (const capture of captures) expect(capture.snapshot().lateEvents, 'through awaited Worker disposal').toEqual([]);
  }, 30_000);

  it('preserves recorded image processor inputs and delivers the one-token callback before settlement', async () => {
    const platform = createProviderReplayTestImagePlatform();
    const replay = await createProviderRequestReplay({ catalog: providerReplayCatalog, caseIds: ['image'], artifactPaths: recordedArtifacts,
      imagePlatform: { platform, allowedDataUrls: [recordedImageUrl] },
    });
    let capture: ProviderChatCapture | undefined;
    try {
      const signal = new AbortController().signal;
      const parameters: Parameters<typeof replay.provider.chat>[0]['parameters'] = { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } };
      replay.beginNativeRequest({ caseId: "image", parameters: parameters });
      capture = captureProviderChat({
        provider: replay.provider,
        request: {
          model: "onnx-community/Qwen3.5-4B-ONNX",
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
          tools: [],
          parameters,
          signal,
        },
      });
      await capture.completion;
      replay.endNativeRequest();
      const observed = capture.snapshot();
      expect(observed.settlement).toEqual({ status: 'fulfilled' });
      expect(observed.responses.map(chunks => chunks.join(''))).toEqual(["<think>The"]);
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

describe('Qwen3.5 4B Provider / recorded Full collection', () => {
  it('preserves twelve fulfilled requests and the historical source continuity gap across fifteen native calls under one accepted offline Load', async () => {
    const evidence = assembleProviderSequenceEvidence({ catalog: providerReplayCatalog });
    expect(evidence.modelId).toBe(modelId);
    expect(evidence.metadataRevision).toBe(revision);
    expect(evidence.observedCacheRevision).toBe(revision);
    expect(evidence.loadReceipt).toMatchObject({
      modelId, autoClass: 'AutoModelForImageTextToText', processor: 'qwen3_5-processor',
      loaderRevisionOption: { status: 'provided', value: revision },
      candidate: { device: 'webgpu', dtype: 'q4f16' },
      completion: 'model-session-and-tokenizer-processor-ready',
      resourceHealth: 'healthy-after-close', accessBoundary: 'production-offline-read-only',
    });
    expect(evidence.loadReceipt.plannedRequiredPaths).toEqual([
      'config.json', ...recordedArtifacts, 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
    ]);
    expect(evidence.loadReceipt.cacheLookup.hitPaths).toEqual(evidence.loadReceipt.plannedRequiredPaths);
    expect(evidence.requests.map(request => request.scenario)).toEqual([
      'first-turn', 'continuity', 'independent-next-input', 'system-user', 'supplied-history',
      'reasoning-none', 'reasoning-low', 'reasoning-medium', 'reasoning-high',
      'natural-tool-minimal', 'natural-tool-representative', 'structured-tool-history', 'image',
    ]);
    expect(evidence.invocations).toHaveLength(15);
    // Native cache bytes are excluded from capture. Every observed call,
    // including tool continuations, reports zero past tokens in this model.
    expect(evidence.invocations.map(invocation => invocation.settings.budget.pastTokenCount)).toEqual(Array(15).fill(0));
    const platform = createProviderReplayTestImagePlatform();
    const invalidatedInputs: ReturnType<typeof captureQwen4NativeInput>[] = [];
    await verifyCapturedFullReplay({ evidence, artifactPaths: recordedArtifacts,
      reviewedPublicContract: {
        correctedEvents: evidence.requests.filter(request => [
          'first-turn', 'independent-next-input', 'system-user', 'supplied-history',
          'reasoning-low', 'reasoning-medium', 'reasoning-high', 'natural-tool-minimal',
          'natural-tool-representative', 'structured-tool-history', 'image',
        ].includes(request.scenario)).map(request => ({
          scenario: request.scenario,
          reason: 'This model opens thinking in the default and enabled native prompts; retain the recorded chunks and restore only the prompt-owned opening callback.',
          expectedEvents: request.events.flatMap(event => {
            if (typeof event !== 'object' || event === null || Array.isArray(event)) throw new Error('Expected recorded Provider event');
            return event.kind === 'assistant-start'
              ? [event, { phase: 'before-settlement', kind: 'chunk', chunk: '<think>' }]
              : [event];
          }).map((event, sequence) => ({ ...event, sequence })),
        })),
        invalidatedOutputs: [{ callOrdinal: 2, scenario: 'continuity',
          reason: 'The corrected first response adds a native input token; this historical source has no output for that 51-token input. The newer successful source is tested separately.',
          requestInput: {
            messages: [
              { role: 'user', content: 'Template probe user message.' },
              { role: 'assistant', content: '<think>Okay, the user just said "Template probe user message." Hmm, that\'s' },
              { role: 'user', content: 'Continue the synthetic conversation with a short response.' },
            ], tools: [],
            parameters: { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: null, frequencyPenalty: null, stop: null, reasoning: { effort: null } },
          },
          expectedEventsBeforeGap: [{ sequence: 0, phase: 'before-settlement', kind: 'assistant-start' }],
          verifyInput: context => {
            // This gap always stops without output; inspect the detached
            // observation after the Full owner has settled and disposed.
            invalidatedInputs.push(captureQwen4NativeInput(context));
          },
        }],
      },
      imagePlatform: { platform, allowedDataUrls: [recordedImageUrl] },
      unavailableOutputs: [], completeResult: undefined, expectedLoadReceipt: undefined,
    });
    expect(invalidatedInputs).toHaveLength(1);
    const invalidatedInput = invalidatedInputs[0];
    expect(invalidatedInput?.input.isTensor).toBe(true);
    expect(invalidatedInput?.mask.isTensor).toBe(true);
    if (!invalidatedInput?.input.isTensor || !invalidatedInput.mask.isTensor) throw new Error('Expected corrected-history native text tensors');
    expect(Array.from(invalidatedInput.input.data, Number)).toEqual([
      248045, 846, 198, 7048, 21059, 1156, 1876, 13, 248046, 198, 248045, 74455, 198,
      248068, 31248, 11, 279, 1156, 1066, 1018, 328, 7048, 21059, 1156, 1876, 1149, 85152, 11, 421, 579,
      248046, 198, 248045, 846, 198, 22791, 279, 26388, 10125, 440, 264, 2716, 1965, 13, 248046, 198,
      248045, 74455, 198, 248068, 198,
    ]);
    expect(invalidatedInput.input.dims).toEqual([1, 51]);
    expect(invalidatedInput.mask.dims).toEqual([1, 51]);
    expect(invalidatedInput.mask.data).toEqual(new BigInt64Array(51).fill(1n));
    expect(invalidatedInput.pastIsNull).toBe(true);
    expect([invalidatedInput.settings.maxNewTokens, invalidatedInput.settings.temperature, invalidatedInput.settings.topP, invalidatedInput.settings.doSample, invalidatedInput.returnDict]).toEqual([16, 0, 1, false, true]);
    expect(invalidatedInput.isTextStreamer).toBe(true);
    expect(invalidatedInput.stoppingCriteriaType).toBe('function');
  }, 30_000);
});
