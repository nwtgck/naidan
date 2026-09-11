import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { expect, vi } from 'vitest';
import { z } from 'zod';
import { createProviderReplayTestRuntime, type ProviderReplayGenerate } from './provider-replay-test-runtime';
import { readModelFixture } from './model-runtime-fixture';
import { createSyntheticModelBody } from './download-synthetic-session-oracle';
import { captureScenarioSchema } from '@/features/transformers-js/model-support-investigation/logic/production-provider-capture-plan';
import type { ProductionProviderTraceEvent } from '@/features/transformers-js/model-support-investigation/logic/production-provider-trace';
import { productionLoadReceiptSchema } from '@/features/transformers-js/runtime/production-load-receipt';
import type { generationCaptureTakeResultSchema } from '@/features/transformers-js/worker/generation-capture';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const token = z.string().regex(/^(?:0|[1-9][0-9]*)$/u).max(20);
const tensorSchema = z.object({
  dtype: z.enum(['int64', 'float32']), dims: z.array(z.number().int().nonnegative()).max(8),
  byteLength: z.number().int().nonnegative().max(16 * 1024 * 1024), sha256: digest,
}).strict();
const inputSchema = z.object({ name: z.string(), value: z.discriminatedUnion('kind', [
  tensorSchema.extend({ kind: z.literal('tensor') }),
  z.object({ kind: z.literal('scalar'), value: z.array(z.number()) }).strict(),
  z.object({ kind: z.literal('image-sizes'), value: z.array(z.tuple([z.number(), z.number()])) }).strict(),
]) }).strict();
const property = z.object({ status: z.literal('value'), value: z.union([z.number(), z.boolean()]) }).strict();
const settingsSchema = z.object({
  requested: z.object({ maxCompletionTokens: property, temperature: property, topP: property }).strict(),
  kwargs: z.object({
    keys: z.object({ status: z.literal('complete'), totalCount: z.number().int(), values: z.array(z.string()), incompleteReasons: z.tuple([]) }).strict(),
    maxNewTokens: property, temperature: property, topP: property, doSample: property, returnDictInGenerate: property,
  }).strict(),
  budget: z.object({ source: z.literal('explicit'), pastTokenCount: z.number().int().nonnegative(),
    maxNewTokens: z.number().int().positive(), contextLimit: z.number().int().positive(),
    promptTokenCount: z.number().int().positive(), usedContextTokenCount: z.number().int().positive(),
  }).strict(),
}).strict();
export const capturedInvocationSchema = z.object({
  scenario: captureScenarioSchema, callOrdinal: z.number().int().positive(),
  preInputs: z.array(inputSchema), inputs: z.array(inputSchema), settings: settingsSchema,
  stream: z.array(z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('put'), groups: z.array(z.array(token).max(65536)).max(8) }).strict(),
    z.object({ operation: z.literal('end') }).strict(),
  ])).max(2048),
  finalized: z.array(z.object({ text: z.string(), streamEnd: z.boolean() }).strict()),
  sequence: tensorSchema.extend({ tokens: z.array(token).max(65536) }),
}).strict();
const invocationSchema = capturedInvocationSchema;
export const capturedFullEvidenceSchema = z.object({
  format: z.literal('captured-production-full-replay-v1'), modelId: z.string(),
  metadataRevision: z.string().regex(/^[a-f0-9]{40}$/u), observedCacheRevision: z.string(),
  loadReceipt: productionLoadReceiptSchema,
  localMetadataPaths: z.array(z.string()),
  sourceDigests: z.object({ native: digest, provider: digest, inventory: digest }).strict(),
  metadata: z.array(z.object({ path: z.string(), sha256: digest }).strict()),
  // Inert source projections, not executable Provider requests or tools.
  requests: z.array(z.object({ scenario: captureScenarioSchema, input: z.json(), events: z.array(z.json()) }).strict()).max(13),
  invocations: z.array(invocationSchema).max(32),
  // Historical native outputs retained only to reject their old input contract.
  // These calls must be replaced by explicit no-output verification, never replay.
  unavailableRecordedCalls: z.array(z.number().int().positive()).optional(),
  nativeInputGaps: z.array(invocationSchema.pick({ scenario: true, callOrdinal: true, preInputs: true, inputs: true, settings: true }).extend({ requestInput: z.json() })).optional(),
}).strict();
const evidenceSchema = capturedFullEvidenceSchema;
export type CapturedFullReplayEvidence = z.infer<typeof evidenceSchema>;
type Invocation = z.infer<typeof invocationSchema>;

function hash({ bytes }: { bytes: Uint8Array }): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function exact({ label, actual, expected }: { label: string; actual: unknown; expected: unknown }) {
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`Captured Full causal mismatch: ${label}`);
}

