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
import { originalBundledJinjaTemplate } from '../../../../../build/transformers-js-fixes/jinja-template-fixture';
import inputJson from './provider-template-inputs.evidence.json';
import { readModelFixture } from '@/features/transformers-js/replay-models/support/model-runtime-fixture';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';

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
  parameters: {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
    additionalProperties: false
  },
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

// Model-local shared ownership and input-boundary checks. Scenario-specific
// prompts, mappings and native controls remain at their independent call sites.
async function createLfm230InputReplay() {
  const seen: {
    count: number;
    inference: {
      tokenizer: Parameters<ProviderReplayGenerate>[0]['tokenizer'];
      runtime: Parameters<ProviderReplayGenerate>[0]['runtime'];
      input: { type: string; location: string; dims: number[]; data: number[] } | undefined;
      mask: { type: string; location: string; dims: number[]; data: bigint[] } | undefined;
      past: unknown;
    } | undefined;
  } = { count: 0, inference: undefined };
  const harness = await createProviderReplayTestRuntime({
    modelId: MODEL_ID,
    expectedRevision: REVISION,
    cacheRevision: REVISION,
    metadataCache: "all-fixture",
    imagePlatform: undefined,
    artifacts: ['onnx/model_q4.onnx', 'onnx/model_q4.onnx_data'].map(path => ({
      path, bytes: createSyntheticModelBody({ modelId: MODEL_ID, revision: REVISION, path }),
    })),
    generate: async ({ options, tokenizer, runtime }) => {
      const input = options.input_ids;
      const mask = options.attention_mask;
      seen.count++;
      seen.inference = {
        tokenizer, runtime,
        input: input instanceof runtime.Tensor ? {
          type: input.type, location: input.location, dims: [...input.dims], data: Array.from(input.data, Number),
        } : undefined,
        mask: mask instanceof runtime.Tensor ? {
          type: mask.type, location: mask.location, dims: [...mask.dims], data: Array.from(mask.data, BigInt),
        } : undefined,
        past: options.past_key_values,
      };
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

function verifyLfm230NativeInput({ replay, expectedMessages, expectedTemplateOptions, expectedPrompt, priorCalls, priorInferences }: {
 replay: Awaited<ReturnType<typeof createLfm230InputReplay>>,
 expectedMessages: unknown,
 expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools?: typeof strictTools },
 expectedPrompt: string, priorCalls: number, priorInferences: number,
}) {
  expect(replay.harness.observations.inferenceCalls).toHaveLength(priorInferences + 1);
  expect(replay.seen.count).toBe(priorInferences + 1);
  // Protocol probes render without tokenizing; observe actual input preparation
  // before invoking the separate current-native oracle below.
  const calls = replay.templateSpy.mock.calls.slice(priorCalls).filter(([, options]) => options?.tokenize !== false);
  expect(calls).toHaveLength(1);
  const call = calls[0];
  if (!call || !replay.seen.inference) throw new Error('Expected actual LFM230 tokenizer and inference entry');
  expect(semanticMessages({ messages: call[0] })).toStrictEqual(semanticMessages({ messages: expectedMessages }));
  expect(call[1]).toStrictEqual(expectedTemplateOptions);
  const { tokenizer, runtime, input, mask, past } = replay.seen.inference;
  expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex')).toBe(inputEvidence.cases[0].selectedTemplateSha256);
  const currentNative = tokenizer(expectedPrompt, { add_special_tokens: false });
  expect(currentNative.input_ids).toBeInstanceOf(runtime.Tensor);
  const ids = Array.from(currentNative.input_ids.data, Number);
  if (!input || !mask) throw new Error('Expected actual input tensors');
  expect(input.type).toBe('int64');
  expect(input.location).toBe('cpu');
  expect(input.dims).toEqual([1, ids.length]);
  expect(input.data).toEqual(ids);
  expect(mask.type).toBe('int64');
  expect(mask.location).toBe('cpu');
  expect(mask.dims).toEqual([1, ids.length]);
  expect(mask.data).toEqual(ids.map(() => 1n));
  expect(past).toBeNull();
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

describe('LFM2.5 230M Provider / basic', () => {
  it("user-generation reaches actual inference with the independently specified current prompt", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases[0];
    const expectedPrompt = `\
<|startoftext|><|im_start|>user
Template probe user message.<|im_end|>
<|im_start|>assistant
`;
    const replay = await createLfm230InputReplay();
    try {
      const firstInputPriorCalls = replay.templateSpy.mock.calls.length;
      const firstInputPriorInferences = replay.harness.observations.inferenceCalls.length;
      const firstInputCapture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: 'LiquidAI/LFM2.5-230M-ONNX',
          messages: [{ role: "user", content: "Template probe user message." }],
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
          signal: new AbortController().signal,
        },
      });
      captures.push(firstInputCapture);
      await expect(firstInputCapture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks: firstInputChunks, toolCalls: firstInputToolCalls, toolResults: firstInputToolResults } = firstInputCapture.snapshot();
      expect(firstInputCapture.snapshot().responses).toEqual([[]]);
      expect(firstInputCapture.snapshot().preStartChunks).toEqual([]);
      expect(firstInputCapture.snapshot().toolEvents).toEqual([]);
      expect(firstInputChunks).toEqual([]);
      expect(firstInputToolCalls).toEqual([]);
      expect(firstInputToolResults).toEqual([]);
      const tokenizer = verifyLfm230NativeInput({ replay, expectedMessages: scenario.messages, expectedTemplateOptions: { add_generation_prompt: true, return_dict: true }, expectedPrompt: expectedPrompt, priorCalls: firstInputPriorCalls, priorInferences: firstInputPriorInferences });
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

      const changedInputPriorCalls = replay.templateSpy.mock.calls.length;
      const changedInputPriorInferences = replay.harness.observations.inferenceCalls.length;
      const changedInputCapture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: 'LiquidAI/LFM2.5-230M-ONNX',
          messages: changed,
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
          signal: new AbortController().signal,
        },
      });
      captures.push(changedInputCapture);
      await expect(changedInputCapture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks: changedInputChunks, toolCalls: changedInputToolCalls, toolResults: changedInputToolResults } = changedInputCapture.snapshot();
      expect(changedInputCapture.snapshot().responses).toEqual([[]]);
      expect(changedInputCapture.snapshot().preStartChunks).toEqual([]);
      expect(changedInputCapture.snapshot().toolEvents).toEqual([]);
      expect(changedInputChunks).toEqual([]);
      expect(changedInputToolCalls).toEqual([]);
      expect(changedInputToolResults).toEqual([]);
      verifyLfm230NativeInput({ replay, expectedMessages: changed, expectedTemplateOptions: { add_generation_prompt: true, return_dict: true }, expectedPrompt: changedPrompt, priorCalls: changedInputPriorCalls, priorInferences: changedInputPriorInferences });
      expect(tokenizer.apply_chat_template(changed, { tokenize: false, add_generation_prompt: true })).toBe(changedPrompt);
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it("system-user-generation reaches actual inference with the independently specified current prompt", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases[1];
    const expectedPrompt = `\
<|startoftext|><|im_start|>system
Template probe system instruction.<|im_end|>
<|im_start|>user
Template probe user message.<|im_end|>
<|im_start|>assistant
`;
    const replay = await createLfm230InputReplay();
    try {
      const firstInputPriorCalls = replay.templateSpy.mock.calls.length;
      const firstInputPriorInferences = replay.harness.observations.inferenceCalls.length;
      const firstInputCapture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: 'LiquidAI/LFM2.5-230M-ONNX',
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
          signal: new AbortController().signal,
        },
      });
      captures.push(firstInputCapture);
      await expect(firstInputCapture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks: firstInputChunks, toolCalls: firstInputToolCalls, toolResults: firstInputToolResults } = firstInputCapture.snapshot();
      expect(firstInputCapture.snapshot().responses).toEqual([[]]);
      expect(firstInputCapture.snapshot().preStartChunks).toEqual([]);
      expect(firstInputCapture.snapshot().toolEvents).toEqual([]);
      expect(firstInputChunks).toEqual([]);
      expect(firstInputToolCalls).toEqual([]);
      expect(firstInputToolResults).toEqual([]);
      const tokenizer = verifyLfm230NativeInput({ replay, expectedMessages: scenario.messages, expectedTemplateOptions: { add_generation_prompt: true, return_dict: true }, expectedPrompt: expectedPrompt, priorCalls: firstInputPriorCalls, priorInferences: firstInputPriorInferences });
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

      const changedInputPriorCalls = replay.templateSpy.mock.calls.length;
      const changedInputPriorInferences = replay.harness.observations.inferenceCalls.length;
      const changedInputCapture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: 'LiquidAI/LFM2.5-230M-ONNX',
          messages: changed,
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
          signal: new AbortController().signal,
        },
      });
      captures.push(changedInputCapture);
      await expect(changedInputCapture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks: changedInputChunks, toolCalls: changedInputToolCalls, toolResults: changedInputToolResults } = changedInputCapture.snapshot();
      expect(changedInputCapture.snapshot().responses).toEqual([[]]);
      expect(changedInputCapture.snapshot().preStartChunks).toEqual([]);
      expect(changedInputCapture.snapshot().toolEvents).toEqual([]);
      expect(changedInputChunks).toEqual([]);
      expect(changedInputToolCalls).toEqual([]);
      expect(changedInputToolResults).toEqual([]);
      verifyLfm230NativeInput({ replay, expectedMessages: changed, expectedTemplateOptions: { add_generation_prompt: true, return_dict: true }, expectedPrompt: changedPrompt, priorCalls: changedInputPriorCalls, priorInferences: changedInputPriorInferences });
      expect(tokenizer.apply_chat_template(changed, { tokenize: false, add_generation_prompt: true })).toBe(changedPrompt);
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it("multi-turn-generation reaches actual inference with the independently specified current prompt", async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases[2];
    const expectedPrompt = `\
<|startoftext|><|im_start|>user
Template probe first user message.<|im_end|>
<|im_start|>assistant
Template probe assistant response.<|im_end|>
<|im_start|>user
Template probe second user message.<|im_end|>
<|im_start|>assistant
`;
    const replay = await createLfm230InputReplay();
    try {
      const firstInputPriorCalls = replay.templateSpy.mock.calls.length;
      const firstInputPriorInferences = replay.harness.observations.inferenceCalls.length;
      const firstInputCapture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: 'LiquidAI/LFM2.5-230M-ONNX',
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
          signal: new AbortController().signal,
        },
      });
      captures.push(firstInputCapture);
      await expect(firstInputCapture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks: firstInputChunks, toolCalls: firstInputToolCalls, toolResults: firstInputToolResults } = firstInputCapture.snapshot();
      expect(firstInputCapture.snapshot().responses).toEqual([[]]);
      expect(firstInputCapture.snapshot().preStartChunks).toEqual([]);
      expect(firstInputCapture.snapshot().toolEvents).toEqual([]);
      expect(firstInputChunks).toEqual([]);
      expect(firstInputToolCalls).toEqual([]);
      expect(firstInputToolResults).toEqual([]);
      const tokenizer = verifyLfm230NativeInput({ replay, expectedMessages: scenario.messages, expectedTemplateOptions: { add_generation_prompt: true, return_dict: true }, expectedPrompt: expectedPrompt, priorCalls: firstInputPriorCalls, priorInferences: firstInputPriorInferences });
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

      const changedInputPriorCalls = replay.templateSpy.mock.calls.length;
      const changedInputPriorInferences = replay.harness.observations.inferenceCalls.length;
      const changedInputCapture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: 'LiquidAI/LFM2.5-230M-ONNX',
          messages: changed,
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
          signal: new AbortController().signal,
        },
      });
      captures.push(changedInputCapture);
      await expect(changedInputCapture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks: changedInputChunks, toolCalls: changedInputToolCalls, toolResults: changedInputToolResults } = changedInputCapture.snapshot();
      expect(changedInputCapture.snapshot().responses).toEqual([[]]);
      expect(changedInputCapture.snapshot().preStartChunks).toEqual([]);
      expect(changedInputCapture.snapshot().toolEvents).toEqual([]);
      expect(changedInputChunks).toEqual([]);
      expect(changedInputToolCalls).toEqual([]);
      expect(changedInputToolResults).toEqual([]);
      verifyLfm230NativeInput({ replay, expectedMessages: changed, expectedTemplateOptions: { add_generation_prompt: true, return_dict: true }, expectedPrompt: changedPrompt, priorCalls: changedInputPriorCalls, priorInferences: changedInputPriorInferences });
      expect(tokenizer.apply_chat_template(changed, { tokenize: false, add_generation_prompt: true })).toBe(changedPrompt);
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('basic: delivers the recorded first-turn callbacks before settlement', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn"],
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["I'm sorry, but I can't help with that."]);
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

