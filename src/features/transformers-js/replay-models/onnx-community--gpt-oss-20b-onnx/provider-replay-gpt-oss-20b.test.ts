// @vitest-environment node
import { providerReplayCatalog } from './provider-evidence-catalog';
import { assembleProviderSequenceEvidence } from '@/features/transformers-js/replay-models/support/provider-replay-evidence';
import { verifyProviderRequests } from '@/features/transformers-js/replay-models/support/provider-replay-request';
import { parseCapturedFullReplay, replayCapturedFullInvocation, verifyCapturedFullReplay } from '@/features/transformers-js/replay-models/support/provider-replay-test-captured-full';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatMessage } from '@/01-models/types';
import type { Tool } from '@/01-models/tool';
import { toToolCallId } from '@/01-models/ids';
import evidenceJson from './provider-prefix-output.evidence.json';
import inputJson from './provider-template-inputs.evidence.json';
import toolInputJson from './provider-template-tool-inputs.evidence.json';
import { parseProviderReplayTextEvidence, replayRecordedText } from '@/features/transformers-js/replay-models/support/provider-replay-test-causal-gate';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from '@/features/transformers-js/replay-models/support/provider-replay-test-runtime';
import { createSyntheticModelBody, inspectSyntheticOrtSession } from '@/features/transformers-js/replay-models/support/download-synthetic-session-oracle';

const evidence = parseProviderReplayTextEvidence({ value: evidenceJson });
const inputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('9f571fe9df62978ab255cb7d50a2ea9ca1a2214058318a92ba1c267b321b95b4'),
  modelId: z.literal('onnx-community/gpt-oss-20b-ONNX'),
  revision: z.literal('6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7'),
  selectedTemplateSha256: z.literal('f8d9255777615591a7cc1a7c932f5a69e181128902295e1b81221d20d983cac7'),
  templateClockDate: z.literal('2026-09-05'),
  cases: z.array(z.object({
    caseId: z.enum(['user-generation', 'system-user-generation', 'multi-turn-generation']),
    messages: z.array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict()),
    addGenerationPrompt: z.literal(true), renderedText: z.string(),
    inputTokenIds: z.array(z.number().int().nonnegative()).min(1),
  }).strict()).length(3),
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
const toolCaseSchema = z.object({
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
  inputTokenIds: z.array(z.number().int().nonnegative().safe()).min(1),
}).strict();
const toolInputEvidence = z.object({
  schemaVersion: z.literal(1), source: z.literal('reference-template-behavior-matrix'),
  sourceMemberSha256: z.literal('9f571fe9df62978ab255cb7d50a2ea9ca1a2214058318a92ba1c267b321b95b4'),
  modelId: z.literal('onnx-community/gpt-oss-20b-ONNX'),
  revision: z.literal('6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7'),
  selectedTemplateSha256: z.literal('f8d9255777615591a7cc1a7c932f5a69e181128902295e1b81221d20d983cac7'),
  templateClockDate: z.literal('2026-09-05'),
  cases: z.tuple([
    toolCaseSchema.extend({ caseId: z.literal('tools-generation'), messages: z.tuple([toolUserSchema]) }),
    toolCaseSchema.extend({ caseId: z.literal('tool-result-continuation'), messages: z.tuple([toolUserSchema, toolAssistantSchema, toolResultSchema]) }),
  ]),
}).strict().parse(toolInputJson);

