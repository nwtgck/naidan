import { createHash } from 'node:crypto';
import { expect, vi } from 'vitest';
import { z } from 'zod';
import { toToolCallId } from '@/01-models/ids';
import type { Tool } from '@/01-models/tool';
import type { ChatMessage } from '@/01-models/types';
import { readProviderRequestEvidence, type ProviderReplayCatalog } from './provider-replay-evidence';
import { replayCapturedFullInvocation, verifyCapturedProviderPrefix } from './provider-replay-test-captured-full';
import { createProviderReplayTestRuntime } from './provider-replay-test-runtime';
import { readModelFixture } from './model-runtime-fixture';
import { createSyntheticModelBody } from './download-synthetic-session-oracle';
import { createProductionProviderTrace } from '@/features/transformers-js/model-support-investigation/logic/production-provider-trace';

const toolCallSchema = z.object({ id: z.string(), type: z.literal('function'), function: z.object({ name: z.string(), arguments: z.string() }).strict() }).strict();
const messageSchema = z.union([
  z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }).strict(),
  z.object({ role: z.literal('assistant'), content: z.string(), tool_calls: z.array(toolCallSchema) }).strict(),
  z.object({ role: z.literal('tool'), content: z.string(), tool_call_id: z.string() }).strict(),
  z.object({ role: z.literal('user'), content: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string() }).strict(),
    z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }).strict() }).strict(),
  ])) }).strict(),
]);
const weatherIdentity = z.object({
  fixtureId: z.literal('model-support-weather-v1'), name: z.literal('lookup_weather'),
  description: z.literal('Return deterministic weather fixture data.'),
  parameters: z.object({ type: z.literal('object'), properties: z.object({ city: z.object({ type: z.literal('string') }).strict() }).strict(), required: z.tuple([z.literal('city')]), additionalProperties: z.literal(false) }).strict(),
}).strict();
const requestSchema = z.object({
  messages: z.array(messageSchema), tools: z.union([z.tuple([]), z.tuple([weatherIdentity])]),
  parameters: z.object({
    temperature: z.number(), topP: z.number(), maxCompletionTokens: z.number().int().positive(),
    presencePenalty: z.null(), frequencyPenalty: z.null(), stop: z.null(),
    reasoning: z.object({ effort: z.enum(['none', 'low', 'medium', 'high']).nullable() }).strict(),
  }).strict(),
}).strict();

/** Fixture-to-public-message conversion, independent of MSI's scenario builder. */
function messagesFromEvidence({ messages }: { messages: z.infer<typeof requestSchema>['messages'] }): ChatMessage[] {
  return messages.map(message => {
    if ('tool_calls' in message) return { ...message, tool_calls: message.tool_calls.map(call => ({ ...call, id: toToolCallId({ raw: call.id }) })) };
    if ('tool_call_id' in message) return { ...message, tool_call_id: toToolCallId({ raw: message.tool_call_id }) };
    return { ...message };
  });
}

/** Explicit public requests and their native tool continuations in one runtime.
 * A fresh runtime belongs to this it only. Stateful cases execute their required
 * prefix here; whole-capture collection ownership stays in the Full regression.
 */
