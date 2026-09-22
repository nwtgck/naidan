import { z } from 'zod';
import { capturePlanSchema, captureScenarioSchema, captureScenarios, isCaptureScenarioSelected } from './production-provider-capture-plan';
import { createProductionProviderCapturePolicy, productionProviderCapturePolicySchema } from './production-provider-capture-policy';
import type { ProductionProviderInvestigationResult, ProductionProviderInvestigationProgress, createProductionProviderInvestigation } from './run-production-provider-investigation';

type Summary = ProductionProviderInvestigationResult['summary'];
export const PRODUCTION_PROVIDER_INVESTIGATION_SUMMARY_EVIDENCE_PATH = 'production-provider/summary.json';
export const productionProviderInvestigationSummaryReferenceSchema = z.object({
  format: z.literal('production-provider-investigation-summary-reference-v1'),
  path: z.literal(PRODUCTION_PROVIDER_INVESTIGATION_SUMMARY_EVIDENCE_PATH),
}).strict();

export interface ProductionProviderInvestigationLiveProgress {
  readonly progress: ProductionProviderInvestigationProgress;
  readonly deadlines: Readonly<Parameters<typeof createProductionProviderInvestigation>[0]['deadlines']>;
}

/** Structured UI telemetry only. No captured text, inputs, native bytes or
 * correctness result enters this sampling boundary. */