beforeEach(() => {
  // The captured template includes 2026-09-05. Freeze only Date, not RPC or
  // timers. Exact token equality below verifies an equivalent template clock;
  // this is not a claim that the capture recorded its original timezone.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-05T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

async function createGptOssReplay() {
  expect(evidence.identity).toEqual({
    modelId: 'hf.co/onnx-community/gpt-oss-20b-ONNX',
    resolvedRevision: '6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7',
    investigationRunId: 'fcc765db-1f6f-4be5-b25d-cecb650bdebe',
    transformersJsVersion: '4.2.0',
  });
  let releasedTokenCount = 0;
  const harness = await createProviderReplayTestRuntime({
    imagePlatform: undefined,
    modelId: 'onnx-community/gpt-oss-20b-ONNX', expectedRevision: evidence.identity.resolvedRevision, cacheRevision: evidence.identity.resolvedRevision, metadataCache: "all-fixture",
    // Model-specific repository paths, with tiny native-inference substitutes.
    // Real tokenizer/config, cache selection and all Worker loading remain active.
    artifacts: [
      'onnx/model_q4f16.onnx',
      'onnx/model_q4f16.onnx_data',
      'onnx/model_q4f16.onnx_data_1',
      'onnx/model_q4f16.onnx_data_2',
      'onnx/model_q4f16.onnx_data_3',
      'onnx/model_q4f16.onnx_data_4',
      'onnx/model_q4f16.onnx_data_5',
      'onnx/model_q4f16.onnx_data_6',
    ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: 'onnx-community/gpt-oss-20b-ONNX', revision: evidence.identity.resolvedRevision, path }) })),
    generate: async ({ options, tokenizer, runtime }) => {
      expect(tokenizer.decode(evidence.modelReplay.generatedTokenIds, { skip_special_tokens: false }))
        .toBe(evidence.modelReplay.generatedText);
      const replay = replayRecordedText({ evidence, options });
      releasedTokenCount += replay.releasedTokenCount;
      return { sequences: new runtime.Tensor('int64', BigInt64Array.from(replay.sequenceTokenIds), [1, replay.sequenceTokenIds.length]), past_key_values: null };
    },
  });
  return { harness, releasedTokenCount: () => releasedTokenCount };
}

describe('GPT-OSS 20B Provider / basic', () => {
  it.each(inputEvidence.cases)('$caseId preserves the exact captured native input through Provider.chat', async scenario => {
    const boundary = 'GPT-OSS actual input verified; generation not replayed';
    let verifiedInputs = 0;
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      artifacts: [
        'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data',
        'onnx/model_q4f16.onnx_data_1', 'onnx/model_q4f16.onnx_data_2',
        'onnx/model_q4f16.onnx_data_3', 'onnx/model_q4f16.onnx_data_4',
        'onnx/model_q4f16.onnx_data_5', 'onnx/model_q4f16.onnx_data_6',
      ].map(path => ({ path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }) })),
      generate: async ({ options, tokenizer, runtime }) => {
        expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'))
          .toBe(inputEvidence.selectedTemplateSha256);
        expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: true }))
          .toBe(scenario.renderedText);
        if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) {
          throw new Error('Expected actual GPT-OSS input tensors');
        }
        expect(options.input_ids.type).toBe('int64');
        expect(options.input_ids.dims).toEqual([1, scenario.inputTokenIds.length]);
        expect(Array.from(options.input_ids.data, Number)).toEqual(scenario.inputTokenIds);
        expect(options.attention_mask.data).toEqual(new BigInt64Array(scenario.inputTokenIds.length).fill(1n));
        expect(options.past_key_values).toBeNull();
        ++verifiedInputs;
        // The assistant history is a captured synthetic template probe, not
        // a claim that a prior Provider turn or native reasoning completed.
        throw new Error(boundary);
      },
    });
    try {
      const chunks: string[] = [];
      await expect(harness.provider.chat({
        model: inputEvidence.modelId, messages: scenario.messages, tools: [],
        parameters: {
          temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined,
          frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined },
        },
        onChunk: ({ chunk }) => chunks.push(chunk),
      })).rejects.toThrow(boundary);
      expect(verifiedInputs).toBe(1);
      expect(chunks).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(1);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
  it('refuses the recorded answer when the public caller changes the input', async () => {
    const replay = await createGptOssReplay();
    try {
      const chunks: string[] = [];
      await expect(replay.harness.provider.chat({
        model: evidence.identity.modelId,
        messages: [{ role: 'user', content: 'Different synthetic replay input.' }], tools: [],
        parameters: {
          ...evidence.scenario.lmParameters, presencePenalty: undefined, frequencyPenalty: undefined,
          stop: undefined, reasoning: { effort: undefined },
        },
        onChunk: ({ chunk }) => {
          chunks.push(chunk);
        },
      })).rejects.toThrow('Replay causal mismatch: actual source input');
      expect(replay.releasedTokenCount()).toBe(0);
      expect(chunks).toEqual([]);
      expect(replay.harness.observations.inferenceCalls).toHaveLength(1);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
    } finally {
      await replay.harness.close();
    }
  }, 30_000);
  it('basic: delivers the recorded first-turn callbacks before settlement', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["first-turn"], artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"], imagePlatform: undefined });
  }, 30_000);
});

