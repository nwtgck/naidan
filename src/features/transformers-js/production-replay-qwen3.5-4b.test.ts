// @vitest-environment node
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from './download-verification/fixtures/raw-download-replay/synthetic-session-oracle';
import { createProductionReplayTestImagePlatform } from './production-replay-test-image-platform';
import { createProductionReplayTestRuntime, type ProductionReplayGenerate } from './production-replay-test-runtime';
import { readModelFixture } from '@/features/transformers-js/download-verification/fixtures/model-runtime-fixture';

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

function createQwen4Replay({ generate }: { generate: ProductionReplayGenerate }) {
  const metadata = readModelFixture({ modelId });
  expect(metadata.summary.revision).toBe(revision);
  expect(createHash('sha256').update(metadata.files.get('tokenizer_config.json')!).digest('hex')).toBe('2de621ec071dd61438efdd6d0183bd3d612e98d05ac10d19ed75f1fef9299bc9');
  expect(createHash('sha256').update(metadata.files.get('tokenizer.json')!).digest('hex')).toBe('89da80cc6689bef4d90cc1028249436975ffb0814618f1d93c65310e05801a9b');
  return createProductionReplayTestRuntime({
    imagePlatform: undefined,
    modelId, expectedRevision: revision,
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

// Model-specific input-boundary mechanics only. Callers own the native options,
// public reasoning request and independently expected text. No generation result
// exists for these scenarios, and no prior answer or KV state is invented.
async function verifyQwen4PublicInput({ inputMessages, expectedText, nativeRenderOptions, effort }: {
  inputMessages: ChatMessage[], expectedText: string,
  nativeRenderOptions: {
    tokenize: false, add_generation_prompt: true,
  } | {
    tokenize: false, add_generation_prompt: true, enable_thinking: boolean,
  },
  effort: 'none' | 'low' | 'medium' | 'high' | undefined,
}) {
  const stop = 'Qwen4 input-only comparison; no output tokens supplied';
  let actualInput: number[] | undefined;
  const generate = vi.fn<ProductionReplayGenerate>(async ({ options, tokenizer, runtime }) => {
    expect(tokenizer).toBe(harness.observations.processors[0]?.tokenizer);
    if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) {
      throw new Error('Expected actual Qwen4 processor input/mask');
    }
    actualInput = Array.from(options.input_ids.data, Number);
    expect(options.input_ids.type).toBe('int64');
    expect(options.input_ids.location).toBe('cpu');
    expect(options.input_ids.dims).toEqual([1, actualInput.length]);
    expect(options.attention_mask.type).toBe('int64');
    expect(options.attention_mask.location).toBe('cpu');
    expect(options.attention_mask.dims).toEqual([1, actualInput.length]);
    expect(Array.from(options.attention_mask.data, BigInt)).toEqual(actualInput.map(() => 1n));
    expect(options.past_key_values).toBeNull();
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
    const chunks: string[] = [];
    await expect(harness.provider.chat({
      model: modelId, messages: inputMessages, tools: [],
      parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort } },
      onChunk: ({ chunk }) => chunks.push(chunk),
    })).rejects.toThrow(stop);
    expect(generate).toHaveBeenCalledOnce();
    expect(harness.observations.inferenceCalls).toHaveLength(1);
    expect(chunks).toEqual([]);
    expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
    expect(harness.observations.localImageFetchCalls).toEqual([]);
    expect(harness.observations.forbiddenTransport).toEqual([]);
    expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    // Only compare after native control and offline/sentinel checks. Default
    // parity does not by itself define the application's reasoning policy.
    expect(actualInput).toEqual(expectedIds);
  } finally {
    await harness.close();
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
  const generate = vi.fn<ProductionReplayGenerate>(async () => {
    throw new Error(QWEN4_TOOL_BOUNDARY);
  });
  const execute = vi.fn<Tool['execute']>(async () => {
    throw new Error('No natural tool invocation in this fixture');
  });
  const publicTool: Tool = {
    name: 'lookup_temperature', description: 'Return synthetic fixture temperature.', parametersSchema: z.object({ place: z.string() }), execute,
  };
  const harness = await createProductionReplayTestRuntime({
    modelId, expectedRevision: revision, imagePlatform: undefined,
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
    const serializer = await import('./models/qwen3_5');
    const builderSpy = vi.spyOn(serializer, 'buildQwen3_5Prompt');
    const processorSpy = vi.spyOn(processor, '_call');
    return { harness, generate, execute, publicTool, tokenizer: processor.tokenizer, builderSpy, processorSpy, async close() {
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

async function captureQwen4ToolInput({ replay, inputMessages, publicTool, expectedDefinition, expectedPrompt }: {
  replay: Awaited<ReturnType<typeof createQwen4ToolReplay>>, inputMessages: ChatMessage[], publicTool: Tool,
  expectedDefinition: z.infer<typeof qwen4ToolDefinitionSchema>, expectedPrompt: string,
}) {
  const before = replay.generate.mock.calls.length;
  const chunks: string[] = [];
  const onToolCall = vi.fn();
  const onToolResult = vi.fn();
  await expect(replay.harness.provider.chat({
    model: modelId, messages: inputMessages, tools: [publicTool],
    parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
    onChunk: ({ chunk }) => chunks.push(chunk), onToolCall, onToolResult,
  })).rejects.toThrow(QWEN4_TOOL_BOUNDARY);
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
  const inference = replay.generate.mock.calls[before]?.[0];
  if (!inference) throw new Error('Expected actual Qwen4 inference boundary');
  expect(inference.tokenizer).toBe(replay.tokenizer);
  const { options, runtime } = inference;
  if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) throw new Error('Expected actual Qwen4 tensors');
  const currentNative = replay.tokenizer(expectedPrompt);
  expect(currentNative.input_ids).toBeInstanceOf(runtime.Tensor);
  const ids = Array.from(currentNative.input_ids.data, Number);
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

describe('Qwen3.5 4B exact-metadata native-default parity; no generation evidence', () => {
  it('matches native-default input through public Provider before releasing any tokens', async () => {
    let actualInput: bigint[] | undefined;
    const stop = new Error('Qwen4 inference intentionally stopped at input boundary');
    const generate = vi.fn<ProductionReplayGenerate>(async ({ options, tokenizer, runtime }) => {
      const input = options.input_ids;
      const mask = options.attention_mask;
      if (!(input instanceof runtime.Tensor) || !(mask instanceof runtime.Tensor)) throw new Error('Expected actual Qwen4 processor tensors');
      expect(tokenizer).toBe(harness.observations.processors[0]?.tokenizer);
      actualInput = Array.from(input.data, BigInt);
      expect(input.type).toBe('int64');
      expect(mask.type).toBe('int64');
      expect(input.dims).toEqual([1, actualInput.length]);
      expect(mask.dims).toEqual(input.dims);
      expect(Array.from(mask.data, BigInt)).toEqual(actualInput.map(() => 1n));
      expect(tokenizer.apply_chat_template(messages, { tokenize: true, add_generation_prompt: true, return_tensor: false, return_dict: false })).toEqual(defaultIds);
      // Neither captured nor invented generation tokens are released. Native
      // default parity alone does not establish a correct user reasoning policy.
      throw stop;
    });
    const harness = await createQwen4Replay({ generate });
    const chunks: string[] = [];
    try {
      await expect(harness.provider.chat({
        model: `hf.co/${modelId}`, messages, tools: [],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 16, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => chunks.push(chunk),
      })).rejects.toThrow(stop.message);
      expect(generate).toHaveBeenCalledOnce();
      expect(harness.observations.processors).toHaveLength(1);
      expect(chunks).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      expect(actualInput).toEqual(defaultIds.map(BigInt));
    } finally {
      await harness.close();
    }
  }, 30_000);

  it.each(historyCases)('$name retains the independently specified native input through Provider', async scenario => {
    await verifyQwen4PublicInput({
      inputMessages: scenario.messages, expectedText: scenario.expectedText,
      nativeRenderOptions: { tokenize: false, add_generation_prompt: true }, effort: undefined,
    });
  }, 30_000);

  it('independently preserves native default thinking and explicit disabled-thinking input', async () => {
    const generate = vi.fn<ProductionReplayGenerate>(async () => {
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
    await verifyQwen4PublicInput({
      inputMessages: messages, expectedText: scenario.expectedText,
      nativeRenderOptions: { tokenize: false, add_generation_prompt: true, enable_thinking: scenario.enableThinking },
      effort: scenario.effort,
    });
  }, 30_000);
});

describe('Qwen4 exact-metadata native tool input contract; natural tool generation is unobserved', () => {
  it('preserves the complete strict public tool schema independently of Qwen4 native XML and default thinking', async () => {
    const replay = await createQwen4ToolReplay();
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
      await captureQwen4ToolInput({
        replay, inputMessages, publicTool: replay.publicTool, expectedDefinition: qwen4StrictTools[0], expectedPrompt: nativePrompt,
      });
      // Observe an actual second public request with both changes, not only a
      // native render after a serializer that might have dropped the definition.
      const changedDescription = 'Read a different synthetic temperature source.';
      const changedContent = 'Read the fixture temperature for Bergen.';
      expect(jsonPrompt.split(replay.publicTool.description)).toHaveLength(2);
      expect(jsonPrompt.split(qwen4ToolUser.content)).toHaveLength(2);
      const changedDefinition = {
        ...qwen4StrictTools[0], function: { ...qwen4StrictTools[0].function, description: changedDescription },
      };
      await captureQwen4ToolInput({
        replay, inputMessages: [{ role: 'user', content: changedContent }],
        publicTool: { ...replay.publicTool, description: changedDescription }, expectedDefinition: changedDefinition,
        expectedPrompt: nativePrompt.replace(replay.publicTool.description, changedDescription).replace(qwen4ToolUser.content, changedContent),
      });
      expect(replay.tokenizer.apply_chat_template([{ role: 'user', content: changedContent }], {
        tokenize: false, add_generation_prompt: true, tools: [changedDefinition],
      })).toBe(nativePrompt.replace(replay.publicTool.description, changedDescription).replace(qwen4ToolUser.content, changedContent));
      expect(replay.harness.observations.inferenceCalls).toHaveLength(2);
    } finally {
      await replay.close();
    }
  }, 30_000);

  it('retains supplied call content and string-valued arguments through the public native mapping', async () => {
    const replay = await createQwen4ToolReplay();
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
      await captureQwen4ToolInput({
        replay, inputMessages, publicTool: replay.publicTool, expectedDefinition: qwen4StrictTools[0], expectedPrompt: nativePrompt,
      });
      const changedContent = 'Checking a second supplied place.';
      const changedCall = {
        role: 'assistant' as const, content: changedContent, tool_calls: [{
          id: toToolCallId({ raw: 'qwen4_synthetic_call_2' }), type: 'function' as const,
          function: { name: 'lookup_temperature', arguments: '{"place":"Bergen"}' },
        }],
      };
      expect(jsonPrompt.split(qwen4SuppliedCall.content)).toHaveLength(2);
      expect(jsonPrompt.split('{"place":"Oslo"}')).toHaveLength(2);
      await captureQwen4ToolInput({
        replay, inputMessages: [qwen4ToolUser, changedCall], publicTool: replay.publicTool, expectedDefinition: qwen4StrictTools[0],
        expectedPrompt: nativePrompt.replace(qwen4SuppliedCall.content, changedContent).replace('\nOslo\n', '\nBergen\n'),
      });
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
  }, 30_000);

  it('retains supplied association IDs at builder entry and serializes result content without natural generation output', async () => {
    const replay = await createQwen4ToolReplay();
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
      await captureQwen4ToolInput({
        replay, inputMessages, publicTool: replay.publicTool, expectedDefinition: qwen4StrictTools[0], expectedPrompt: nativePrompt,
      });
      const changedResult = { ...qwen4SuppliedResult, content: '{"celsius":11,"source":"synthetic-second"}' };
      expect(jsonPrompt.split(qwen4SuppliedResult.content)).toHaveLength(2);
      await captureQwen4ToolInput({
        replay, inputMessages: [qwen4ToolUser, qwen4SuppliedCall, changedResult], publicTool: replay.publicTool,
        expectedDefinition: qwen4StrictTools[0], expectedPrompt: nativePrompt.replace(qwen4SuppliedResult.content, changedResult.content),
      });
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
  }, 30_000);
});

describe('Qwen3.5 4B native image input versus actual public Provider', () => {
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
    const platform = createProductionReplayTestImagePlatform();
    let actual: Parameters<ProductionReplayGenerate>[0] | undefined;
    const harness = await createProductionReplayTestRuntime({
      modelId, expectedRevision: revision, imagePlatform: { platform, allowedDataUrls: [imageUrl] },
      artifacts: [
        'onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model_merged_q4f16.onnx_data',
        'onnx/decoder_model_merged_q4f16.onnx_data_1', 'onnx/embed_tokens_q4f16.onnx', 'onnx/embed_tokens_q4f16.onnx_data',
        'onnx/vision_encoder_q4f16.onnx', 'onnx/vision_encoder_q4f16.onnx_data',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId, revision, path }) })),
      generate: async context => {
        actual = context;
        throw new Error(boundary);
      },
    });
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

      const chunks: string[] = [];
      await expect(harness.provider.chat({
        model: modelId, messages, tools: [],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => chunks.push(chunk),
      })).rejects.toThrow(boundary);
      if (!actual) throw new Error('Actual public image request never reached inference');
      expect(actual.tokenizer).toBe(processor.tokenizer);
      expect(actual.options.past_key_values).toBeNull();
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(chunks).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
      // Keep the native control's fetch separate from Production. Passing the
      // control must not conceal that Production discarded the image content.
      expect({
        productionImageFetches: harness.observations.localImageFetchCalls.slice(nativeFetchCount),
        hasPixels: actual.options.pixel_values instanceof harness.runtime.Tensor,
        hasGrid: actual.options.image_grid_thw instanceof harness.runtime.Tensor,
      }).toEqual({ productionImageFetches: [imageUrl], hasPixels: true, hasGrid: true });
      const actualTensors = tensorSchema.parse(actual.options);
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
  }, 30_000);
});