const controlKeys = new Set(['past_key_values', 'max_new_tokens', 'temperature', 'top_p', 'do_sample', 'streamer', 'stopping_criteria', 'return_dict_in_generate']);
function verifyInvocationEvidence({ invocation }: { invocation: Invocation }) {
  const keys = invocation.settings.kwargs.keys.values;
  for (const names of [keys, invocation.inputs.map(input => input.name), invocation.preInputs.map(input => input.name)]) {
    if (new Set(names).size !== names.length) throw new Error('Duplicate captured native key');
  }
  exact({ label: 'complete input evidence', actual: invocation.inputs.map(input => input.name).sort(), expected: keys.filter(key => !controlKeys.has(key)).sort() });
  // These zero-cache and explicitly owned full-prefix captures have no
  // pre-budget slicing. Other cache transformations need a separate contract.
  exact({ label: 'pre-budget input identity', actual: invocation.preInputs, expected: invocation.inputs });
  exact({ label: 'recorded sequence byte length', actual: invocation.sequence.tokens.length * 8, expected: invocation.sequence.byteLength });
  exact({ label: 'recorded sequence dtype', actual: invocation.sequence.dtype, expected: 'int64' });
  exact({ label: 'recorded sequence dimensions', actual: invocation.sequence.dims, expected: [1, invocation.sequence.tokens.length] });
  exact({ label: 'recorded sequence digest', actual: hash({ bytes: new Uint8Array(BigInt64Array.from(invocation.sequence.tokens, BigInt).buffer) }), expected: invocation.sequence.sha256 });
  exact({ label: 'recorded kwargs count', actual: keys.length, expected: invocation.settings.kwargs.keys.totalCount });
  if (invocation.stream.at(-1)?.operation !== 'end' || invocation.stream.filter(event => event.operation === 'end').length !== 1) throw new Error('Incomplete captured stream');
  const streamed: string[] = [];
  for (const event of invocation.stream) {
    switch (event.operation) {
    case 'put':
      if (event.groups.length !== 1) throw new Error('Unrecorded replay batch shape');
      streamed.push(...event.groups[0]!);
      break;
    case 'end': break;
    default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
    }
  }
  exact({ label: 'stream/returned sequence identity', actual: streamed, expected: invocation.sequence.tokens });
}

export function parseCapturedFullReplay({ value }: { value: unknown }): CapturedFullReplayEvidence {
  const evidence = evidenceSchema.parse(value);
  // These captured fixtures have identical local-inventory metadata and
  // observed metadata hits. This is a fixture correlation, not a general
  // assertion that every locally present file must be used by Production.
  exact({ label: 'observed local metadata inventory', actual: [...evidence.localMetadataPaths].sort(), expected: evidence.loadReceipt.cacheLookup.hitPaths.filter(path => !path.startsWith('onnx/')).sort() });
  if (new Set(evidence.requests.map(request => request.scenario)).size !== evidence.requests.length) throw new Error('Duplicate captured scenario');
  for (const [index, invocation] of evidence.invocations.entries()) {
    exact({ label: 'recorded invocation order', actual: invocation.callOrdinal, expected: index + 1 });
    if (!evidence.requests.some(request => request.scenario === invocation.scenario)) throw new Error('Unowned captured invocation');
    verifyInvocationEvidence({ invocation });
  }
  return evidence;
}

type InvocationReplayArguments = {
  invocation: Invocation;
  options: Parameters<ProviderReplayGenerate>[0]['options'];
  runtime: Parameters<ProviderReplayGenerate>[0]['runtime'];
  modelConfig: unknown;
  parameters: unknown;
};
export type CapturedReplayResult = {
  sequences: InstanceType<InvocationReplayArguments['runtime']['Tensor']>;
  past_key_values: NonNullable<InvocationReplayArguments['options']['past_key_values']> | null;
};
/** Source-derived ownership/length control, never captured GPU KV contents. */
export type OwnedReplayCacheControl = {
  previousSequence: CapturedReplayResult['sequences'];
  pastKeyValues: NonNullable<InvocationReplayArguments['options']['past_key_values']>;
};

/** Zero-cache inference boundary; existing callers cannot silently acquire KV. */
export function replayCapturedFullInvocation({ ...args }: InvocationReplayArguments): CapturedReplayResult {
  return replayCapturedInvocation({ ...args, cacheControl: undefined });
}

/** Explicit full-prefix, synthetic-cache boundary for recorded continuation. */
export function replayCapturedFullInvocationWithOwnedCache({ cacheControl, ...args }: InvocationReplayArguments & {
  cacheControl: OwnedReplayCacheControl;
}): CapturedReplayResult {
  return replayCapturedInvocation({ ...args, cacheControl });
}