describe('GPT-OSS 20B Provider / system', () => {
  it('system: preserves instructions and delivers the recorded callbacks', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["system-user"], artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"], imagePlatform: undefined });
  }, 30_000);
});

describe('GPT-OSS 20B Provider / history', () => {
  it('renders recorded assistant history with absent tool_calls but rejects the own undefined property added by the adapter', async () => {
    const scenario = inputEvidence.cases.find(candidate => candidate.caseId === 'multi-turn-generation');
    if (!scenario) throw new Error('Missing captured GPT-OSS history input');
    const replay = await createGptOssReplay();
    try {
      await replay.harness.service.loadDownloadedModel({ modelId: inputEvidence.modelId });
      const tokenizer = await replay.harness.runtime.AutoTokenizer.from_pretrained(inputEvidence.modelId, {
        revision: inputEvidence.revision, local_files_only: true,
      });
      expect(createHash('sha256').update(tokenizer.get_chat_template()).digest('hex'))
        .toBe(inputEvidence.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, { tokenize: false, add_generation_prompt: true }))
        .toBe(scenario.renderedText);
      const cleanInput = tokenizer.apply_chat_template(scenario.messages, { add_generation_prompt: true, return_dict: true });
      expect(cleanInput.input_ids).toBeInstanceOf(replay.harness.runtime.Tensor);
      expect(Array.from(cleanInput.input_ids.data, Number)).toEqual(scenario.inputTokenIds);

      // buildGptOssPromptMessages adds own tool_calls:undefined even when the
      // public message has no tools. The template uses membership, not truthiness:
      // the assistant enters message.tool_calls[0] instead of ordinary history.
      // Keep this isolated comparison alongside the public contract RED below;
      // never remove the real adapter's property in the replay harness.
      const withUndefinedToolCalls = scenario.messages.map(message => ({ ...message, tool_calls: undefined }));
      expect(Object.hasOwn(withUndefinedToolCalls[1]!, 'tool_calls')).toBe(true);
      expect(() => tokenizer.apply_chat_template(withUndefinedToolCalls, { tokenize: false, add_generation_prompt: true }))
        .toThrow('Cannot access property with non-string: got IntegerValue');
      expect(replay.releasedTokenCount()).toBe(0);
      expect(replay.harness.observations.inferenceCalls).toEqual([]);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
      expect(replay.harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await replay.harness.close();
    }
  }, 30_000);
  it('history: preserves supplied history and delivers the recorded callbacks', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["supplied-history"], artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"], imagePlatform: undefined });
  }, 30_000);
});