describe('LFM2.5 230M Provider / system', () => {
  it('system: preserves instructions and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["system-user"],
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["Here"]);
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

describe('LFM2.5 230M Provider / history', () => {
  it('keeps the pre-fix parser failure isolated from the actual fixed Production history path', async () => {
    const captures: ProviderChatCapture[] = [];
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
    const observedInputs: Array<{
      tokenizer: Parameters<ProviderReplayGenerate>[0]['tokenizer'];
      input: { data: number[]; dims: number[] } | undefined;
      mask: number[] | undefined;
      past: unknown;
    }> = [];
    const generate = vi.fn<ProviderReplayGenerate>(async ({ options, tokenizer, runtime }) => {
      const input = options.input_ids;
      const mask = options.attention_mask;
      observedInputs.push({
        tokenizer,
        input: input instanceof runtime.Tensor ? { data: Array.from(input.data, Number), dims: [...input.dims] } : undefined,
        mask: mask instanceof runtime.Tensor ? Array.from(mask.data, Number) : undefined,
        past: options.past_key_values,
      });
      throw new Error(INPUT_BOUNDARY);
    });
    const harness = await createProviderReplayTestRuntime({
      imagePlatform: undefined,
      modelId: MODEL_ID,
      expectedRevision: REVISION,
      cacheRevision: REVISION,
      metadataCache: "all-fixture",
      // This repository does not declare q4f16. Seed only the recorded q4
      // candidate; actual local selection must choose it without downloading.
      artifacts: [
        { path: 'onnx/model_q4.onnx', bytes: Uint8Array.of(1) },
        { path: 'onnx/model_q4.onnx_data', bytes: Uint8Array.of(2) },
      ],
      generate,
    });
    try {
      const capture = captureProviderChat({
        provider: harness.provider,
        request: {
          model: MODEL_ID,
          messages,
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
      await expect(capture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks } = capture.snapshot();
      expect(capture.snapshot().responses).toEqual([[]]);
      expect(capture.snapshot().preStartChunks).toEqual([]);
      expect(capture.snapshot().toolEvents).toEqual([]);
      expect(capture.snapshot().toolCalls).toEqual([]);
      expect(capture.snapshot().toolResults).toEqual([]);
      expect(generate).toHaveBeenCalledOnce();
      expect(observedInputs).toHaveLength(1);
      const observedInput = observedInputs[0]!;
      expect(observedInput.tokenizer.apply_chat_template(messages, { tokenize: false, add_generation_prompt: true }))
        .toBe(expectedPrompt);
      // Encode independently specified text, rather than deriving the oracle
      // from the Production-generated prompt under test.
      const expectedIds = observedInput.tokenizer.encode(expectedPrompt, { add_special_tokens: false });
      expect(observedInput.input?.data).toEqual(expectedIds);
      expect(observedInput.input?.dims).toEqual([1, expectedIds.length]);
      expect(observedInput.mask).toEqual(expectedIds.map(() => 1));
      expect(observedInput.past).toBeNull();
      expect(chunks).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('history: preserves supplied history and delivers the recorded callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["supplied-history"],
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["Template"]);
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

describe('LFM2.5 230M Provider / independent', () => {
  it('independent: keeps a new conversation independent after settled requests in the same runtime', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn","continuity","independent-next-input"],
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["I'm sorry, but I can't help with that."]);
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["I'm sorry for any confusion, but I'm unable to continue the conversation with"]);
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["I"]);
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

describe('LFM2.5 230M Provider / reasoning', () => {
  it('reasoning: preserves the recorded none-effort request and callbacks', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["reasoning-none"],
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["I"]);
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
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["I"]);
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
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["I"]);
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
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["I"]);
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

describe('LFM2.5 230M Provider / tools', () => {
  it('tools-generation preserves public strict tools without attributing current rendering to the failed native capture', async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases[3];
    const replay = await createLfm230InputReplay();
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }));
    const tool: Tool = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    };
    try {
      const strictPrompt = strictToolPrelude + assistantPrefix;

      const firstInputPriorCalls = replay.templateSpy.mock.calls.length;
      const firstInputPriorInferences = replay.harness.observations.inferenceCalls.length;
      const firstInputCapture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: 'LiquidAI/LFM2.5-230M-ONNX',
          messages: scenario.messages,
          tools: [tool],
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
          signal: new AbortController().signal,
        },
      });
      captures.push(firstInputCapture);
      await expect(firstInputCapture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks: firstInputChunks, toolCalls: firstInputToolCalls, toolResults: firstInputToolResults } = firstInputCapture.snapshot();
      expect(firstInputCapture.snapshot().responses).toEqual([[]]);
      expect(firstInputCapture.snapshot().preStartChunks).toEqual([]);
      expect(firstInputCapture.snapshot().toolEvents).toEqual([]);
      expect(firstInputChunks).toEqual([]);
      expect(firstInputToolCalls).toEqual([]);
      expect(firstInputToolResults).toEqual([]);
      const tokenizer = verifyLfm230NativeInput({ replay, expectedMessages: scenario.messages, expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools: strictTools }, expectedPrompt: strictPrompt, priorCalls: firstInputPriorCalls, priorInferences: firstInputPriorInferences });
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

      const changedInputPriorCalls = replay.templateSpy.mock.calls.length;
      const changedInputPriorInferences = replay.harness.observations.inferenceCalls.length;
      const changedInputCapture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: 'LiquidAI/LFM2.5-230M-ONNX',
          messages: scenario.messages,
          tools: [changedTool],
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
          signal: new AbortController().signal,
        },
      });
      captures.push(changedInputCapture);
      await expect(changedInputCapture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks: changedInputChunks, toolCalls: changedInputToolCalls, toolResults: changedInputToolResults } = changedInputCapture.snapshot();
      expect(changedInputCapture.snapshot().responses).toEqual([[]]);
      expect(changedInputCapture.snapshot().preStartChunks).toEqual([]);
      expect(changedInputCapture.snapshot().toolEvents).toEqual([]);
      expect(changedInputChunks).toEqual([]);
      expect(changedInputToolCalls).toEqual([]);
      expect(changedInputToolResults).toEqual([]);
      verifyLfm230NativeInput({ replay, expectedMessages: scenario.messages, expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools: changedDefinitions }, expectedPrompt: changedPrompt, priorCalls: changedInputPriorCalls, priorInferences: changedInputPriorInferences });
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: true, tools: changedDefinitions })).toBe(changedPrompt);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('assistant-tool-call-history separates original false, necessary argument mapping and public true continuation', async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases[4];
    const replay = await createLfm230InputReplay();
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }));
    const tool: Tool = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    };
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

      const firstInputPriorCalls = replay.templateSpy.mock.calls.length;
      const firstInputPriorInferences = replay.harness.observations.inferenceCalls.length;
      const firstInputCapture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: 'LiquidAI/LFM2.5-230M-ONNX',
          messages: publicMessages,
          tools: [tool],
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
          signal: new AbortController().signal,
        },
      });
      captures.push(firstInputCapture);
      await expect(firstInputCapture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks: firstInputChunks, toolCalls: firstInputToolCalls, toolResults: firstInputToolResults } = firstInputCapture.snapshot();
      expect(firstInputCapture.snapshot().responses).toEqual([[]]);
      expect(firstInputCapture.snapshot().preStartChunks).toEqual([]);
      expect(firstInputCapture.snapshot().toolEvents).toEqual([]);
      expect(firstInputChunks).toEqual([]);
      expect(firstInputToolCalls).toEqual([]);
      expect(firstInputToolResults).toEqual([]);
      const tokenizer = verifyLfm230NativeInput({ replay, expectedMessages: mappedMessages, expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools: strictTools }, expectedPrompt: currentPublicPrompt, priorCalls: firstInputPriorCalls, priorInferences: firstInputPriorInferences });
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

      const changedInputPriorCalls = replay.templateSpy.mock.calls.length;
      const changedInputPriorInferences = replay.harness.observations.inferenceCalls.length;
      const changedInputCapture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: 'LiquidAI/LFM2.5-230M-ONNX',
          messages: changedPublic,
          tools: [tool],
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
          signal: new AbortController().signal,
        },
      });
      captures.push(changedInputCapture);
      await expect(changedInputCapture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks: changedInputChunks, toolCalls: changedInputToolCalls, toolResults: changedInputToolResults } = changedInputCapture.snapshot();
      expect(changedInputCapture.snapshot().responses).toEqual([[]]);
      expect(changedInputCapture.snapshot().preStartChunks).toEqual([]);
      expect(changedInputCapture.snapshot().toolEvents).toEqual([]);
      expect(changedInputChunks).toEqual([]);
      expect(changedInputToolCalls).toEqual([]);
      expect(changedInputToolResults).toEqual([]);
      verifyLfm230NativeInput({ replay, expectedMessages: changedMapped, expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools: strictTools }, expectedPrompt: currentPublicPrompt.replace("city='Tokyo'", "city='Osaka'"), priorCalls: changedInputPriorCalls, priorInferences: changedInputPriorInferences });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('tool-result-continuation retains the mapped call and result through public input without claiming natural tool execution', async () => {
    const captures: ProviderChatCapture[] = [];
    const scenario = inputEvidence.cases[5];
    const replay = await createLfm230InputReplay();
    const execute = vi.fn<Tool['execute']>(async () => ({ status: 'success', content: '{"temperatureC":20,"condition":"clear"}' }));
    const tool: Tool = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    };
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

      const firstInputPriorCalls = replay.templateSpy.mock.calls.length;
      const firstInputPriorInferences = replay.harness.observations.inferenceCalls.length;
      const firstInputCapture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: 'LiquidAI/LFM2.5-230M-ONNX',
          messages: publicMessages,
          tools: [tool],
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
          signal: new AbortController().signal,
        },
      });
      captures.push(firstInputCapture);
      await expect(firstInputCapture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks: firstInputChunks, toolCalls: firstInputToolCalls, toolResults: firstInputToolResults } = firstInputCapture.snapshot();
      expect(firstInputCapture.snapshot().responses).toEqual([[]]);
      expect(firstInputCapture.snapshot().preStartChunks).toEqual([]);
      expect(firstInputCapture.snapshot().toolEvents).toEqual([]);
      expect(firstInputChunks).toEqual([]);
      expect(firstInputToolCalls).toEqual([]);
      expect(firstInputToolResults).toEqual([]);
      const tokenizer = verifyLfm230NativeInput({ replay, expectedMessages: mappedMessages, expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools: strictTools }, expectedPrompt: strictPrompt, priorCalls: firstInputPriorCalls, priorInferences: firstInputPriorInferences });
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

      const changedInputPriorCalls = replay.templateSpy.mock.calls.length;
      const changedInputPriorInferences = replay.harness.observations.inferenceCalls.length;
      const changedInputCapture = captureProviderChat({
        provider: replay.harness.provider,
        request: {
          model: 'LiquidAI/LFM2.5-230M-ONNX',
          messages: changedPublic,
          tools: [tool],
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
          signal: new AbortController().signal,
        },
      });
      captures.push(changedInputCapture);
      await expect(changedInputCapture.completion).rejects.toThrow(INPUT_BOUNDARY);
      const { chunks: changedInputChunks, toolCalls: changedInputToolCalls, toolResults: changedInputToolResults } = changedInputCapture.snapshot();
      expect(changedInputCapture.snapshot().responses).toEqual([[]]);
      expect(changedInputCapture.snapshot().preStartChunks).toEqual([]);
      expect(changedInputCapture.snapshot().toolEvents).toEqual([]);
      expect(changedInputChunks).toEqual([]);
      expect(changedInputToolCalls).toEqual([]);
      expect(changedInputToolResults).toEqual([]);
      verifyLfm230NativeInput({ replay, expectedMessages: changedMapped, expectedTemplateOptions: { add_generation_prompt: true, return_dict: true, tools: strictTools }, expectedPrompt: strictPrompt.replace(sourceResult.content, changedResult.content), priorCalls: changedInputPriorCalls, priorInferences: changedInputPriorInferences });
      // The original template renders tool content, not association IDs. The
      // raw tokenizer argument check above separately protects the supplied ID.
      expect(tokenizer.apply_chat_template([mappedMessages[0]!, mappedMessages[1]!, { role: 'tool', content: sourceResult.content }], {
        tokenize: false, add_generation_prompt: true, tools: strictTools,
      })).toBe(strictPrompt);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await replay.close();
    }
    expect(captures.flatMap(capture => capture.snapshot().lateEvents)).toEqual([]);
  }, 30_000);
  it('tools: executes the recorded minimal Tokyo call once and continues with its result', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["natural-tool-minimal"],
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["I'll retrieve the weather data for Tokyo using the available tool.", "The current weather in Tokyo is 20°C with clear conditions."]);
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
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["", "The weather in Tokyo today is clear with a temperature of 20°C."]);
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
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["The current weather in Tokyo is 20°C with clear conditions."]);
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