/** Native inference replacement only; no output is released before all gates. */
function replayCapturedInvocation({ invocation, options, runtime, modelConfig, parameters, cacheControl }: InvocationReplayArguments & {
  cacheControl: OwnedReplayCacheControl | undefined;
}): CapturedReplayResult {
  const checked = invocationSchema.parse(invocation);
  verifyInvocationEvidence({ invocation: checked });
  const label = `${checked.scenario}/call-${checked.callOrdinal}`;
  exact({ label: `${label}/kwargs`, actual: Object.keys(options).sort(), expected: [...checked.settings.kwargs.keys.values].sort() });
  for (const input of checked.inputs) {
    const actual: unknown = options[input.name];
    switch (input.value.kind) {
    case 'tensor': {
      if (!(actual instanceof runtime.Tensor) || actual.location !== 'cpu' || !ArrayBuffer.isView(actual.data)) throw new Error(`Captured Full requires actual CPU Tensor: ${label}/${input.name}`);
      const bytes = new Uint8Array(actual.data.buffer, actual.data.byteOffset, actual.data.byteLength);
      const { kind: _kind, ...fact } = input.value;
      exact({ label: `${label}/${input.name}`, actual: { dtype: actual.type, dims: actual.dims, byteLength: bytes.byteLength, sha256: hash({ bytes }) }, expected: fact });
      break;
    }
    case 'scalar': case 'image-sizes': exact({ label: `${label}/${input.name}`, actual, expected: input.value.value }); break;
    default: { const exhaustive: never = input.value; throw new Error(String(exhaustive)); }
    }
  }
  exact({ label: `${label}/sampling`, actual: [options.max_new_tokens, options.temperature, options.top_p, options.do_sample, options.return_dict_in_generate],
    expected: [checked.settings.kwargs.maxNewTokens.value, checked.settings.kwargs.temperature.value, checked.settings.kwargs.topP.value, checked.settings.kwargs.doSample.value, checked.settings.kwargs.returnDictInGenerate.value] });
  let pastTokenCount = 0;
  if (cacheControl === undefined) {
    exact({ label: `${label}/past-token-count`, actual: checked.settings.budget.pastTokenCount, expected: 0 });
    if (options.past_key_values !== null && options.past_key_values !== undefined) throw new Error(`Captured Full has no KV control: ${label}`);
  } else {
    if (options.past_key_values !== cacheControl.pastKeyValues || !(options.past_key_values instanceof runtime.DynamicCache)) throw new Error(`Captured Full causal mismatch: ${label}/owned cache identity`);
    const previous = cacheControl.previousSequence;
    if (!(previous instanceof runtime.Tensor) || previous.type !== 'int64' || previous.location !== 'cpu'
      || previous.dims.length !== 2 || previous.dims[0] !== 1 || previous.data.length !== previous.dims[1]
      || previous.data.length < 2) throw new Error(`Captured Full causal mismatch: ${label}/previous sequence control`);
    if (!(options.input_ids instanceof runtime.Tensor) || options.input_ids.data.length <= previous.data.length) throw new Error(`Captured Full causal mismatch: ${label}/owned full-prefix input`);
    exact({ label: `${label}/previous returned sequence prefix`, actual: Array.from(options.input_ids.data, String).slice(0, previous.data.length), expected: Array.from(previous.data, String) });
    pastTokenCount = options.past_key_values.get_seq_length();
    exact({ label: `${label}/owned cache length`, actual: pastTokenCount, expected: previous.data.length - 1 });
    exact({ label: `${label}/recorded past-token-count`, actual: checked.settings.budget.pastTokenCount, expected: pastTokenCount });
  }
  const requested = z.object({ maxCompletionTokens: z.number().int().positive(), temperature: z.number(), topP: z.number() }).parse(parameters);
  exact({ label: `${label}/requested parameters`, actual: checked.settings.requested, expected: {
    maxCompletionTokens: { status: 'value', value: requested.maxCompletionTokens }, temperature: { status: 'value', value: requested.temperature }, topP: { status: 'value', value: requested.topP },
  } });
  const config = z.object({ is_encoder_decoder: z.boolean().optional(), max_position_embeddings: z.number().int().positive().optional(), text_config: z.object({ max_position_embeddings: z.number().int().positive().optional() }).optional() }).parse(modelConfig);
  if (config.is_encoder_decoder === true) throw new Error('Encoder-decoder replay requires an explicit budget lane');
  const contextLimit = config.max_position_embeddings ?? config.text_config?.max_position_embeddings;
  if (contextLimit === undefined || !(options.input_ids instanceof runtime.Tensor)) throw new Error('Missing actual replay context');
  const promptTokenCount = options.input_ids.dims.at(-1)!;
  exact({ label: `${label}/independent budget`, actual: checked.settings.budget, expected: {
    // Actual full input already contains the previous sequence. Adding cache
    // length again would double-count context; it is not a suffix-only input.
    source: 'explicit', pastTokenCount, maxNewTokens: Math.min(requested.maxCompletionTokens, contextLimit - promptTokenCount), contextLimit, promptTokenCount, usedContextTokenCount: promptTokenCount,
  } });
  exact({ label: `${label}/sampling derivation`, actual: [options.max_new_tokens, options.temperature, options.top_p, options.do_sample], expected: [checked.settings.budget.maxNewTokens, requested.temperature, requested.topP, requested.temperature > 0] });
  const first = checked.stream[0];
  if (first === undefined) throw new Error('Missing prompt stream');
  switch (first.operation) {
  case 'put': exact({ label: `${label}/stream prompt`, actual: first.groups, expected: [Array.from(options.input_ids.data, String)] }); break;
  case 'end': throw new Error('Stream ended before prompt');
  default: { const exhaustive: never = first; throw new Error(String(exhaustive)); }
  }
  if (!(options.streamer instanceof runtime.TextStreamer) || typeof options.stopping_criteria !== 'function') throw new Error(`Captured Full requires actual stream/stopping controls: ${label}`);
  for (const action of checked.stream) {
    switch (action.operation) {
    case 'put': options.streamer.put(action.groups.map(group => group.map(BigInt))); break;
    case 'end': options.streamer.end(); break;
    default: { const exhaustive: never = action; throw new Error(String(exhaustive)); }
    }
  }
  return { sequences: new runtime.Tensor('int64', BigInt64Array.from(checked.sequence.tokens, BigInt), checked.sequence.dims), past_key_values: null };
}

