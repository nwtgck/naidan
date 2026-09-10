// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';
import { originalBundledJinjaTemplate } from '../../../build/transformers-js-fixes/jinja-template-fixture';
import inputJson from './production-replay-lfm2.5-230m.input.evidence.json';
import { readModelFixture } from './download-verification/fixtures/model-runtime-fixture';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from './download-verification/fixtures/raw-download-replay/synthetic-session-oracle';
import { createProductionReplayTestRuntime, type ProductionReplayGenerate } from './production-replay-test-runtime';

const MODEL_ID = 'LiquidAI/LFM2.5-230M-ONNX';
const REVISION = 'c6f46e4e3f885ebcad164d14059a49f90e27eb4d';
const INPUT_BOUNDARY = 'LFM230 native input verified; no generation evidence is supplied';

const textMessageSchema = z.object({ role: z.enum(['user', 'system', 'assistant']), content: z.string() }).strict();
const callSchema = z.object({
  id: z.literal('call_template_probe_1'), type: z.literal('function'),
  function: z.object({ name: z.literal('lookup_weather'), arguments: z.literal('{"city":"Tokyo"}') }).strict(),
}).strict();
const assistantCallSchema = z.object({ role: z.literal('assistant'), content: z.literal(''), tool_calls: z.tuple([callSchema]) }).strict();
const resultSchema = z.object({ role: z.literal('tool'), content: z.string(), tool_call_id: z.literal('call_template_probe_1') }).strict();
const toolsSchema = z.tuple([z.object({
  type: z.literal('function'), function: z.object({
    name: z.literal('lookup_weather'), description: z.literal('Return deterministic weather fixture data.'),
    parameters: z.object({
      type: z.literal('object'), properties: z.object({ city: z.object({ type: z.literal('string') }).strict() }).strict(),
      required: z.tuple([z.literal('city')]),
    }).strict(),
  }).strict(),
}).strict()]);
const originalFailureSchema = z.object({
  status: z.literal('failed'), failureStage: z.literal('render'),
  selectedTemplateSha256: z.literal('6d65c8804847ad74eea912dd7eca3dc1cf7a457b53a77f47d841a14121910963'),
  error: z.object({ name: z.literal('SyntaxError'), message: z.literal('Unknown statement type: generation') }).strict(),
}).strict();
const inputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('83b2d8884f891fae7de974a20b56d94958bdf02bafac678d4503adf8f302ea42'),
  modelId: z.literal(MODEL_ID), revision: z.literal(REVISION),
  // These are six failed source invocations, not six successful captures. The
  // strict schema deliberately has no renderedText/inputTokenIds/output fields.
  cases: z.tuple([
    originalFailureSchema.extend({ caseId: z.literal('user-generation'), messages: z.tuple([textMessageSchema]), addGenerationPrompt: z.literal(true) }),
    originalFailureSchema.extend({ caseId: z.literal('system-user-generation'), messages: z.tuple([textMessageSchema, textMessageSchema]), addGenerationPrompt: z.literal(true) }),
    originalFailureSchema.extend({ caseId: z.literal('multi-turn-generation'), messages: z.tuple([textMessageSchema, textMessageSchema, textMessageSchema]), addGenerationPrompt: z.literal(true) }),
    originalFailureSchema.extend({ caseId: z.literal('tools-generation'), messages: z.tuple([textMessageSchema]), tools: toolsSchema, addGenerationPrompt: z.literal(true) }),
    originalFailureSchema.extend({ caseId: z.literal('assistant-tool-call-history'), messages: z.tuple([textMessageSchema, assistantCallSchema]), tools: toolsSchema, addGenerationPrompt: z.literal(false) }),
    originalFailureSchema.extend({ caseId: z.literal('tool-result-continuation'), messages: z.tuple([textMessageSchema, assistantCallSchema, resultSchema]), tools: toolsSchema, addGenerationPrompt: z.literal(true) }),
  ]),
}).strict().parse(inputJson);