export async function verifyProviderRequests({ catalog, caseIds, artifactPaths, imagePlatform }: {
  catalog: ProviderReplayCatalog; caseIds: readonly Parameters<typeof readProviderRequestEvidence>[0]['caseId'][];
  artifactPaths: readonly string[];
  imagePlatform: Parameters<typeof createProviderReplayTestRuntime>[0]['imagePlatform'];
}) {
  if (caseIds.length === 0 || new Set(caseIds).size !== caseIds.length) throw new Error('Missing or duplicate explicit replay request');
  const selected = caseIds.map(caseId => readProviderRequestEvidence({ catalog, caseId }));
  const context = selected[0]!.context;
  for (const { context: resource, evidence } of selected) {
    expect(resource).toEqual(context);
    if (evidence.request === undefined || evidence.inputGaps.length !== 0 || evidence.unavailableOutputOrdinals.length !== 0) throw new Error('Missing output is not an independent successful replay');
  }
  const metadata = readModelFixture({ modelId: context.modelId });
  expect(metadata.summary.revision).toBe(context.metadataRevision);
  expect(context.metadata.map(row => row.path).sort()).toEqual([...metadata.files.keys()].sort());
  for (const row of context.metadata) expect(createHash('sha256').update(metadata.files.get(row.path)!).digest('hex'), row.path).toBe(row.sha256);
  let localOrdinal = 0;
  let active: { evidence: typeof selected[number]['evidence']; input: z.infer<typeof requestSchema> } | undefined;
  const harness = await createProviderReplayTestRuntime({
    modelId: context.modelId, expectedRevision: context.metadataRevision, cacheRevision: context.observedCacheRevision,
    metadataCache: context.localMetadataPaths, imagePlatform,
    artifacts: artifactPaths.map(path => ({ path, bytes: createSyntheticModelBody({ modelId: context.modelId, revision: context.metadataRevision, path }) })),
    generate: async ({ options, runtime, model }) => {
      ++localOrdinal;
      if (active === undefined) throw new Error('Native invocation outside an active Provider request');
      const { evidence, input } = active;
      const caseId = evidence.caseId;
      const invocation = evidence.invocations.find(item => item.localOrdinal === localOrdinal);
      if (invocation === undefined) throw new Error(`Unrecorded extra native invocation: ${caseId}/${localOrdinal}`);
      const { localOrdinal: ordinal, ...facts } = invocation;
      return replayCapturedFullInvocation({ invocation: { ...facts, scenario: caseId, callOrdinal: ordinal }, options, runtime, modelConfig: model.config, parameters: input.parameters });
    },
  });
  const settlements = new Map<string, ReturnType<ReturnType<typeof createProductionProviderTrace>['settle']>>();
  let settledRequests = 0;
  try {
    for (const { evidence } of selected) {
      const caseId = evidence.caseId;
      const input = requestSchema.parse(evidence.request!.input);
      const trace = createProductionProviderTrace({ requestId: `provider-request-${caseId}`, limits: { maximumEvents: 1024, maximumCharacters: 65536 } });
      // Fixed synthetic executable is test-owned. Never execute deserialized
      // code or derive its result from the callbacks being compared below.
      const execute = vi.fn<Tool['execute']>(async ({ args }) => {
        expect(args, `${caseId}/actual executed arguments`).toEqual({ city: 'Tokyo' });
        return { status: 'success', content: '{"temperatureC":20,"condition":"clear"}' };
      });
      const tools: Tool[] = input.tools.map(tool => ({ name: tool.name, description: tool.description, parametersSchema: z.object({ city: z.string() }), execute }));
      const { presencePenalty: _presencePenalty, frequencyPenalty: _frequencyPenalty, stop: _stop, reasoning, ...sampling } = input.parameters;
      const messages = messagesFromEvidence({ messages: input.messages });
      switch (caseId) {
      case 'continuity': {
        const firstSettled = settlements.get('first-turn');
        if (firstSettled?.outcome.status !== 'fulfilled' || firstSettled.completeness !== 'complete') throw new Error('Continuity requires actual first-request settlement in this runtime');
        const assistant = messages[1];
        if (assistant?.role !== 'assistant') throw new Error('Missing continuity assistant');
        assistant.content = firstSettled.events.filter(event => event.kind === 'chunk').map(event => event.chunk).join('');
        break;
      }
      case 'independent-next-input':
        if (settledRequests === 0) throw new Error('Independent-next requires a prior settled request in this runtime');
        break;
      case 'first-turn': case 'system-user': case 'supplied-history':
      case 'reasoning-none': case 'reasoning-low': case 'reasoning-medium': case 'reasoning-high':
      case 'natural-tool-minimal': case 'natural-tool-representative': case 'structured-tool-history': case 'image': break;
      default: { const exhaustive: never = caseId; throw new Error(String(exhaustive)); }
      }
      expect(messages, `${caseId}/actual public input before release`).toEqual(messagesFromEvidence({ messages: input.messages }));
      if (settledRequests > 0) expect(harness.service.getState().status, 'no implicit repair Load between requests').toBe('ready');
      active = { evidence, input };
      localOrdinal = 0;
      await harness.provider.chat({ model: context.modelId, messages, tools,
        parameters: { ...sampling, presencePenalty: undefined, frequencyPenalty: undefined, stop: undefined, reasoning: { effort: reasoning.effort ?? undefined } },
        ...trace.callbacks, signal: new AbortController().signal,
      });
      const settled = trace.settle({ outcome: 'fulfilled', error: undefined });
      active = undefined;
      ++settledRequests;
      settlements.set(caseId, settled);
      expect(settled.completeness, caseId).toBe('complete');
      verifyCapturedProviderPrefix({ events: settled.events, expected: evidence.request!.events });
      expect(trace.snapshot().lateEvents, caseId).toEqual([]);
      expect(localOrdinal, `${caseId}/complete native inventory`).toBe(evidence.invocations.length);
      const expectedTools = evidence.request!.events.filter(event => typeof event === 'object' && event !== null && !Array.isArray(event) && event.kind === 'tool-success');
      expect(execute, `${caseId}/actual tool execution count`).toHaveBeenCalledTimes(expectedTools.length);
    }
    expect(settledRequests).toBe(caseIds.length);
    expect(harness.observations.workers).toHaveLength(1);
    const loadRequest = z.object({ type: z.literal('APPLY'), path: z.tuple([z.literal('loadDownloadedModel')]) });
    expect(harness.observations.workers[0]!.hostMessages.filter(message => loadRequest.safeParse(message).success), 'one actual Comlink Load for the whole selected chain').toHaveLength(1);
    expect(harness.observations.forbiddenTransport).toEqual([]);
    expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  } finally {
    await harness.close();
    expect(harness.observations.workers.every(worker => worker.terminated)).toBe(true);
  }
}

export const TEST_ONLY = {
};