export function validateProductionProviderInvestigationLiveProgress({ value, runId, modelId }: {
  value: unknown; runId: string; modelId: string;
}): ProductionProviderInvestigationLiveProgress {
  try {
    inspectData({ value });
    const parsed = liveProgressSchema.parse(value);
    const { progress, deadlines, ...rest } = parsed;
    rest satisfies Record<PropertyKey, never>;
    const provider = progress.provider;
    const selected = captureScenarios({ plan: provider.plan }).filter(scenario => isCaptureScenarioSelected({ plan: provider.plan, scenario }));
    if (!Object.hasOwn(progress, 'stopReason') || !Object.hasOwn(provider, 'activeRequest')
      || provider.runId !== runId || provider.modelId !== modelId
      || provider.totalRequests !== captureScenarios({ plan: provider.plan }).length
      || provider.selectedRequests !== selected.length || provider.settledRequests > selected.length) invalid();
    const active = provider.activeRequest;
    if (active !== undefined && (active.runId !== runId || !selected.includes(active.scenario)
      || active.requestId !== `${runId}-${active.scenario}` || provider.run.status !== 'running'
      || provider.settledRequests >= selected.length)) invalid();
    // A completed v2 script can skip dependent continuity after a failed first
    // request. Aggregate completion is not proof that every selected request ran.
    if (provider.run.status === 'completed' && active !== undefined) invalid();
    return Object.freeze({ progress: Object.freeze({ ...progress, stopReason: progress.stopReason,
      provider: Object.freeze({ ...provider, activeRequest: active === undefined ? undefined : Object.freeze(active) }),
    }), deadlines: Object.freeze(deadlines) });
  } catch {
    throw new Error('Invalid Production Provider investigation progress');
  }
}
const maximumCharacters = 65536;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u);
const modelIdSchema = z.string().max(256).regex(/^(?:hf\.co\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const undefinedTag = z.object({ captureValue: z.literal('undefined') }).strict();
const notStartedReason = z.enum(['not-yet-started', 'scope-not-selected', 'first-settlement-unavailable', 'legacy-script-stopped', 'runtime-unavailable', 'aborted', 'deadline', 'disposed']);
const runSchema = z.union([
  z.object({ status: z.enum(['not-started', 'running', 'completed']) }).strict(),
  z.object({ status: z.literal('stopped'), reason: z.enum(['provider-rejected', 'capture-incomplete', 'aborted', 'disposed', 'runtime-unavailable']) }).strict(),
]);
const identity = z.object({ runId: id, requestId: id, scenario: captureScenarioSchema }).strict();
const encodedSchema = z.object({
  format: z.literal('production-provider-investigation-v1'),
  policy: productionProviderCapturePolicySchema,
  completion: z.enum(['completed', 'interrupted']),
  stopReason: z.union([z.enum(['user-requested', 'disposed', 'run-deadline', 'collection-deadline', 'sealing-deadline', 'execution-failed']), undefinedTag]),
  providerEvidence: z.enum(['available', 'refused']),
  providerProgress: z.object({
    runId: id, modelId: modelIdSchema, plan: capturePlanSchema, run: runSchema,
    lifetime: z.enum(['open', 'closing', 'closed']), activeRequest: z.union([identity, undefinedTag]),
    totalRequests: z.number().int().min(1).max(13), selectedRequests: z.number().int().min(1).max(13),
    settledRequests: z.number().int().min(0).max(13), loadStatus: z.enum(['idle', 'loading', 'ready', 'error']),
  }).strict(),
  requests: z.array(z.object({
    requestId: id, scenario: captureScenarioSchema, status: z.enum(['not-started', 'awaiting-settlement', 'settled']),
    notStartedReason: z.union([notStartedReason, undefinedTag]), outcome: z.union([z.enum(['fulfilled', 'rejected']), undefinedTag]),
    settledCompleteness: z.union([z.enum(['complete', 'incomplete']), undefinedTag]), completeness: z.enum(['complete', 'incomplete']),
    limits: z.object({ maximumEvents: z.literal(1024), maximumCharacters: z.literal(65536), maximumFieldCharacters: z.literal(16384) }).strict(),
    retainedCharacters: z.number().int().min(0).max(65536), eventCount: z.number().int().min(0).max(1024),
  }).strict()).min(1).max(13),
  cutoff: z.object({
    format: z.literal('production-provider-native-cutoff-v1'), runId: id,
    reason: z.enum(['normal-completion', 'run-deadline', 'collection-deadline', 'user-requested', 'disposed']),
    phaseAtCutoff: z.enum(['not-requested', 'collecting', 'finished']), maximumWorkerEpochs: z.number().int().min(1).max(8),
    unrecordedWorkerCreations: count, incompleteReasons: z.array(z.literal('epoch-limit')).max(1),
    epochs: z.array(z.object({
      workerEpoch: z.number().int().min(1).max(8),
      lifetime: z.union([
        z.object({ status: z.literal('unavailable') }).strict(),
        z.object({ status: z.literal('observed'), session: z.enum(['active', 'inactive']), issuedCallCount: z.number().int().min(0).max(32), loadRequestCount: z.number().int().min(0).max(32) }).strict(),
      ]),
      collectionStatus: z.enum(['not-requested', 'pending', 'returned', 'failed', 'unavailable']),
    }).strict()).max(8),
  }).strict(),
  nativeEvidenceStatus: z.enum(['not-attempted', 'available', 'provider-evidence-refused', 'sealing-deadline', 'sealing-interrupted', 'sealing-failed']),
  cleanup: z.enum(['not-requested', 'pending', 'completed', 'failed']), sealOwnership: z.enum(['settled', 'pending']), progressCallbackFailures: count,
}).strict();

const liveProgressSchema = z.object({
  progress: z.object({
    phase: z.enum(['not-started', 'running', 'collecting', 'sealing', 'finished']),
    provider: encodedSchema.shape.providerProgress.extend({ activeRequest: z.union([identity, z.undefined()]) }),
    stopReason: z.union([encodedSchema.shape.stopReason.options[0], z.undefined()]),
    cleanup: encodedSchema.shape.cleanup,
    sealOwnership: encodedSchema.shape.sealOwnership,
  }).strict(),
  deadlines: z.object({ runMs: z.number().int().min(1).max(86400000), collectionMs: z.number().int().min(1).max(86400000), sealingMs: z.number().int().min(1).max(86400000), cleanupMs: z.number().int().min(1).max(86400000) }).strict(),
}).strict();

function invalid(): never {
  throw new Error('Invalid Production Provider investigation summary');
}

// Inspect descriptors before schema access. This finite primitive-only summary
// admits no arbitrary payload objects, Blob, Error, methods or caller accessors.
function inspectData({ value }: { value: unknown }): void {
  let remaining = 4096;
  function visit({ value, depth }: { value: unknown; depth: number }): void {
    if (--remaining < 0 || depth > 10) invalid();
    if (value === undefined || typeof value === 'boolean' || typeof value === 'number') return;
    if (typeof value === 'string') {
      if (value.length > maximumCharacters) invalid(); return;
    }
    if (typeof value !== 'object' || value === null) invalid();
    const array = Array.isArray(value);
    if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length > 128) invalid();
    if (array && (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(key))))) invalid();
    for (const key of keys) {
      if (typeof key !== 'string') invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !('value' in descriptor)) invalid();
      visit({ value: descriptor.value, depth: depth + 1 });
    }
  }
  visit({ value, depth: 0 });
}

function encode({ summary }: { summary: Summary }) {
  const { format, policy, completion, stopReason, providerEvidence, providerProgress, requests, cutoff, nativeEvidenceStatus, cleanup, sealOwnership, progressCallbackFailures, ...rest } = summary;
  rest satisfies Record<PropertyKey, never>;
  if (!Object.hasOwn(summary, 'stopReason') || !Object.hasOwn(providerProgress, 'activeRequest')
    || requests.some(request => ['notStartedReason', 'outcome', 'settledCompleteness'].some(key => !Object.hasOwn(request, key)))) invalid();
  const tag = { captureValue: 'undefined' } as const;
  return { ...rest, format, policy, completion, providerEvidence, cutoff, nativeEvidenceStatus, cleanup, sealOwnership, progressCallbackFailures, stopReason: stopReason ?? tag,
    providerProgress: { ...providerProgress, activeRequest: providerProgress.activeRequest ?? tag },
    requests: requests.map(request => ({ ...request, notStartedReason: request.notStartedReason ?? tag, outcome: request.outcome ?? tag, settledCompleteness: request.settledCompleteness ?? tag })),
  };
}