describe('GPT-OSS 20B Provider / independent', () => {
  it('keeps an independent next input free of prior analysis in the same null-KV loaded runtime', async () => {
    const firstInput = inputEvidence.cases.find(item => item.caseId === 'user-generation');
    if (!firstInput) throw new Error('Missing captured GPT-OSS user input');
    expect(firstInput.messages).toEqual([{ role: 'user', content: 'Template probe user message.' }]);
    expect(firstInput.renderedText.split('Template probe user message.')).toHaveLength(2);
    const nextMessages: ChatMessage[] = [{ role: 'user', content: 'A separate synthetic conversation.' }];
    // The fixed captured system/date scaffold is preserved; only this one user
    // literal changes. This is an independently specified input, not new output evidence.
    const nextPrompt = firstInput.renderedText.replace('Template probe user message.', 'A separate synthetic conversation.');
    const stop = 'Independent GPT-OSS next input verified; no second output supplied';
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
        if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) throw new Error('Expected actual GPT-OSS next-input tensors');
        expect(options.input_ids.type).toBe('int64');
        expect(options.input_ids.location).toBe('cpu');
        expect(options.input_ids.dims).toEqual([1, ids.length]);
        expect(Array.from(options.input_ids.data, Number)).toEqual(ids);
        expect(options.attention_mask.type).toBe('int64');
        expect(options.attention_mask.location).toBe('cpu');
        expect(options.attention_mask.dims).toEqual([1, ids.length]);
        expect(Array.from(options.attention_mask.data, BigInt)).toEqual(ids.map(() => 1n));
        expect(options.past_key_values).toBeNull();
        expect(options.max_new_tokens).toBe(1);
        expect(options.temperature).toBe(0);
        expect(options.top_p).toBe(1);
        expect(options.do_sample).toBe(false);
        // No captured answer belongs to this changed input. A null native cache
        // cannot establish that real GPU KV reuse/invalidation works correctly.
        throw new Error(stop);
      },
    ];
    const externalPaths = [
      'model_q4f16.onnx_data', 'model_q4f16.onnx_data_1', 'model_q4f16.onnx_data_2',
      'model_q4f16.onnx_data_3', 'model_q4f16.onnx_data_4', 'model_q4f16.onnx_data_5', 'model_q4f16.onnx_data_6',
    ];
    const harness = await createProviderReplayTestRuntime({
      modelId: inputEvidence.modelId, expectedRevision: inputEvidence.revision, cacheRevision: inputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      artifacts: ['onnx/model_q4f16.onnx', ...externalPaths.map(path => `onnx/${path}`)].map(path => ({
        path, bytes: createSyntheticModelBody({ modelId: inputEvidence.modelId, revision: inputEvidence.revision, path }),
      })),
      generate: async context => {
        const next = invocations.shift();
        if (!next) throw new Error('Unexpected extra inference in independent GPT-OSS input replay');
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
      expect(contexts.map(({ options }) => options.past_key_values)).toEqual([null, null]);
      expect(invocations).toEqual([]);
      expect(harness.observations.inferenceCalls).toHaveLength(2);
      expect(ortCountAfterFirst).toBe(1);
      expect(harness.observations.ortCalls).toHaveLength(ortCountAfterFirst);
      expect(harness.observations.workers).toHaveLength(1);
      expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
      expect(harness.observations.localImageFetchCalls).toEqual([]);
      expect(harness.observations.forbiddenTransport).toEqual([]);
      expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
    } finally {
      await harness.close();
    }
  }, 30_000);
  it('independent: keeps a new conversation independent after settled requests in the same runtime', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["first-turn","continuity","independent-next-input"], artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"], imagePlatform: undefined });
  }, 30_000);
});