describe('LFM2.5 230M Provider / images', () => {
  it('images: preserves the recorded text-only native handling of an image-bearing request', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["image"],
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["I"]);
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

describe('LFM2.5 230M Provider / sequences', () => {
  it('sequences: builds continuation from actually delivered first-request settlement', async () => {
    const replay = await createProviderRequestReplay({
      catalog: providerReplayCatalog,
      caseIds: ["first-turn","continuity"],
      artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"],
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["I'm sorry, but I can't help with that."]);
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
            model: "LiquidAI/LFM2.5-230M-ONNX",
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

        expect(responses.map(chunks => chunks.join(''))).toEqual(["I'm sorry for any confusion, but I'm unable to continue the conversation with"]);
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
    expect(fullEvidenceJson.modelId).toBe('LiquidAI/LFM2.5-230M-ONNX');
    expect(fullEvidenceJson.metadataRevision).toBe('c6f46e4e3f885ebcad164d14059a49f90e27eb4d');
    expect(fullEvidenceJson.observedCacheRevision).toBe('c6f46e4e3f885ebcad164d14059a49f90e27eb4d');
    await verifyCapturedFullReplay({ reviewedPublicContract: undefined, unavailableOutputs: [], completeResult: undefined, expectedLoadReceipt: undefined, evidence: fullEvidenceJson, imagePlatform: undefined, artifactPaths: ["onnx/model_q4.onnx","onnx/model_q4.onnx_data"] });
  }, 30_000);
});