const observedMessagesSchema = z.array(z.object({
  role: z.enum(['user', 'system', 'assistant', 'tool']), content: z.string(), tool_call_id: z.string().optional(),
  tool_calls: z.array(z.object({
    id: z.string(), type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.object({ city: z.string() }).strict() }).strict(),
  }).strict()).optional(),
}).strict());
function semanticMessages({ messages }: { messages: unknown }) {
  return observedMessagesSchema.parse(messages).map(message => {
    const { role, content, tool_calls, tool_call_id, ...unhandled } = message;
    unhandled satisfies Record<PropertyKey, never>;
    return { role, content, tool_calls, tool_call_id };
  });
}
const strictTools = [{ type: 'function', function: {
  name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], additionalProperties: false },
} }];
// Independently written current-template expectations, NOT source render data.
const strictToolPrelude = `\
<|startoftext|><|im_start|>system
List of tools: [{"type": "function", "function": {"name": "lookup_weather", "description": "Return deterministic weather fixture data.", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"], "additionalProperties": false}}}]<|im_end|>
<|im_start|>user
Use the weather tool for Tokyo.<|im_end|>
`;
const assistantCallBody = `\
<|im_start|>assistant
<|tool_call_start|>[lookup_weather(city='Tokyo')]<|tool_call_end|><|im_end|>
`;
const assistantPrefix = `<|im_start|>assistant\n`;

function createPublicTool() {
  const execute = vi.fn<Tool['execute']>(async () => {
    throw new Error('Input-only tool must not execute');
  });
  const tool: Tool = {
    name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
    parametersSchema: z.object({ city: z.string() }), execute,
  };
  return { tool, execute };
}

// Model-local shared ownership and input-boundary checks. Scenario-specific
// prompts, mappings and native controls remain at their independent call sites.
async function createLfm230InputReplay() {
  const seen: { inference: Parameters<ProductionReplayGenerate>[0] | undefined } = { inference: undefined };
  const harness = await createProductionReplayTestRuntime({
    modelId: MODEL_ID, expectedRevision: REVISION, imagePlatform: undefined,
    artifacts: ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'].map(path => ({
      path, bytes: createSyntheticModelBody({ modelId: MODEL_ID, revision: REVISION, path }),
    })),
    generate: async context => {
      seen.inference = context;
      // No successful recorded generation exists for these source invocations.
      throw new Error(INPUT_BOUNDARY);
    },
  });
  const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
  return { harness, seen, templateSpy, async close() {
    templateSpy.mockRestore();
    await harness.close();
  } };
}