describe('GPT-OSS 20B Provider / reasoning', () => {
  it('delivers the captured analysis prefix as thinking before Provider settlement', async () => {
    const replay = await createGptOssReplay();
    try {
      const chunks: string[] = [];
      const toolCalls: unknown[] = [];
      const toolEvents: unknown[] = [];
      const toolResults: unknown[] = [];
      let assistantStarts = 0;
      await replay.harness.provider.chat({
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
      const settled = { assistantStarts, text: chunks.join(''), toolCalls: [...toolCalls], toolEvents: [...toolEvents], toolResults: [...toolResults] };
      expect(replay.releasedTokenCount()).toBe(16);
      expect(replay.harness.observations.inferenceCalls).toHaveLength(1);
      expect(replay.harness.observations.runtimeAssetFetchCalls).toEqual([replay.harness.observations.expectedRuntimeAssetUrl]);
      expect(replay.harness.observations.forbiddenTransport).toEqual([]);
      // The ORT boundary is replaced, so independently verify what reached it.
      // Identifiable bodies detect a wrong core/revision or swapped data shard.
      const expectedExternalPaths = [
        'model_q4f16.onnx_data', 'model_q4f16.onnx_data_1', 'model_q4f16.onnx_data_2',
        'model_q4f16.onnx_data_3', 'model_q4f16.onnx_data_4', 'model_q4f16.onnx_data_5', 'model_q4f16.onnx_data_6',
      ];
      expect(replay.harness.observations.ortCalls.map(([core, options]) => inspectSyntheticOrtSession({
        modelId: 'onnx-community/gpt-oss-20b-ONNX', revision: evidence.identity.resolvedRevision,
        repositoryPaths: new Set(['onnx/model_q4f16.onnx', ...expectedExternalPaths.map(path => `onnx/${path}`)]),
        core, options,
      }))).toEqual([{
        modelId: 'onnx-community/gpt-oss-20b-ONNX', revision: evidence.identity.resolvedRevision,
        corePath: 'onnx/model_q4f16.onnx', executionProviders: ['webgpu'],
        externalData: expectedExternalPaths.map(path => ({ path, artifactPath: `onnx/${path}` })),
      }]);
      expect(replay.harness.observations.fs.activity.filter(item => item.operation.startsWith('writer') || item.operation.startsWith('create') || item.operation === 'remove')).toEqual([]);
      // A truncated analysis prefix is not a completed answer. Do not append a
      // fabricated </think> or wait for late callbacks to make this assertion pass.
      expect(settled).toEqual({
        assistantStarts: 1,
        text: '<think>The user says "Template probe user message." This seems like a',
        toolCalls: [], toolEvents: [], toolResults: [],
      });
    } finally {
      await replay.harness.close();
    }
  }, 30_000);
  it('reasoning: preserves the recorded none-effort request and callbacks', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["reasoning-none"], artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"], imagePlatform: undefined });
  }, 30_000);
  it('reasoning: preserves the recorded low-effort request and callbacks', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["reasoning-low"], artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"], imagePlatform: undefined });
  }, 30_000);
  it('reasoning: preserves the recorded medium-effort request and callbacks', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["reasoning-medium"], artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"], imagePlatform: undefined });
  }, 30_000);
  it('reasoning: preserves the recorded high-effort request and callbacks', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["reasoning-high"], artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"], imagePlatform: undefined });
  }, 30_000);
});