function jsonProjection({ value }: { value: unknown }) {
  return JSON.parse(JSON.stringify(value, (_key, child: unknown) => child === undefined ? null : child)) as unknown;
}
function providerEvents({ events }: { events: readonly ProductionProviderTraceEvent[] }) {
  const ids = new Map<string, string>();
  return events.map(event => {
    if (!('toolCallId' in event)) return event;
    switch (event.kind) {
    case 'tool-call':
      if (ids.has(event.toolCallId)) throw new Error('Duplicate actual tool ID');
      ids.set(event.toolCallId, `tool-${ids.size + 1}`);
      break;
    case 'tool-started': case 'tool-output': case 'tool-exit': case 'tool-success': case 'tool-error': break;
    default: { const exhaustive: never = event; throw new Error(String(exhaustive)); }
    }
    const id = ids.get(event.toolCallId);
    if (id === undefined) throw new Error('Unowned actual tool result');
    return { ...event, toolCallId: id };
  });
}

/** Exact delivered prefix; a missing chunk is not excused by successful tools. */
export function verifyCapturedProviderPrefix({ events, expected }: { events: readonly ProductionProviderTraceEvent[]; expected: readonly unknown[] }) {
  exact({ label: 'all callbacks before evidence gap', actual: providerEvents({ events }), expected });
}

/** Failed native calls must still retain the observed input evidence. */
export function verifyCapturedGapInputs({ events, expected }: {
  events: Extract<z.infer<typeof generationCaptureTakeResultSchema>, { status: 'captured' }>['capture']['events'];
  expected: Pick<Invocation, 'preInputs' | 'inputs' | 'settings'>;
}) {
  const settings = events.filter(event => event.kind === 'settings');
  exact({ label: 'gap captured settings', actual: settings.map(event => event.value), expected: [expected.settings] });
  for (const phase of ['pre-budget', 'native-kwargs'] as const) {
    const snapshots = events.filter(event => event.kind === 'inputs' && event.phase === phase);
    if (snapshots.length !== 1 || snapshots[0]?.kind !== 'inputs') throw new Error(`Missing gap captured ${phase} inputs`);
    const values = snapshots[0].values;
    const { inputs, keys } = (() => {
      switch (phase) {
      case 'pre-budget': return { inputs: expected.preInputs, keys: expected.preInputs.map(input => input.name) };
      case 'native-kwargs': return { inputs: expected.inputs, keys: expected.settings.kwargs.keys.values };
      default: { const exhaustive: never = phase; throw new Error(String(exhaustive)); }
      }
    })();
    exact({ label: `gap captured ${phase} keys`, actual: values.map(value => value.name).sort(), expected: [...keys].sort() });
    for (const input of inputs) {
      const actual = values.find(value => value.name === input.name)?.snapshot;
      switch (input.value.kind) {
      case 'tensor': {
        if (actual === undefined) throw new Error(`Missing gap captured ${phase}/${input.name} tensor`);
        switch (actual.status) {
        case 'captured': break;
        case 'scalar': case 'image-sizes': case 'not-recorded': throw new Error(`Missing gap captured ${phase}/${input.name} tensor`);
        default: { const exhaustive: never = actual; throw new Error(String(exhaustive)); }
        }
        const { kind: _kind, ...fact } = input.value;
        exact({ label: `gap captured ${phase}/${input.name}`, actual: { dtype: actual.dtype, dims: actual.dims, byteLength: actual.byteLength, sha256: hash({ bytes: actual.bytes }) }, expected: fact });
        break;
      }
      case 'scalar': case 'image-sizes':
        exact({ label: `gap captured ${phase}/${input.name}`, actual, expected: { status: input.value.kind, values: input.value.value } });
        break;
      default: { const exhaustive: never = input.value; throw new Error(String(exhaustive)); }
      }
    }
  }
}

type ReplayOutputGap = {
  callOrdinal: number;
  scenario: z.infer<typeof captureScenarioSchema>;
  requestInput: unknown;
  expectedEventsBeforeGap: readonly unknown[];
  verifyInput: ({ options, runtime, model, tokenizer }: Parameters<ProviderReplayGenerate>[0]) => void;
};

/** Reviewed current public contracts are not mutations of historical capture. */
export type ReviewedProviderReplayContract = {
  correctedEvents: readonly {
    scenario: z.infer<typeof captureScenarioSchema>;
    reason: string;
    expectedEvents: readonly unknown[];
  }[];
  invalidatedOutputs: readonly (ReplayOutputGap & { reason: string })[];
  // Absent preserves the exact historical decoder callbacks. These are not
  // replacement native tokens or permission to change any inference input.
  correctedFinalizedStreams?: readonly {
    callOrdinal: number;
    scenario: z.infer<typeof captureScenarioSchema>;
    reason: string;
    expectedFinalized: readonly { text: string; streamEnd: boolean }[];
  }[];
};