async function captureLfm230Input({ replay, messages, tools, expectedMessages, expectedTemplateOptions, expectedPrompt }: {
  replay: Awaited<ReturnType<typeof createLfm230InputReplay>>,
  messages: ChatMessage[], tools: Tool[], expectedMessages: unknown,
  expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools?: typeof strictTools },
  expectedPrompt: string,
}) {
  const chunks: string[] = [];
  const onToolCall = vi.fn();
  const onToolResult = vi.fn();
  const priorCalls = replay.templateSpy.mock.calls.length;
  const priorInferences = replay.harness.observations.inferenceCalls.length;
  await expect(replay.harness.provider.chat({
    model: MODEL_ID, messages, tools,
    parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
    onChunk: ({ chunk }) => chunks.push(chunk), onToolCall, onToolResult,
  })).rejects.toThrow(INPUT_BOUNDARY);
  expect(replay.harness.observations.inferenceCalls).toHaveLength(priorInferences + 1);
  expect(chunks).toEqual([]);
  expect(onToolCall).not.toHaveBeenCalled();
  expect(onToolResult).not.toHaveBeenCalled();
  // Protocol probes render without tokenizing; observe actual input preparation
  // before invoking the separate current-native oracle below.
  const calls = replay.templateSpy.mock.calls.slice(priorCalls).filter(([, options]) => options?.tokenize !== false);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call || !replay.seen.inference) throw new Error('Expected actual LFM230 tokenizer and inference entry');
  expect(semanticMessages({ messages: call[0] })).toStrictEqual(semanticMessages({ messages: expectedMessages }));
  expect(call[1]).toStrictEqual(expectedTemplateOptions);
  const { tokenizer, runtime, options } = replay.seen.inference;
  expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(inputEvidence.cases[0].selectedTemplateSha256);
  const currentNative = tokenizer(expectedPrompt, { add_special_tokens: false });
  expect(currentNative.input_ids).toBeInstanceOf(runtime.Tensor);
  const ids = Array.from(currentNative.input_ids.data, Number);
  if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) throw new Error('Expected actual input tensors');
  expect(options.input_ids.type).toBe('int64');
  expect(options.input_ids.location).toBe('cpu');
  expect(options.input_ids.dims).toEqual([1, ids.length]);
  expect(Array.from(options.input_ids.data, Number)).toEqual(ids);
  expect(options.attention_mask.type).toBe('int64');
  expect(options.attention_mask.location).toBe('cpu');
  expect(options.attention_mask.dims).toEqual([1, ids.length]);
  expect(Array.from(options.attention_mask.data, BigInt)).toEqual(ids.map(() => 1n));
  expect(options.past_key_values).toBeNull();
  expect(replay.harness.observations.ortCalls.map(([core, ortOptions]) => inspectSyntheticOrtSession({
    modelId: MODEL_ID, revision: REVISION, repositoryPaths: new Set(['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data']), core, options: ortOptions,
  }))).toEqual([{
    modelId: MODEL_ID, revision: REVISION, corePath: 'onnx/model_q4.onnx',
    externalData: [{ path: 'model_q4.onnx_data', artifactPath: 'onnx/model_q4.onnx_data' }], executionProviders: ['webgpu'],
  }]);
  expect(replay.harness.observations.runtimeAssetFetchCalls).toEqual([replay.harness.observations.expectedRuntimeAssetUrl]);
  expect(replay.harness.observations.localImageFetchCalls).toEqual([]);
  expect(replay.harness.observations.forbiddenTransport).toEqual([]);
  expect(replay.harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  return tokenizer;
}

describe('LFM230 formerly blocked source inputs with current native oracles', () => {
  it.each([
    { scenario: inputEvidence.cases[0], expectedPrompt: `\
<|startoftext|><|im_start|>user
Template probe user message.<|im_end|>
<|im_start|>assistant
` },
    { scenario: inputEvidence.cases[1], expectedPrompt: `\
<|startoftext|><|im_start|>system
Template probe system instruction.<|im_end|>
<|im_start|>user
Template probe user message.<|im_end|>
<|im_start|>assistant
` },
    { scenario: inputEvidence.cases[2], expectedPrompt: `\
<|startoftext|><|im_start|>user
Template probe first user message.<|im_end|>
<|im_start|>assistant
Template probe assistant response.<|im_end|>
<|im_start|>user
Template probe second user message.<|im_end|>
<|im_start|>assistant
` },
  ])('$scenario.caseId reaches actual inference with the independently specified current prompt', async ({ scenario, expectedPrompt }) => {
    const replay = await createLfm230InputReplay();
    try {
      const tokenizer = await captureLfm230Input({
        replay, messages: scenario.messages, tools: [], expectedMessages: scenario.messages,
        expectedTemplateOptions: { add_generation_prompt: true, return_dict: true }, expectedPrompt,
      });
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: scenario.addGenerationPrompt,
      })).toBe(expectedPrompt);
      const changed = scenario.messages.map(message => ({ ...message }));
      const last = changed.at(-1);
      if (!last) throw new Error('Expected source final user message');
      const original = last.content;
      expect(original).not.toBe('');
      expect(expectedPrompt.split(original)).toHaveLength(2);
      last.content = 'Changed synthetic final user input.';
      const changedPrompt = expectedPrompt.replace(original, last.content);
      await captureLfm230Input({
        replay, messages: changed, tools: [], expectedMessages: changed,
        expectedTemplateOptions: { add_generation_prompt: true, return_dict: true }, expectedPrompt: changedPrompt,
      });
      expect(tokenizer.apply_chat_template(changed, { tokenize: false, add_generation_prompt: true })).toBe(changedPrompt);
    } finally {
      await replay.close();
    }
  }, 30_000);
});