describe('GPT-OSS 20B Provider / tools', () => {
  it.each(toolInputEvidence.cases)('$caseId characterizes the current developer-namespace projection without certifying native tool compatibility', async scenario => {
    const boundary = 'GPT-OSS tool input inspected; no generated output supplied';
    const execute = vi.fn<Tool['execute']>(async () => {
      throw new Error('No natural tool invocation was captured for this matrix');
    });
    const publicTool: Tool = {
      name: 'lookup_weather', description: 'Return deterministic weather fixture data.',
      parametersSchema: z.object({ city: z.string() }), execute,
    };
    const messages: ChatMessage[] = scenario.messages.map(message => {
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
        throw new Error(`Unexpected GPT-OSS selected message: ${String(exhaustive)}`);
      }
      }
    });
    // This is the separately specified current Naidan projection, NOT a browser
    // capture or native-default parity claim. GPT-OSS deliberately renders tool
    // definitions as developer instructions rather than passing native tools.
    // Keep the original native tools control below so that difference is visible.
    // This projection also omits the native tool-channel instruction, not just
    // whitespace. Its semantic equivalence is UNPROVEN; this diagnostic must not
    // be counted as a passing natural-tool compatibility regression.
    const developerNamespace = `\
namespace functions {
// Return deterministic weather fixture data.
type lookup_weather = (_: {
  city: string,
}) => any;

} // namespace functions`;
    const userHeader = '<|start|>user<|message|>';
    const noToolsSource = inputEvidence.cases.find(item => item.caseId === 'user-generation');
    if (!noToolsSource) throw new Error('Missing captured native system scaffold');
    expect(noToolsSource.renderedText.split(userHeader)).toHaveLength(2);
    expect(scenario.renderedText.split(userHeader)).toHaveLength(2);
    const expectedRenderedText = noToolsSource.renderedText.split(userHeader)[0]
      + `<|start|>developer<|message|># Instructions\n\n${developerNamespace}<|end|>`
      + userHeader + scenario.renderedText.split(userHeader)[1];
    const nativeChannelInstruction = "Calls to these tools must go to the commentary channel: 'functions'.";
    expect(scenario.renderedText.split(nativeChannelInstruction)).toHaveLength(2);
    expect(expectedRenderedText.split(nativeChannelInstruction)).toHaveLength(1);
    // The source's arguments and result are JSON strings serialized again by
    // native tojson. Preserve that observation, but do not certify that this
    // representation is suitable for a naturally generated tool invocation.
    let actualInput: number[] | undefined;
    const repositoryPaths = [
      'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data',
      'onnx/model_q4f16.onnx_data_1', 'onnx/model_q4f16.onnx_data_2',
      'onnx/model_q4f16.onnx_data_3', 'onnx/model_q4f16.onnx_data_4',
      'onnx/model_q4f16.onnx_data_5', 'onnx/model_q4f16.onnx_data_6',
    ];
    const harness = await createProviderReplayTestRuntime({
      modelId: toolInputEvidence.modelId, expectedRevision: toolInputEvidence.revision, cacheRevision: toolInputEvidence.revision, metadataCache: "all-fixture", imagePlatform: undefined,
      artifacts: repositoryPaths.map(path => ({ path, bytes: createSyntheticModelBody({ modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, path }) })),
      generate: async ({ options, runtime }) => {
        if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor)) {
          throw new Error('Expected actual GPT-OSS tool input tensors');
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
        // Supplied tool history is not a completed natural tool loop or KV reuse.
        throw new Error(boundary);
      },
    });
    try {
      await harness.service.loadDownloadedModel({ modelId: toolInputEvidence.modelId });
      const tokenizer = await harness.runtime.AutoTokenizer.from_pretrained(toolInputEvidence.modelId, {
        revision: toolInputEvidence.revision, local_files_only: true,
      });
      expect(createHash('sha256').update(tokenizer.get_chat_template({ tools: scenario.tools })).digest('hex'))
        .toBe(toolInputEvidence.selectedTemplateSha256);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: scenario.tools,
      })).toBe(scenario.renderedText);
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: true, return_tensor: false, return_dict: false, add_generation_prompt: true, tools: scenario.tools,
      })).toEqual(scenario.inputTokenIds);
      // The template does not render additionalProperties, so this explicit
      // public schema difference is not the source of the namespace difference.
      const strictTools = scenario.tools.map(tool => ({
        ...tool, function: { ...tool.function, parameters: { ...tool.function.parameters, additionalProperties: false } },
      }));
      expect(tokenizer.apply_chat_template(scenario.messages, {
        tokenize: false, add_generation_prompt: true, tools: strictTools,
      })).toBe(scenario.renderedText);
      const expectedIds = tokenizer.encode(expectedRenderedText, { add_special_tokens: false });
      const templateSpy = vi.spyOn(harness.runtime.PreTrainedTokenizer.prototype, 'apply_chat_template');
      try {
        const chunks: string[] = [];
        const onToolCall = vi.fn();
        const onToolResult = vi.fn();
        await expect(harness.provider.chat({
          model: toolInputEvidence.modelId, messages, tools: [publicTool],
          parameters: { temperature: 0, topP: 1, maxCompletionTokens: 1, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: undefined } },
          onChunk: ({ chunk }) => chunks.push(chunk), onToolCall, onToolResult,
        })).rejects.toThrow(boundary);
        const observedMessageSchema = z.object({
          role: z.string(), content: z.string(),
          tool_calls: toolAssistantSchema.shape.tool_calls.optional(),
          tool_call_id: z.literal('call_template_probe_1').optional(),
        }).strict();
        const observedTokenizations = templateSpy.mock.calls
          .filter(([, options]) => options?.tokenize !== false)
          .map(([rawMessages, options]) => [
            z.array(observedMessageSchema).parse(rawMessages).map(message => {
              const { role, content, tool_calls, tool_call_id, ...unhandled } = message;
              unhandled satisfies Record<PropertyKey, never>;
              return { role, content, tool_calls, tool_call_id };
            }), options,
          ]);
        // Compare semantic values after the real call, not property membership.
        // The separate history regression demonstrates why the real adapter's
        // own undefined property must be removable by a subsequent fix. Nothing
        // is normalized on the actual Production/tokenizer execution path.
        expect(observedTokenizations).toStrictEqual([[
          [
            { role: 'developer', content: developerNamespace, tool_calls: undefined, tool_call_id: undefined },
            ...scenario.messages.map(message => ({
              role: message.role, content: message.content,
              tool_calls: 'tool_calls' in message ? message.tool_calls : undefined,
              tool_call_id: 'tool_call_id' in message ? message.tool_call_id : undefined,
            })),
          ],
          { add_generation_prompt: true, return_dict: true },
        ]]);
        expect(actualInput).toEqual(expectedIds);
        expect(chunks).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
        expect(onToolCall).not.toHaveBeenCalled();
        expect(onToolResult).not.toHaveBeenCalled();
        expect(harness.observations.inferenceCalls).toHaveLength(1);
        expect(harness.observations.runtimeAssetFetchCalls).toEqual([harness.observations.expectedRuntimeAssetUrl]);
        expect(harness.observations.localImageFetchCalls).toEqual([]);
        expect(harness.observations.forbiddenTransport).toEqual([]);
        expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
        expect(harness.observations.ortCalls.map(([core, options]) => inspectSyntheticOrtSession({
          modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision,
          repositoryPaths: new Set(repositoryPaths), core, options,
        }))).toEqual([{
          modelId: toolInputEvidence.modelId, revision: toolInputEvidence.revision, corePath: repositoryPaths[0], executionProviders: ['webgpu'],
          externalData: repositoryPaths.slice(1).map(artifactPath => ({ path: artifactPath.slice('onnx/'.length), artifactPath })),
        }]);
      } finally {
        templateSpy.mockRestore();
      }
    } finally {
      await harness.close();
    }
  }, 30_000);
});