function validateReviewedProviderContract({ evidence, reviewedPublicContract, originalGaps }: {
  evidence: CapturedFullReplayEvidence;
  reviewedPublicContract: ReviewedProviderReplayContract | undefined;
  originalGaps: readonly ReplayOutputGap[];
}) {
  const correctedEvents = new Map<string, readonly unknown[]>();
  const correctedFinalizedStreams = new Map<number, { text: string; streamEnd: boolean }[]>();
  const invalidated = reviewedPublicContract?.invalidatedOutputs ?? [];
  const gapOrdinals = new Set(originalGaps.map(gap => gap.callOrdinal));
  const gapScenarios = new Set(originalGaps.map(gap => gap.scenario));
  for (const gap of invalidated) {
    if (gap.reason.trim().length === 0) throw new Error('Missing reviewed output-invalidation reason');
    if (gapOrdinals.has(gap.callOrdinal) || gapScenarios.has(gap.scenario)) throw new Error('Duplicate reviewed output gap');
    const recorded = evidence.invocations.filter(invocation => invocation.callOrdinal === gap.callOrdinal && invocation.scenario === gap.scenario);
    if (recorded.length !== 1 || evidence.unavailableRecordedCalls?.includes(gap.callOrdinal)) throw new Error('Invalidated output must identify one originally replayable native invocation');
    const request = evidence.requests.find(candidate => candidate.scenario === gap.scenario);
    if (request === undefined || isDeepStrictEqual(jsonProjection({ value: gap.requestInput }), request.input)) {
      throw new Error('Output invalidation requires a changed public input, not a replay waiver');
    }
    gapOrdinals.add(gap.callOrdinal); gapScenarios.add(gap.scenario);
  }
  for (const correction of reviewedPublicContract?.correctedEvents ?? []) {
    if (correction.reason.trim().length === 0) throw new Error('Missing reviewed public-contract reason');
    if (correctedEvents.has(correction.scenario) || gapScenarios.has(correction.scenario)) throw new Error('Duplicate or gap-owned public-contract correction');
    if (evidence.requests.filter(request => request.scenario === correction.scenario).length !== 1) throw new Error('Public-contract correction must identify one recorded request');
    // Detach model-local expected data before Production can run. No function
    // transforms current callbacks or silently normalizes historical evidence.
    correctedEvents.set(correction.scenario, z.array(z.json()).parse(correction.expectedEvents));
  }
  for (const correction of reviewedPublicContract?.correctedFinalizedStreams ?? []) {
    if (correction.reason.trim().length === 0) throw new Error('Missing reviewed finalized-stream reason');
    if (correctedFinalizedStreams.has(correction.callOrdinal) || gapOrdinals.has(correction.callOrdinal)) throw new Error('Duplicate or gap-owned finalized-stream correction');
    if (evidence.invocations.filter(invocation => invocation.callOrdinal === correction.callOrdinal && invocation.scenario === correction.scenario).length !== 1
      || evidence.unavailableRecordedCalls?.includes(correction.callOrdinal)) throw new Error('Finalized-stream correction must identify one replayable native invocation');
    correctedFinalizedStreams.set(correction.callOrdinal, z.array(z.object({ text: z.string(), streamEnd: z.boolean() }).strict()).parse(correction.expectedFinalized));
  }
  return { correctedEvents, correctedFinalizedStreams, gaps: [...originalGaps, ...invalidated].sort((left, right) => left.callOrdinal - right.callOrdinal) };
}

function verifyFinalizedCorrectionsUsed({ expected, used }: { expected: readonly number[]; used: readonly number[] }) {
  exact({ label: 'every reviewed finalized stream must be used exactly once', actual: [...used].sort((a, b) => a - b), expected: [...expected].sort((a, b) => a - b) });
}