function decode({ encoded, runId, modelId }: { encoded: z.infer<typeof encodedSchema>; runId: string; modelId: string }): Summary {
  const { format, policy, completion, stopReason, providerEvidence, providerProgress, requests, cutoff, nativeEvidenceStatus, cleanup, sealOwnership, progressCallbackFailures, ...rest } = encoded;
  rest satisfies Record<PropertyKey, never>;
  const summary: Summary = {
    format, policy, completion, stopReason: typeof stopReason === 'string' ? stopReason : undefined, providerEvidence,
    providerProgress: { ...providerProgress, activeRequest: 'captureValue' in providerProgress.activeRequest ? undefined : providerProgress.activeRequest },
    requests: requests.map(request => ({ ...request,
      notStartedReason: typeof request.notStartedReason === 'string' ? request.notStartedReason : undefined,
      outcome: typeof request.outcome === 'string' ? request.outcome : undefined,
      settledCompleteness: typeof request.settledCompleteness === 'string' ? request.settledCompleteness : undefined,
    })), cutoff, nativeEvidenceStatus, cleanup, sealOwnership, progressCallbackFailures,
  };
  if (providerProgress.runId !== runId || providerProgress.modelId !== modelId || cutoff.runId !== runId || policy.plan !== providerProgress.plan) invalid();
  if (JSON.stringify(policy) !== JSON.stringify(encodedSchema.shape.policy.parse(createProductionProviderCapturePolicy({ plan: policy.plan })))) invalid();
  const scenarios = captureScenarios({ plan: policy.plan });
  if (requests.length !== scenarios.length || providerProgress.totalRequests !== requests.length
    || providerProgress.selectedRequests !== scenarios.filter(scenario => isCaptureScenarioSelected({ plan: policy.plan, scenario })).length
    || providerProgress.settledRequests !== requests.filter(request => request.status === 'settled').length
    || cutoff.epochs.length > cutoff.maximumWorkerEpochs || cutoff.epochs.some((epoch, index) => epoch.workerEpoch !== index + 1)) invalid();
  for (const [index, request] of summary.requests.entries()) {
    if (request.scenario !== scenarios[index] || request.requestId !== runId + '-' + request.scenario) invalid();
    switch (request.status) {
    case 'settled': if (request.outcome === undefined || request.settledCompleteness === undefined || request.notStartedReason !== undefined) invalid(); break;
    case 'awaiting-settlement': if (request.outcome !== undefined || request.settledCompleteness !== undefined || request.notStartedReason !== undefined) invalid(); break;
    case 'not-started': if (request.outcome !== undefined || request.settledCompleteness !== undefined || request.notStartedReason === undefined) invalid(); break;
    default: { const exhaustive: never = request.status; throw new Error('Unhandled request summary: ' + exhaustive); }
    }
  }
  const active = summary.providerProgress.activeRequest;
  const awaiting = summary.requests.filter(request => request.status === 'awaiting-settlement');
  if (awaiting.length > 1 || (awaiting.length === 1) !== (active !== undefined)
    || (awaiting.length === 1 && providerProgress.run.status !== 'running')) invalid();
  if (active !== undefined && (active.runId !== runId || !summary.requests.some(request => request.requestId === active.requestId && request.scenario === active.scenario && request.status === 'awaiting-settlement'))) invalid();
  if ((completion === 'completed') !== (summary.stopReason === undefined)) invalid();
  return summary;
}

export function createProductionProviderInvestigationSummaryEvidence({ summary, runId, modelId }: { summary: Summary; runId: string; modelId: string }): { json: string } {
  try {
    inspectData({ value: summary });
    const encoded = encodedSchema.parse(encode({ summary }));
    decode({ encoded, runId, modelId });
    const json = JSON.stringify({ format: 'production-provider-investigation-summary-evidence-v1', summary: encoded }, undefined, 2);
    if (json.length > maximumCharacters) invalid();
    return { json };
  } catch {
    return invalid();
  }
}

export function readProductionProviderInvestigationSummaryEvidence({ json, runId, modelId }: { json: string; runId: string; modelId: string }): Summary {
  try {
    if (json.length > maximumCharacters) invalid();
    const envelope = z.object({ format: z.literal('production-provider-investigation-summary-evidence-v1'), summary: encodedSchema }).strict().parse(JSON.parse(json));
    return decode({ encoded: envelope.summary, runId, modelId });
  } catch {
    return invalid();
  }
}

export const TEST_ONLY = {
};