describe('GPT-OSS 20B Provider / images', () => {
  it('images: preserves the recorded text-only native handling of an image-bearing request', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["image"], artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"], imagePlatform: undefined });
  }, 30_000);
});

describe('GPT-OSS 20B Provider / sequences', () => {
  it('sequences: builds continuation from actually delivered first-request settlement', async () => {
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    await verifyProviderRequests({ catalog: providerReplayCatalog, caseIds: ["first-turn","continuity"], artifactPaths: ["onnx/model_q4f16.onnx","onnx/model_q4f16.onnx_data","onnx/model_q4f16.onnx_data_1","onnx/model_q4f16.onnx_data_2","onnx/model_q4f16.onnx_data_3","onnx/model_q4f16.onnx_data_4","onnx/model_q4f16.onnx_data_5","onnx/model_q4f16.onnx_data_6"], imagePlatform: undefined });
  }, 30_000);
  it('preserves recorded calls and the independent image request without replaying invalid cached continuations', async () => {
    const fullEvidenceJson = assembleProviderSequenceEvidence({ catalog: providerReplayCatalog });
    vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const recorded = parseCapturedFullReplay({ value: fullEvidenceJson });
    expect(recorded.modelId).toBe('onnx-community/gpt-oss-20b-ONNX');
    expect(recorded.metadataRevision).toBe('6dcc680ae66791268a1e4e96fc3bfd0e5d3662e7');
    expect(recorded.observedCacheRevision).toBe('main');
    const caches = new Map<number, NonNullable<Parameters<ProviderReplayGenerate>[0]['options']['past_key_values']>>();
    await verifyCapturedFullReplay({ evidence: recorded, imagePlatform: undefined, expectedLoadReceipt: undefined,
      artifactPaths: ['onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', ...Array.from({ length: 6 }, (_, index) => `onnx/model_q4f16.onnx_data_${index + 1}`)],
      completeResult: ({ callOrdinal, runtime, result }) => {
        if (callOrdinal !== 10 && callOrdinal !== 12) return result;
        // Source-derived control only: native KV bytes were not captured. The
        // actual cache class supplies identity; only observed length is synthetic.
        const cache = new runtime.DynamicCache();
        vi.spyOn(cache, 'get_seq_length').mockReturnValue(result.sequences.dims[1]! - 1);
        caches.set(callOrdinal, cache);
        return { ...result, past_key_values: cache };
      },
      unavailableOutputs: [11, 13, 14].map(callOrdinal => {
        const invocation = recorded.invocations[callOrdinal - 1]!;
        const request = recorded.requests.find(item => item.scenario === invocation.scenario)!;
        const starts = request.events.flatMap((event, index) => typeof event === 'object' && event !== null && !Array.isArray(event) && event.kind === 'assistant-start' ? [index] : []);
        // Retain every first-call chunk/thinking/tool callback and the second
        // assistant start, but never the old invalid second-call output.
        const expectedEventsBeforeGap = request.events.slice(0, (callOrdinal === 14 ? starts[0]! : starts[1]!) + 1);
        return { callOrdinal, scenario: invocation.scenario, requestInput: request.input, expectedEventsBeforeGap,
          verifyInput: ({ options, runtime, tokenizer, model }) => {
            if (!(options.input_ids instanceof runtime.Tensor) || !(options.attention_mask instanceof runtime.Tensor) || !options.streamer) throw new Error('Missing corrected GPT input');
            // Old calls 11/13 omitted an unconsumed terminal token; call 14
            // additionally belonged to another public chat. None is an oracle
            // for the corrected native input, even though the old run fulfilled.
            expect(() => replayCapturedFullInvocation({ invocation, options, runtime, modelConfig: model.config, parameters: { temperature: 0, topP: 1, maxCompletionTokens: 128 } })).toThrow();
            // The real native capture verifies zero stream events. Do not
            // replace its owned streamer descriptors with test spies here.
            let expected: bigint[];
            if (callOrdinal === 14) {
              expect(options.past_key_values).toBeNull();
              // Independent source-derived canonical input, not an observed
              // post-fix output or a call to Naidan's formatter under test.
              const namespace = `\
namespace functions {
// Return deterministic weather fixture data.
type lookup_weather = (_: {
  city: string,
}) => any;

} // namespace functions`;
              const canonicalMessages = [
                { role: 'developer', content: namespace },
                { role: 'user', content: 'Use the weather tool for Tokyo.' },
                { role: 'assistant', content: '', tool_calls: [{ id: 'call_model_support_probe_1', type: 'function', function: { name: 'lookup_weather', arguments: '{"city":"Tokyo"}' } }] },
                { role: 'tool', content: '{"temperatureC":20,"condition":"clear"}', tool_call_id: 'call_model_support_probe_1' },
              ];
              const inputs = tokenizer.apply_chat_template(canonicalMessages, { add_generation_prompt: true, return_dict: true });
              const parsed = z.object({ input_ids: z.instanceof(runtime.Tensor) }).parse(inputs);
              expected = Array.from(parsed.input_ids.data, BigInt);
            } else {
              const previous = recorded.invocations[callOrdinal - 2]!;
              const suffix = tokenizer.encode('<|start|>lookup_weather to=assistant<|channel|>commentary<|message|>{"temperatureC":20,"condition":"clear"}<|end|>', { add_special_tokens: false });
              expected = [...previous.sequence.tokens.map(BigInt), ...suffix.map(BigInt)];
              expect(options.past_key_values).toBe(caches.get(callOrdinal - 1));
              expect(options.past_key_values?.get_seq_length()).toBe(previous.sequence.tokens.length - 1);
            }
            expect(options.input_ids.type).toBe('int64');
            expect(options.input_ids.dims).toEqual([1, expected.length]);
            expect(Array.from(options.input_ids.data, BigInt)).toEqual(expected);
            expect(options.attention_mask.dims).toEqual([1, expected.length]);
            expect(Array.from(options.attention_mask.data, BigInt)).toEqual(expected.map(() => 1n));
            expect(options.max_new_tokens).toBe(128);
          },
        };
      }),
    });
    expect([...caches.keys()]).toEqual([10, 12]);
  }, 30_000);
});