/** One real Full owner and Load preserve cross-request causality. */
export async function verifyCapturedFullReplay({ evidence: source, artifactPaths, imagePlatform, unavailableOutputs: originalGaps, completeResult, expectedLoadReceipt, reviewedPublicContract }: {
  evidence: unknown; artifactPaths: readonly string[];
  imagePlatform: Parameters<typeof createProviderReplayTestRuntime>[0]['imagePlatform'];
  unavailableOutputs: readonly ReplayOutputGap[];
  completeResult: (({ options, runtime, model, tokenizer, callOrdinal, result }: Parameters<ProviderReplayGenerate>[0] & { callOrdinal: number; result: ReturnType<typeof replayCapturedFullInvocation> }) => Awaited<ReturnType<ProviderReplayGenerate>>) | undefined;
  expectedLoadReceipt: z.infer<typeof productionLoadReceiptSchema> | undefined;
  reviewedPublicContract: ReviewedProviderReplayContract | undefined;
}) {
  const evidence = parseCapturedFullReplay({ value: source });
  expect(originalGaps.filter(item => evidence.invocations.some(invocation => invocation.callOrdinal === item.callOrdinal)).map(item => item.callOrdinal)).toEqual(evidence.unavailableRecordedCalls ?? []);
  const { correctedEvents, correctedFinalizedStreams, gaps: unavailableOutputs } = validateReviewedProviderContract({ evidence, reviewedPublicContract, originalGaps });
  const usedCorrections: string[] = [];
  const usedFinalizedCorrections: number[] = [];
  const metadata = readModelFixture({ modelId: evidence.modelId });
  expect(metadata.summary.revision).toBe(evidence.metadataRevision);
  expect(evidence.metadata.map(resource => resource.path).sort(), 'complete source metadata path set').toEqual([...metadata.files.keys()].sort());
  for (const resource of evidence.metadata) {
    expect(hash({ bytes: metadata.files.get(resource.path)! }), resource.path).toBe(resource.sha256);
  }
  let callOrdinal = 0;
  const requestOrdinals = new Map<string, number>();
  const runtimeOrdinals = new Map<number, number>();
  const verifiedGaps: number[] = [];
  const gapFailures: string[] = [];
  const harness = await createProviderReplayTestRuntime({
    modelId: evidence.modelId, expectedRevision: evidence.metadataRevision, cacheRevision: evidence.observedCacheRevision, metadataCache: evidence.localMetadataPaths, imagePlatform,
    artifacts: artifactPaths.map(path => ({ path, bytes: createSyntheticModelBody({ modelId: evidence.modelId, revision: evidence.metadataRevision, path }) })),
    generate: async ({ options, runtime, model, tokenizer }) => {
      const args = { options, runtime, model, tokenizer };
      callOrdinal++;
      const active = owner.snapshotProvider().requests.filter(request => request.status === 'awaiting-settlement');
      expect(active, 'one active request before stream release').toHaveLength(1);
      const request = active[0];
      if (request === undefined) throw new Error('Missing active Provider request');
      const localOrdinal = (requestOrdinals.get(request.scenario) ?? 0) + 1;
      requestOrdinals.set(request.scenario, localOrdinal);
      // Source-global ordinals are provenance only. The active public request
      // and its local invocation select evidence; actual capture IDs are mapped
      // independently for later whole-owner assertions.
      const recordedCalls = [...evidence.invocations, ...(evidence.nativeInputGaps ?? [])]
        .filter(item => item.scenario === request.scenario).sort((a, b) => a.callOrdinal - b.callOrdinal);
      const recordedCall = recordedCalls[localOrdinal - 1];
      if (recordedCall === undefined) throw new Error('Unrecorded extra native invocation');
      const sourceCallOrdinal = recordedCall.callOrdinal;
      if (runtimeOrdinals.has(sourceCallOrdinal)) throw new Error('Duplicate replayed source invocation');
      runtimeOrdinals.set(sourceCallOrdinal, callOrdinal);
      const gap = unavailableOutputs.find(item => item.callOrdinal === sourceCallOrdinal);
      if (gap !== undefined) {
        expect(request?.scenario).toBe(gap.scenario);
        expect(jsonProjection({ value: request?.input })).toEqual(gap.requestInput);
        try {
          gap.verifyInput(args);
        } catch (error) {
          gapFailures.push(`${gap.scenario}: ${error instanceof Error ? error.message.slice(0, 1200) : 'unreadable failure'}`);
          throw error;
        }
        verifiedGaps.push(sourceCallOrdinal);
        const error = new Error(`No recorded output for verified current input: ${gap.scenario}`);
        error.name = 'EvidenceOutputUnavailableError';
        throw error;
      }
      const invocation = evidence.invocations.find(item => item.callOrdinal === sourceCallOrdinal);
      if (invocation === undefined) throw new Error('Unrecorded extra native invocation');
      expect(request?.scenario, 'active request before stream release').toBe(invocation.scenario);
      const recorded = evidence.requests.find(item => item.scenario === invocation.scenario)!;
      expect(jsonProjection({ value: request?.input }), `${invocation.scenario}/request before stream release`).toEqual(recorded.input);
      const result = replayCapturedFullInvocation({ invocation, options, runtime, modelConfig: model.config, parameters: request?.input?.parameters });
      if (completeResult === undefined) return result;
      const completed = completeResult({ ...args, callOrdinal: sourceCallOrdinal, result });
      const dictionary = z.object({ sequences: z.instanceof(runtime.Tensor) }).parse(completed);
      expect(dictionary.sequences, 'KV shape control must preserve the recorded sequence object').toBe(result.sequences);
      return completed;
    },
  });
  const { createProductionProviderGenerationCaptureOwner } = await import('@/features/transformers-js/model-support-investigation/logic/production-provider-generation-capture-owner');
  const { createTransformersJsGenerationCaptureClient } = await import('@/features/transformers-js/worker/client');
  const takes: Array<ReturnType<typeof vi.fn<() => Promise<unknown>>>> = [];
  const owner = createProductionProviderGenerationCaptureOwner({
    runId: 'captured-full-replay', modelId: evidence.modelId, plan: 'full-v2',
    traceLimits: { maximumEvents: 1024, maximumCharacters: 65536 }, maximumWorkerEpochs: 8,
    createCaptureClient: ({ runId, workerEpoch, getActiveRequest }) => {
      const capture = createTransformersJsGenerationCaptureClient({ runId, workerEpoch, getActiveRequest,
        limits: { maxCalls: 32, maxInvocationsPerCall: 8, maxEvents: 4096, maxTextBytes: 262144,
          maxTensorBytes: 16777216, maxTotalTensorBytes: 67108864, maxTokensPerStreamEvent: 65536,
          maxTotalStreamTokens: 262144, maxTotalStreamTokenBytes: 8388608 },
      });
      const take = vi.fn(capture.takeGenerationCapture); takes.push(take);
      return { ...capture, takeGenerationCapture: take };
    },
    createUnrecordedWorkerClient: () => {
      throw new Error('Unrecorded replacement Worker');
    },
  });
  try {
    const provider = await owner.run();
    expect(provider.run).toEqual({ status: 'completed' });
    expect(new Set(provider.requests.map(request => request.scenario))).toEqual(new Set([...evidence.requests.map(request => request.scenario), ...unavailableOutputs.map(gap => gap.scenario)]));
    expect(provider.requests.map(request => request.scenario), 'original whole-sequence request order').toEqual([...new Set([...evidence.requests.map(request => request.scenario), ...unavailableOutputs.map(gap => gap.scenario)])]);
    for (const request of provider.requests) {
      const gap = unavailableOutputs.find(item => item.scenario === request.scenario);
      if (gap !== undefined) {
        // The bounded public trace intentionally maps nonstandard error names to
        // unknown. The local verified-gap ledger below excludes assertion errors.
        expect(request.trace.settled?.outcome, request.scenario).toEqual({ status: 'rejected', errorName: 'unknown' });
        verifyCapturedProviderPrefix({ events: request.trace.settled!.events, expected: gap.expectedEventsBeforeGap });
        const sourceRequest = evidence.requests.find(item => item.scenario === request.scenario);
        const actualTools = providerEvents({ events: request.trace.settled!.events }).filter(event => event.kind.startsWith('tool-'));
        const sourceTools = (sourceRequest?.events ?? []).filter(event => typeof event === 'object' && event !== null && !Array.isArray(event) && typeof event.kind === 'string' && event.kind.startsWith('tool-'));
        expect(actualTools, `${request.scenario}/executed tools before output gap`).toEqual(sourceTools);
        expect(request.trace.lateEvents).toEqual([]);
        continue;
      }
      const recorded = evidence.requests.find(item => item.scenario === request.scenario)!;
      expect(request.trace.settled?.outcome, `${request.scenario}/${JSON.stringify(request.trace.settled?.outcome)}`).toEqual({ status: 'fulfilled' });
      expect(jsonProjection({ value: request.input }), `${request.scenario}/Provider input`).toEqual(recorded.input);
      const corrected = correctedEvents.get(request.scenario);
      if (corrected !== undefined) usedCorrections.push(request.scenario);
      expect(providerEvents({ events: request.trace.settled!.events }), `${request.scenario}/settled callbacks`).toEqual(corrected ?? recorded.events);
      expect(request.trace.completeness, request.scenario).toBe('complete');
      expect(request.trace.lateEvents, request.scenario).toEqual([]);
    }
    expect(usedCorrections.sort(), 'every reviewed public contract actually settled').toEqual([...correctedEvents.keys()].sort());
    expect(provider.requests.filter(request => request.trace.settled?.outcome.status === 'fulfilled')).toHaveLength(provider.requests.length - unavailableOutputs.length);
    const expectedCallCount = new Set([...evidence.invocations.map(item => item.callOrdinal), ...unavailableOutputs.map(item => item.callOrdinal)]).size;
    expect(callOrdinal).toBe(expectedCallCount);
    expect(verifiedGaps, gapFailures.join('\n')).toEqual(unavailableOutputs.map(item => item.callOrdinal));
    expect(takes).toHaveLength(1); expect(takes[0]).not.toHaveBeenCalled();
    await owner.collectNative(); expect(takes[0]).toHaveBeenCalledOnce();
    const snapshot = owner.snapshot();
    switch (snapshot.native.status) {
    case 'retained': break;
    case 'released': throw new Error('Missing real native collection');
    default: { const exhaustive: never = snapshot.native; throw new Error(String(exhaustive)); }
    }
    expect(snapshot.native.capture.epochs).toHaveLength(1);
    const epoch = snapshot.native.capture.epochs[0]!;
    if (epoch.collection.status !== 'returned' || epoch.collection.result.status !== 'captured') throw new Error('Missing real native capture');
    const capture = epoch.collection.result.capture;
    const load = epoch.collection.result.loadObservation;
    if (load === undefined) throw new Error('Missing actual ordinary Load receipt');
    switch (load.outcome.status) {
    case 'accepted': break;
    case 'loading': case 'failed': case 'cleared': case 'not-recorded': throw new Error('Missing actual ordinary Load receipt');
    default: { const exhaustive: never = load.outcome; throw new Error(String(exhaustive)); }
    }
    expect(load.owner).toEqual({ runId: 'captured-full-replay', workerEpoch: 1 });
    expect(load.loadOrdinal).toBe(1);
    expect(load.outcome.receipt.cacheLookup.revision, 'actual cache namespace, not remote metadata identity').toBe(evidence.observedCacheRevision);
    // Original optional/unselected cache hits stay in the fixture, but this
    // bounded replay seeds only metadata and explicitly listed tiny artifacts.
    // Never infer consumption of unselected original weight files from headers.
    const availablePaths = new Set([...evidence.localMetadataPaths, ...artifactPaths]);
    const expectedReceipt = expectedLoadReceipt ?? evidence.loadReceipt;
    expect(expectedReceipt.plannedRequiredPaths.every(path => availablePaths.has(path))).toBe(true);
    expect(load.outcome.receipt, `actual bounded Load receipt: ${JSON.stringify(load.outcome.receipt)}`).toEqual({ ...expectedReceipt, cacheLookup: {
      ...expectedReceipt.cacheLookup, hitPaths: expectedReceipt.cacheLookup.hitPaths.filter(path => availablePaths.has(path)),
    } });
    expect(capture.incompleteReasons).toEqual([]);
    expect(capture.calls).toHaveLength(expectedCallCount);
    for (const gap of unavailableOutputs) {
      const runtimeOrdinal = runtimeOrdinals.get(gap.callOrdinal);
      expect(runtimeOrdinal, `${gap.scenario}/actual capture identity`).toBeDefined();
      expect(capture.calls.find(call => call.context.generationCallId === runtimeOrdinal)?.outcome, `${gap.scenario}/native gap settlement`).toBe('rejected');
      expect(capture.events.filter(event => event.identity.generationCallId === runtimeOrdinal && event.kind === 'native-stream'), `${gap.scenario}/no invented output`).toEqual([]);
      const recordedInputs = evidence.nativeInputGaps?.find(input => input.callOrdinal === gap.callOrdinal);
      if (recordedInputs !== undefined) verifyCapturedGapInputs({ events: capture.events.filter(event => event.identity.generationCallId === runtimeOrdinal), expected: recordedInputs });
    }
    for (const invocation of evidence.invocations) {
      if (unavailableOutputs.some(gap => gap.callOrdinal === invocation.callOrdinal)) continue;
      const label = `${invocation.scenario}/call-${invocation.callOrdinal}`;
      const runtimeOrdinal = runtimeOrdinals.get(invocation.callOrdinal);
      expect(runtimeOrdinal, `${label}/actual capture identity`).toBeDefined();
      const events = capture.events.filter(event => event.identity.generationCallId === runtimeOrdinal);
      expect(events.find(event => event.kind === 'settings')?.value, `${label}/settings`).toEqual(invocation.settings);
      const stream = events.filter(event => event.kind === 'native-stream').filter(event => event.phase === 'entering' && event.operation !== 'on_finalized_text').map(event => {
        switch (event.operation) {
        case 'put': return { operation: 'put', groups: z.object({ kind: z.literal('tokens'), tokenType: z.literal('bigint'), groups: z.array(z.array(token)) }).parse(event.detail).groups };
        case 'end': expect(event.detail).toEqual({ kind: 'none' }); return { operation: 'end' };
        case 'on_finalized_text': throw new Error('Unexpected finalized callback in native action list');
        default: { const exhaustive: never = event.operation; throw new Error(String(exhaustive)); }
        }
      });
      expect(stream, `${label}/captured put grouping and end order`).toEqual(invocation.stream);
      const sequences = events.filter(event => event.kind === 'sequence');
      expect(sequences, `${label}/returned sequence count`).toHaveLength(1);
      expect(sequences[0]!.resultShape).toBe('dictionary');
      const sequence = z.object({ status: z.literal('captured'), dtype: z.literal('int64'), dims: z.array(z.number()), byteLength: z.number(), bytes: z.instanceof(Uint8Array) }).parse(sequences[0]!.snapshot);
      const { tokens: _tokens, ...sequenceFact } = invocation.sequence;
      expect({ dtype: sequence.dtype, dims: sequence.dims, byteLength: sequence.byteLength, sha256: hash({ bytes: sequence.bytes }) }, `${label}/captured sequence bytes`).toEqual(sequenceFact);
      const finalized = events.filter(event => event.kind === 'native-stream').filter(event => event.phase === 'entering' && event.operation === 'on_finalized_text')
        .map(event => {
          const { detail } = event;
          switch (detail.kind) {
          case 'finalized-text': return { text: detail.text, streamEnd: detail.streamEnd };
          case 'tokens': case 'none': case 'not-recorded': throw new Error(`Missing finalized callback: ${label}`);
          default: { const exhaustive: never = detail; throw new Error(String(exhaustive)); }
          }
        });
      const correctedFinalized = correctedFinalizedStreams.get(invocation.callOrdinal);
      if (correctedFinalized !== undefined) usedFinalizedCorrections.push(invocation.callOrdinal);
      expect(finalized, `${label}/actual finalized stream`).toEqual(correctedFinalized ?? invocation.finalized);
      const pre = events.filter(event => event.kind === 'inputs').find(event => event.phase === 'pre-budget');
      if (pre === undefined) throw new Error(`Missing pre-budget inputs: ${label}`);
      for (const input of invocation.preInputs) {
        const actual = pre.values.find(value => value.name === input.name)?.snapshot;
        switch (input.value.kind) {
        case 'tensor': {
          if (actual === undefined) throw new Error(`Missing captured tensor: ${label}/${input.name}`);
          switch (actual.status) {
          case 'captured': break;
          case 'scalar': case 'image-sizes': case 'not-recorded': throw new Error(`Missing captured tensor: ${label}/${input.name}`);
          default: { const exhaustive: never = actual; throw new Error(String(exhaustive)); }
          }
          const { kind: _kind, ...fact } = input.value;
          expect({ dtype: actual.dtype, dims: actual.dims, byteLength: actual.byteLength, sha256: hash({ bytes: actual.bytes }) }, `${label}/${input.name}/pre-budget`).toEqual(fact);
          break;
        }
        case 'scalar': case 'image-sizes':
          expect(actual, `${label}/${input.name}/pre-budget`).toEqual({ status: input.value.kind, values: input.value.value });
          break;
        default: { const exhaustive: never = input.value; throw new Error(String(exhaustive)); }
        }
      }
    }
    expect(harness.observations.workers).toHaveLength(1);
    expect(epoch.lifetime.status).toBe('observed');
    switch (epoch.lifetime.status) {
    case 'observed': expect(epoch.lifetime.value.loadRequests).toHaveLength(1); break;
    case 'unavailable': throw new Error('Missing observed Worker lifetime');
    default: { const exhaustive: never = epoch.lifetime; throw new Error(String(exhaustive)); }
    }
    verifyFinalizedCorrectionsUsed({ expected: [...correctedFinalizedStreams.keys()], used: usedFinalizedCorrections });
    expect(harness.observations.forbiddenTransport).toEqual([]);
    expect(harness.observations.fs.activity.filter(item => !['stat', 'body-read'].includes(item.operation))).toEqual([]);
  } finally {
    try {
      await owner.dispose();
      expect(harness.observations.workers.every(worker => worker.terminated)).toBe(true);
    } finally {
      await harness.close();
    }
  }
}

export const TEST_ONLY = {
  validateReviewedProviderContract,
  verifyFinalizedCorrectionsUsed,
};