describe('LFM2.5 230M public Provider input after the preserved generation-tag fix', () => {
  it('keeps the pre-fix parser failure isolated from the actual fixed Production history path', async () => {
    const metadata = readModelFixture({ modelId: MODEL_ID });
    const configBytes = metadata.files.get('tokenizer_config.json');
    if (!configBytes) throw new Error('Missing original tokenizer config');
    expect(createHash('sha256').update(configBytes).digest('hex'))
      .toBe('c46e3f5715c73f7ae9beeeebad8f7187fd647d2de352c3cd01fe250c88d2f960');
    const config = z.object({ chat_template: z.string() }).parse(JSON.parse(new TextDecoder().decode(configBytes)));
    expect(createHash('sha256').update(config.chat_template).digest('hex')).toBe(inputEvidence.cases[0].selectedTemplateSha256);
    // All six source cases hit this one compiler defect before their rendering
    // settings are consumed. The fixture preserves false for call-history and
    // true for the other five; no source rendering/token IDs are invented.
    expect(inputEvidence.cases.map(scenario => ({
      caseId: scenario.caseId, addGenerationPrompt: scenario.addGenerationPrompt,
    }))).toEqual([
      { caseId: 'user-generation', addGenerationPrompt: true },
      { caseId: 'system-user-generation', addGenerationPrompt: true },
      { caseId: 'multi-turn-generation', addGenerationPrompt: true },
      { caseId: 'tools-generation', addGenerationPrompt: true },
      { caseId: 'assistant-tool-call-history', addGenerationPrompt: false },
      { caseId: 'tool-result-continuation', addGenerationPrompt: true },
    ]);
    const OriginalTemplate = originalBundledJinjaTemplate();
    expect(() => new OriginalTemplate(config.chat_template)).toThrow('Unknown statement type: generation');

    // A synthetic input contract derived from the original template, not a
    // claim of captured successful generation from the formerly blocked model.
    const messages = [
      { role: 'user' as const, content: 'Hello world' },
      { role: 'assistant' as const, content: 'Original assistant body.' },
    ];
    const expectedPrompt = `\
<|startoftext|><|im_start|>user
Hello world<|im_end|>
<|im_start|>assistant
Original assistant body.<|im_end|>
<|im_start|>assistant
`;
    const generate = vi.fn<ProductionReplayGenerate>(async ({ options, tokenizer, runtime }) => {
      expect(tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true }))
        .toBe(expectedPrompt);
      const input = options.input_ids;
      const mask = options.attention_mask;
      if (!(input instanceof runtime.Tensor) || !(mask instanceof runtime.Tensor)) throw new Error('Expected actual LFM input tensors');
      // Encode independently specified text, rather than deriving the oracle
      // from the Production-generated prompt under test.
      const expectedIds = tokenizer.encode(expectedPrompt, { add_special_tokens: false });
      expect(Array.from(input.data, Number)).toEqual(expectedIds);
      expect(input.dims).toEqual([1, expectedIds.length]);
      expect(Array.from(mask.data, Number)).toEqual(expectedIds.map(() => 1));
      expect(options.past_key_values).toBeNull();
      throw new Error(INPUT_BOUNDARY);
    });
    const harness = await createProductionReplayTestRuntime({
      imagePlatform: undefined,
      modelId: MODEL_ID, expectedRevision: REVISION,
      // This repository does not declare q4f16. Seed only the recorded q4
      // candidate; actual local selection must choose it without downloading.
      artifacts: [
        { path: 'onnx/model_q4.onnx', bytes: Uint8Array.of(1) },
        { path: 'onnx/model_q4.onnx_data', bytes: Uint8Array.of(2) },
      ],
      generate,
    });
    try {
      const chunks: string[] = [];
      await expect(harness.provider.chat({
        model: MODEL_ID, messages, tools: [],
        parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
        onChunk: ({ chunk }) => chunks.push(chunk),
      })).rejects.toThrow(INPUT_BOUNDARY);
      expect(generate).toHaveBeenCalledOnce();
      expect(chunks).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
});

describe('LFM230 formerly blocked source inputs with current native oracles', () => {
  it('tools-generation preserves public strict tools without attributing current rendering to the failed native capture', async () => {
    const scenario = inputEvidence.cases[3];
    const replay = await createLfm230InputReplay();
    const { tool, execute } = createPublicTool();
    try {
      const strictPrompt = strictToolPrelude + assistantPrefix;
      const tokenizer = await captureLfm230Input({
        replay, messages: scenario.messages, tools: [tool], expectedMessages: scenario.messages,
        expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools: strictTools }, expectedPrompt: strictPrompt,
      });
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: scenario.addGenerationPrompt, tools: strictTools,
      })).toBe(strictPrompt);
      // The source used an open schema. Public Zod tools intentionally add the
      // strict property; no old output may be reused across that changed input.
      const openPrompt = strictPrompt.replace(', "additionalProperties": false', '');
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: scenario.addGenerationPrompt, tools: scenario.tools,
      })).toBe(openPrompt);
      expect(tokenizer.encode(openPrompt, { add_special_tokens: false })).not.toEqual(tokenizer.encode(strictPrompt, { add_special_tokens: false }));
      const changedTool = { ...tool, description: 'Changed synthetic weather description.' };
      const changedDefinitions = [{ type: 'function', function: { ...strictTools[0]!.function, description: changedTool.description } }];
      const changedPrompt = strictPrompt.replace(tool.description, changedTool.description);
      await captureLfm230Input({
        replay, messages: scenario.messages, tools: [changedTool], expectedMessages: scenario.messages,
        expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools: changedDefinitions }, expectedPrompt: changedPrompt,
      });
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: true, tools: changedDefinitions })).toBe(changedPrompt);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await replay.close();
    }
  }, 30_000);

  it('assistant-tool-call-history separates original false, necessary argument mapping and public true continuation', async () => {
    const scenario = inputEvidence.cases[4];
    const replay = await createLfm230InputReplay();
    const { tool, execute } = createPublicTool();
    const sourceCall = scenario.messages[1].tool_calls[0];
    const publicMessages: ChatMessage[] = [scenario.messages[0], {
      role: 'assistant', content: '', tool_calls: [{ ...sourceCall, id: toToolCallId({ raw: sourceCall.id }) }],
    }];
    const mappedMessages = [scenario.messages[0], {
      role: 'assistant', content: '', tool_calls: [{
        id: 'call_template_probe_1', type: 'function', function: { name: 'lookup_weather', arguments: { city: 'Tokyo' } },
      }],
    }];
    try {
      const currentFalsePrompt = strictToolPrelude + assistantCallBody;
      const currentPublicPrompt = currentFalsePrompt + assistantPrefix;
      const tokenizer = await captureLfm230Input({
        replay, messages: publicMessages, tools: [tool], expectedMessages: mappedMessages,
        expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools: strictTools }, expectedPrompt: currentPublicPrompt,
      });
      // Generation-tag support does not make JSON strings mappings. This is a
      // CURRENT native argument error, distinct from the original parser error.
      expect(() => tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: scenario.addGenerationPrompt, tools: scenario.tools,
      })).toThrow('Cannot call something that is not a function: got UndefinedValue');
      expect(tokenizer.apply_chat_template(mappedMessages, {
        tokenize: false, add_generation_prompt: scenario.addGenerationPrompt, tools: scenario.tools,
      })).toBe(currentFalsePrompt.replace(', "additionalProperties": false', ''));
      expect(tokenizer.apply_chat_template(mappedMessages, {
        tokenize: false, add_generation_prompt: false, tools: strictTools,
      })).toBe(currentFalsePrompt);
      expect(tokenizer.apply_chat_template(mappedMessages, {
        tokenize: false, add_generation_prompt: true, tools: strictTools,
      })).toBe(currentPublicPrompt);
      expect(tokenizer.encode(currentFalsePrompt, { add_special_tokens: false })).not.toEqual(tokenizer.encode(currentPublicPrompt, { add_special_tokens: false }));
      // A second PUBLIC request verifies the call argument itself is retained,
      // not merely echoed by a native-only comparison after a dropped call.
      const changedPublic: ChatMessage[] = [scenario.messages[0], {
        role: 'assistant', content: '', tool_calls: [{
          ...sourceCall, id: toToolCallId({ raw: sourceCall.id }),
          function: { name: sourceCall.function.name, arguments: '{"city":"Osaka"}' },
        }],
      }];
      const changedMapped = [scenario.messages[0], {
        role: 'assistant', content: '', tool_calls: [{
          id: 'call_template_probe_1', type: 'function', function: { name: 'lookup_weather', arguments: { city: 'Osaka' } },
        }],
      }];
      await captureLfm230Input({
        replay, messages: changedPublic, tools: [tool], expectedMessages: changedMapped,
        expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools: strictTools },
        expectedPrompt: currentPublicPrompt.replace("city='Tokyo'", "city='Osaka'"),
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await replay.close();
    }
  }, 30_000);

  it('tool-result-continuation retains the mapped call and result through public input without claiming natural tool execution', async () => {
    const scenario = inputEvidence.cases[5];
    const replay = await createLfm230InputReplay();
    const { tool, execute } = createPublicTool();
    const sourceCall = scenario.messages[1].tool_calls[0];
    const sourceResult = scenario.messages[2];
    const publicMessages: ChatMessage[] = [scenario.messages[0], {
      role: 'assistant', content: '', tool_calls: [{ ...sourceCall, id: toToolCallId({ raw: sourceCall.id }) }],
    }, { ...sourceResult, tool_call_id: toToolCallId({ raw: sourceResult.tool_call_id }) }];
    const mappedMessages = [scenario.messages[0], {
      role: 'assistant', content: '', tool_calls: [{
        id: 'call_template_probe_1', type: 'function', function: { name: 'lookup_weather', arguments: { city: 'Tokyo' } },
      }],
    }, sourceResult];
    try {
      const strictPrompt = strictToolPrelude + assistantCallBody + `\
<|im_start|>tool
{"temperatureC":20,"condition":"clear"}<|im_end|>
<|im_start|>assistant
`;
      const tokenizer = await captureLfm230Input({
        replay, messages: publicMessages, tools: [tool], expectedMessages: mappedMessages,
        expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools: strictTools }, expectedPrompt: strictPrompt,
      });
      expect(() => tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: scenario.addGenerationPrompt, tools: scenario.tools,
      })).toThrow('Cannot call something that is not a function: got UndefinedValue');
      expect(tokenizer.apply_chat_template(mappedMessages, {
        tokenize: false, add_generation_prompt: scenario.addGenerationPrompt, tools: scenario.tools,
      })).toBe(strictPrompt.replace(', "additionalProperties": false', ''));
      expect(tokenizer.apply_chat_template(mappedMessages, {
        tokenize: false, add_generation_prompt: true, tools: strictTools,
      })).toBe(strictPrompt);
      const changedResult = { ...sourceResult, content: '{"temperatureC":18,"condition":"rain"}' };
      const changedPublic: ChatMessage[] = [publicMessages[0]!, publicMessages[1]!, {
        ...changedResult, tool_call_id: toToolCallId({ raw: changedResult.tool_call_id }),
      }];
      const changedMapped = [mappedMessages[0]!, mappedMessages[1]!, changedResult];
      expect(strictPrompt.split(sourceResult.content)).toHaveLength(2);
      await captureLfm230Input({
        replay, messages: changedPublic, tools: [tool], expectedMessages: changedMapped,
        expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools: strictTools },
        expectedPrompt: strictPrompt.replace(sourceResult.content, changedResult.content),
      });
      // The original template renders tool content, not association IDs. The
      // raw tokenizer argument check above separately protects the supplied ID.
      expect(tokenizer.apply_chat_template([mappedMessages[0]!, mappedMessages[1]!, { role: 'tool', content: sourceResult.content }], {
        tokenize: false, add_generation_prompt: true, tools: strictTools,
      })).toBe(strictPrompt);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await replay.close();
    }
  }, 30_000);
});
