import { z } from 'zod';
import { downloadedModelRevisionSelectionSchema } from '@/features/transformers-js/runtime/downloaded-model-revision-selection';
import { generationCaptureReadResultSchema, generationCaptureReadRequestSchema, type GenerationCaptureReadResult, type GenerationCaptureClientLifetime } from '@/features/transformers-js/worker/generation-capture-protocol';
import { productionLoadIdentitySchema } from '@/features/transformers-js/worker/load-identity';
import { productionLoadObservationSchema, type ProductionLoadObservation } from '@/features/transformers-js/worker/load-receipt';
import { productionLoadReceiptRevisionOption } from '@/features/transformers-js/runtime/production-load-receipt';
import { normalizeTransformersJsProductionModelId } from '@/features/transformers-js/production-routing';
import type { ProductionProviderNativeCollectionSnapshot } from './production-provider-generation-capture-owner';
import type { ProductionProviderCaptureSnapshot } from './production-provider-capture-owner';
import { createProductionProviderCaptureEvidence, readProductionProviderCaptureEvidence } from './production-provider-capture-evidence';

type Native = Extract<GenerationCaptureReadResult, { status: 'captured' }>['capture'];
type Event = Native['events'][number];
type TensorSnapshot = Extract<Event, { kind: 'sequence' }>['snapshot'];
type Settings = Extract<Event, { kind: 'settings' }>['value'];
type Epoch = ProductionProviderNativeCollectionSnapshot['epochs'][number];
type Check = ({ value }: { value: unknown }) => void;
export const PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES = 64 * 1024 * 1024;
const maximumTensorBytes = PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES;
export const PRODUCTION_PROVIDER_NATIVE_EVIDENCE_PATH = 'generation-native/capture.json';
export const productionProviderNativeCaptureReferenceSchema = z.object({ format: z.literal('production-provider-native-reference-v1'), path: z.literal(PRODUCTION_PROVIDER_NATIVE_EVIDENCE_PATH) }).strict();
const summaryCount = z.number().int().nonnegative().safe();
const nativeRecordingSummarySchema = z.object({
  phase: z.enum(['not-requested', 'collecting', 'finished']), refusedEpochCount: summaryCount,
  recording: z.enum(['recorded', 'partial', 'not-recorded']),
  capturedCallCount: summaryCount, enteredNativeInvocationCount: summaryCount, issuedNotObservedCallCount: summaryCount,
  unavailableEpochCount: summaryCount, incompleteEpochCount: summaryCount,
  unobservedLoadCount: summaryCount, incompleteInvocationCount: summaryCount, unrecordedValueCount: summaryCount,
}).strict();
export interface ProductionProviderNativeEvidenceSidecar {
  readonly path: typeof PRODUCTION_PROVIDER_NATIVE_EVIDENCE_PATH;
  readonly json: string;
  readonly reference: Readonly<z.infer<typeof productionProviderNativeCaptureReferenceSchema>>;
  readonly summary: Readonly<z.infer<typeof nativeRecordingSummarySchema>>;
  readonly binaries: readonly { readonly path: string; readonly blob: Blob; readonly byteLength: number; readonly sha256: string }[];
}
export const nativeBinaryReferenceSchema = z.object({ path: z.string().regex(/^generation-native\/tensors\/[0-9]{6}\.bin$/u), byteLength: z.number().int().nonnegative().max(16 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const referenceSchema = nativeBinaryReferenceSchema;
class ExportRefusal extends Error {}

const lifetimeSchema = z.object({ runId: z.string(), workerEpoch: z.number().int().positive(), session: z.enum(['active', 'inactive']), issuedCalls: z.array(generationCaptureReadRequestSchema.extend({ requestId: z.string().min(1).max(128), generationCallId: z.number().int().positive() })).max(32), loadRequests: z.array(z.object({ requestedModelId: z.string().max(256), requestedRevision: z.string().max(128).optional(), revisionSelection: downloadedModelRevisionSelectionSchema.optional() }).strict()).max(32), incompleteReasons: z.array(z.enum(['request-unavailable', 'request-invalid', 'call-limit', 'load-limit', 'load-identity-limit'])).max(5) }).strict().transform(value => ({ ...value, loadRequests: value.loadRequests.map(load => ({ ...load, requestedRevision: load.requestedRevision })) }));
const waitingCollectionSchema = z.object({ status: z.enum(['not-requested', 'pending']) }).strict();
const failedCollectionSchema = z.object({ status: z.literal('failed'), reason: z.literal('take-failed') }).strict();
const unavailableCollectionSchema = z.object({ status: z.literal('unavailable'), reason: z.enum(['session-inactive', 'host-state-unavailable']) }).strict();
const collectionSchema = z.union([
  waitingCollectionSchema,
  z.object({ status: z.literal('returned'), result: generationCaptureReadResultSchema }).strict(),
  failedCollectionSchema,
  unavailableCollectionSchema,
]);
const epochSchema = z.object({ workerEpoch: z.number().int().min(1).max(8), lifetime: z.union([z.object({ status: z.literal('observed'), value: lifetimeSchema }).strict(), z.object({ status: z.literal('unavailable') }).strict()]), collection: collectionSchema }).strict();
const nativeCollectionSchema = z.object({ format: z.literal('production-provider-native-collection-v1'), runId: z.string(), maximumWorkerEpochs: z.number().int().min(1).max(8), phase: z.enum(['not-requested', 'collecting', 'finished']), unrecordedWorkerCreations: z.number().int().nonnegative().safe(), incompleteReasons: z.array(z.literal('epoch-limit')).max(1), epochs: z.array(epochSchema).max(8) }).strict();

/** A projection of validated records, not an independent validator or proof of
 * inference success. Fixed stop/forward/KV omissions still prevent certifying
 * replay eligibility even when no additional recording gap is detected. */
function summarizeNativeRecording({ native, refusedEpochs }: { native: ProductionProviderNativeCollectionSnapshot; refusedEpochs: ReadonlySet<number> }): ProductionProviderNativeEvidenceSidecar['summary'] {
  let capturedCallCount = 0;
  let enteredNativeInvocationCount = 0;
  let issuedNotObservedCallCount = 0;
  let unavailableEpochCount = 0;
  let incompleteEpochCount = 0;
  let unobservedLoadCount = 0;
  let incompleteInvocationCount = 0;
  let unrecordedValueCount = 0;
  for (const epoch of native.epochs) {
    const lifetime = (() => {
      switch (epoch.lifetime.status) {
      case 'observed': return epoch.lifetime.value;
      case 'unavailable': return undefined;
      default: { const exhaustive: never = epoch.lifetime; return exhaustive; }
      }
    })();
    const capture = !refusedEpochs.has(epoch.workerEpoch) && epoch.collection.status === 'returned' && epoch.collection.result.status === 'captured' ? epoch.collection.result.capture : undefined;
    if (capture === undefined) unavailableEpochCount++;
    if (lifetime === undefined || lifetime.incompleteReasons.length > 0 || (capture !== undefined && capture.incompleteReasons.length > 0)) incompleteEpochCount++;
    issuedNotObservedCallCount += lifetime?.issuedCalls.filter(issued => !capture?.calls.some(call => sameContext({ left: call.context, right: issued }))).length ?? 0;
    if (capture === undefined) continue;
    capturedCallCount += capture.calls.length;
    for (const call of capture.calls) {
      switch (call.loadIdentity.status) {
      case 'ready': break;
      case 'not-observed': unobservedLoadCount++; break;
      default: { const exhaustive: never = call.loadIdentity; return exhaustive; }
      }
      for (const invocation of call.invocations) {
        const events = capture.events.filter(event => sameContext({ left: event.identity, right: call.context }) && event.identity.nativeInvocationOrdinal === invocation.nativeInvocationOrdinal);
        const entered = events.some(event => event.kind === 'native-call' && event.phase === 'entering');
        if (entered) enteredNativeInvocationCount++;
        const fulfilled = events.some(event => event.kind === 'native-call' && event.phase === 'fulfilled');
        const rejected = events.some(event => event.kind === 'native-call' && event.phase === 'rejected');
        if (!entered || (!fulfilled && !rejected)
          || !events.some(event => event.kind === 'settings')
          || !events.some(event => event.kind === 'inputs' && event.phase === 'native-kwargs')
          || (fulfilled && !events.some(event => event.kind === 'sequence'))
          || invocation.stream.status !== 'available' || invocation.stream.restoration !== 'restored') incompleteInvocationCount++;
      }
    }
    for (const event of capture.events) {
      switch (event.kind) {
      // The recorder deliberately excludes live streamers/settings/KV objects
      // from tensor copying. Those fixed policy exclusions are not capture loss.
      case 'inputs': unrecordedValueCount += event.values.filter(value => value.snapshot.status === 'not-recorded' && value.snapshot.reason !== 'excluded-field').length; break;
      case 'sequence':
        switch (event.snapshot.status) {
        case 'captured': case 'scalar': case 'image-sizes': break;
        case 'not-recorded': unrecordedValueCount++; break;
        default: { const exhaustive: never = event.snapshot; return exhaustive; }
        }
        break;
      case 'native-stream':
        switch (event.detail.kind) {
        case 'tokens': case 'finalized-text': case 'none': break;
        case 'not-recorded': unrecordedValueCount++; break;
        default: { const exhaustive: never = event.detail; return exhaustive; }
        }
        break;
      case 'settings': {
        const { requested, kwargs } = event.value;
        unrecordedValueCount += [requested.maxCompletionTokens, requested.temperature, requested.topP,
          kwargs.maxNewTokens, kwargs.temperature, kwargs.topP, kwargs.doSample, kwargs.returnDictInGenerate].filter(value => value.status === 'not-recorded').length;
        switch (kwargs.keys.status) {
        case 'complete': break;
        case 'incomplete': unrecordedValueCount++; break;
        default: { const exhaustive: never = kwargs.keys.status; return exhaustive; }
        }
        break;
      }
      case 'native-call': case 'chunk': break;
      default: { const exhaustive: never = event; return exhaustive; }
      }
    }
  }
  const partial = native.phase !== 'finished' || native.unrecordedWorkerCreations > 0 || native.incompleteReasons.length > 0
    || refusedEpochs.size > 0 || issuedNotObservedCallCount > 0 || unavailableEpochCount > 0 || incompleteEpochCount > 0
    || unobservedLoadCount > 0 || incompleteInvocationCount > 0 || unrecordedValueCount > 0;
  return Object.freeze({ phase: native.phase, refusedEpochCount: refusedEpochs.size,
    recording: enteredNativeInvocationCount === 0 ? 'not-recorded' : partial ? 'partial' : 'recorded',
    capturedCallCount, enteredNativeInvocationCount, issuedNotObservedCallCount, unavailableEpochCount, incompleteEpochCount,
    unobservedLoadCount, incompleteInvocationCount, unrecordedValueCount });
}

function invalid(): never {
  throw new Error('Invalid native capture evidence');
}
function scalar({ value }: { value: unknown }): void {
  if (value !== undefined && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') invalid();
}
function data({ value, key }: { value: unknown; key: string }): unknown {
  if (value === null || typeof value !== 'object') return invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor)) return invalid();
  return descriptor.value as unknown;
}
function discriminant<Kind extends string>({ value, key, variants }: { value: unknown; key: string; variants: Record<Kind, true> }): Kind {
  const kind = data({ value, key });
  if (typeof kind !== 'string' || !Object.hasOwn(variants, kind)) invalid();
  return kind as Kind;
}
// Exact mapped keys force review when any protocol field is added, including
// optional fields. Values are inspected only after rejecting extra/accessor keys.
function record<T>({ value, fields, optional }: { value: unknown; fields: { [Key in keyof T]-?: Check }; optional: readonly (keyof T)[] }): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== 'string' || !Object.hasOwn(fields, key))) invalid();
  for (const key of keys) if (!('value' in Object.getOwnPropertyDescriptor(value, key)!)) invalid();
  for (const key of Object.keys(fields) as (keyof T & string)[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) {
      if (!optional.includes(key)) invalid();
    } else {
      if (!('value' in descriptor)) invalid();
      fields[key]({ value: descriptor.value });
    }
  }
}
function array({ check, maximum }: { check: Check; maximum: number }): Check {
  return ({ value }) => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) invalid();
    if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
    for (let index = 0; index < value.length; ++index) check({ value: data({ value, key: String(index) }) });
  };
}
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const offsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const lengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const ordinaryLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
function byteView({ value }: { value: unknown }): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Uint8Array.prototype) invalid();
  // Opaque binary leaf: never enumerate millions of numeric properties or copy
  // arbitrary attached properties. Intrinsics read only the exact byte window.
  for (const key of ['buffer', 'byteOffset', 'byteLength', 'toJSON']) if (Object.hasOwn(value, key)) invalid();
  const buffer = Reflect.apply(bufferGetter, value, []) as ArrayBuffer;
  Reflect.apply(ordinaryLengthGetter, buffer, []);
  return new Uint8Array(buffer, Reflect.apply(offsetGetter, value, []) as number, Reflect.apply(lengthGetter, value, []) as number);
}
function createDescriptorChecks() {
  // Count repeated references repeatedly: Zod/JSON expands each occurrence.
  // These are whole-export limits, distinct from each recorder's own limits.
  const budget = { nodes: 0, text: 0, tensors: 0, events: 0, tokens: 0 };
  let headersOnly = false;
  const refusals = new Map<number, string>();
  const replacements = new Map<number, Native>();
  function charge({ kind, amount }: { kind: keyof typeof budget; amount: number }): void {
    if (headersOnly) return;
    const maxima = { nodes: 500000, text: 8 * 1024 * 1024, tensors: maximumTensorBytes, events: 4096, tokens: 262144 } satisfies Record<keyof typeof budget, number>;
    budget[kind] += amount;
    if (budget[kind] > maxima[kind]) throw new ExportRefusal('native-export-budget');
  }
  function boundedScalar({ value }: { value: unknown }): void {
    scalar({ value });
    if (typeof value === 'string') {
      if (value.length > 8 * 1024 * 1024) throw new ExportRefusal('native-export-budget');
      charge({ kind: 'text', amount: new TextEncoder().encode(value).byteLength });
    }
  }
  function boundedArray({ check, maximum }: { check: Check; maximum: number }): Check {
    return array({ maximum, check: ({ value }) => {
      charge({ kind: 'nodes', amount: 1 }); check({ value });
    } });
  }
  const contextCheck: Check = ({ value }) => record<Native['calls'][number]['context']>({ value, fields: { runId: scalar, workerEpoch: scalar, requestId: scalar, generationCallId: scalar }, optional: [] });
  const identityCheck: Check = ({ value }) => record<Event['identity']>({ value, fields: { runId: scalar, workerEpoch: scalar, requestId: scalar, generationCallId: scalar, nativeInvocationOrdinal: scalar }, optional: [] });
  const loadIdentityCheck: Check = ({ value }) => {
  type Load = z.infer<typeof productionLoadIdentitySchema>;
  switch (discriminant<Load['status']>({ value, key: 'status', variants: { ready: true, 'not-observed': true } })) {
  case 'not-observed': record<Extract<Load, { status: 'not-observed' }>>({ value, fields: { status: scalar, reason: scalar }, optional: [] }); break;
  case 'ready': record<Extract<Load, { status: 'ready' }>>({ value, fields: {
    status: scalar, workerLoadOrdinal: scalar, requestedModelId: scalar, cleanModelId: scalar, autoClass: scalar, processor: scalar,
    requestedRevision: ({ value }) => {
      type Revision = Extract<Load, { status: 'ready' }>['requestedRevision'];
      switch (discriminant<Revision['status']>({ value, key: 'status', variants: { provided: true, omitted: true } })) {
      case 'provided': record<Extract<Revision, { status: 'provided' }>>({ value, fields: { status: scalar, value: scalar }, optional: [] }); break;
      case 'omitted': record<Extract<Revision, { status: 'omitted' }>>({ value, fields: { status: scalar }, optional: [] }); break;
      default: invalid();
      }
    },
    selectedCandidate: ({ value }) => record<Extract<Load, { status: 'ready' }>['selectedCandidate']>({ value, fields: { device: scalar, dtype: scalar }, optional: [] }),
    resolvedRevision: ({ value }) => record<Extract<Load, { status: 'ready' }>['resolvedRevision']>({ value, fields: { status: scalar }, optional: [] }),
    sessionExecutionProvider: ({ value }) => record<Extract<Load, { status: 'ready' }>['sessionExecutionProvider']>({ value, fields: { status: scalar }, optional: [] }),
  }, optional: [] }); break;
  default: invalid();
  }
  };
  const tensorCheck: Check = ({ value }) => {
    switch (discriminant<TensorSnapshot['status']>({ value, key: 'status', variants: { captured: true, scalar: true, 'image-sizes': true, 'not-recorded': true } })) {
    case 'captured': record<Extract<TensorSnapshot, { status: 'captured' }>>({ value, fields: { status: boundedScalar, dtype: boundedScalar, dims: boundedArray({ check: boundedScalar, maximum: 8 }), byteLength: boundedScalar, bytes: ({ value }) => {
      charge({ kind: 'tensors', amount: byteView({ value }).byteLength });
    } }, optional: [] }); break;
    case 'scalar': record<Extract<TensorSnapshot, { status: 'scalar' }>>({ value, fields: { status: boundedScalar, values: boundedArray({ check: boundedScalar, maximum: 8 }) }, optional: [] }); break;
    case 'image-sizes': record<Extract<TensorSnapshot, { status: 'image-sizes' }>>({ value, fields: { status: boundedScalar, values: boundedArray({ check: boundedArray({ check: boundedScalar, maximum: 2 }), maximum: 8 }) }, optional: [] }); break;
    case 'not-recorded': record<Extract<TensorSnapshot, { status: 'not-recorded' }>>({ value, fields: { status: boundedScalar, reason: boundedScalar }, optional: [] }); break;
    default: invalid();
    }
  };
  const propertyCheck: Check = ({ value }) => {
  type Property = Settings['requested']['temperature'];
  switch (discriminant<Property['status']>({ value, key: 'status', variants: { omitted: true, undefined: true, null: true, value: true, 'not-recorded': true } })) {
  case 'omitted': case 'undefined': case 'null': record<Extract<Property, { status: 'omitted' | 'undefined' | 'null' }>>({ value, fields: { status: boundedScalar }, optional: [] }); break;
  case 'value': record<Extract<Property, { status: 'value' }>>({ value, fields: { status: boundedScalar, value: boundedScalar }, optional: [] }); break;
  case 'not-recorded': record<Extract<Property, { status: 'not-recorded' }>>({ value, fields: { status: boundedScalar, reason: boundedScalar }, optional: [] }); break;
  default: invalid();
  }
  };
  const settingsCheck: Check = ({ value }) => record<Settings>({ value, fields: {
    requested: ({ value }) => record<Settings['requested']>({ value, fields: { maxCompletionTokens: propertyCheck, temperature: propertyCheck, topP: propertyCheck }, optional: [] }),
    budget: ({ value }) => record<Settings['budget']>({ value, fields: { maxNewTokens: boundedScalar, source: boundedScalar, contextLimit: boundedScalar, promptTokenCount: boundedScalar, pastTokenCount: boundedScalar, usedContextTokenCount: boundedScalar }, optional: ['maxNewTokens', 'contextLimit', 'promptTokenCount', 'usedContextTokenCount'] }),
    kwargs: ({ value }) => record<Settings['kwargs']>({ value, fields: {
      keys: ({ value }) => record<Settings['kwargs']['keys']>({ value, fields: { status: boundedScalar, totalCount: boundedScalar, values: boundedArray({ check: boundedScalar, maximum: 64 }), incompleteReasons: boundedArray({ check: boundedScalar, maximum: 3 }) }, optional: [] }),
      maxNewTokens: propertyCheck, temperature: propertyCheck, topP: propertyCheck, doSample: propertyCheck, returnDictInGenerate: propertyCheck,
    }, optional: [] }),
  }, optional: [] });
  const streamCheck: Check = ({ value }) => {
  type Stream = Native['calls'][number]['invocations'][number]['stream'];
  switch (discriminant<Stream['status']>({ value, key: 'status', variants: { 'not-attempted': true, available: true, unavailable: true } })) {
  case 'not-attempted': record<Extract<Stream, { status: 'not-attempted' }>>({ value, fields: { status: scalar }, optional: [] }); break;
  case 'available': record<Extract<Stream, { status: 'available' }>>({ value, fields: { status: scalar, restoration: scalar }, optional: [] }); break;
  case 'unavailable': record<Extract<Stream, { status: 'unavailable' }>>({ value, fields: { status: scalar, reason: scalar }, optional: [] }); break;
  default: invalid();
  }
  };
  const detailCheck: Check = ({ value }) => {
  type Detail = Extract<Event, { kind: 'native-stream' }>['detail'];
  switch (discriminant<Detail['kind']>({ value, key: 'kind', variants: { tokens: true, 'finalized-text': true, none: true, 'not-recorded': true } })) {
  case 'tokens': record<Extract<Detail, { kind: 'tokens' }>>({ value, fields: { kind: boundedScalar, tokenType: boundedScalar, groups: boundedArray({ check: boundedArray({ check: ({ value }) => {
    charge({ kind: 'tokens', amount: 1 }); boundedScalar({ value });
  }, maximum: 65536 }), maximum: 8 }) }, optional: [] }); break;
  case 'finalized-text': record<Extract<Detail, { kind: 'finalized-text' }>>({ value, fields: { kind: boundedScalar, text: boundedScalar, streamEnd: boundedScalar }, optional: [] }); break;
  case 'none': record<Extract<Detail, { kind: 'none' }>>({ value, fields: { kind: boundedScalar }, optional: [] }); break;
  case 'not-recorded': record<Extract<Detail, { kind: 'not-recorded' }>>({ value, fields: { kind: boundedScalar, reason: boundedScalar }, optional: [] }); break;
  default: invalid();
  }
  };
  const eventChecks = {
    'native-stream': ({ value }) => record<Extract<Event, { kind: 'native-stream' }>>({ value, fields: { kind: boundedScalar, identity: identityCheck, operation: boundedScalar, phase: boundedScalar, streamCallOrdinal: boundedScalar, detail: detailCheck }, optional: [] }),
    'native-call': ({ value }) => record<Extract<Event, { kind: 'native-call' }>>({ value, fields: { kind: boundedScalar, identity: identityCheck, phase: boundedScalar }, optional: [] }),
    inputs: ({ value }) => record<Extract<Event, { kind: 'inputs' }>>({ value, fields: { kind: boundedScalar, identity: identityCheck, phase: boundedScalar, values: boundedArray({ maximum: 64, check: ({ value }) => record<Extract<Event, { kind: 'inputs' }>['values'][number]>({ value, fields: { name: boundedScalar, snapshot: tensorCheck }, optional: [] }) }) }, optional: [] }),
    sequence: ({ value }) => record<Extract<Event, { kind: 'sequence' }>>({ value, fields: { kind: boundedScalar, identity: identityCheck, resultShape: boundedScalar, snapshot: tensorCheck }, optional: [] }),
    settings: ({ value }) => record<Extract<Event, { kind: 'settings' }>>({ value, fields: { kind: boundedScalar, identity: identityCheck, value: settingsCheck }, optional: [] }),
    chunk: ({ value }) => record<Extract<Event, { kind: 'chunk' }>>({ value, fields: { kind: boundedScalar, identity: identityCheck, phase: boundedScalar, text: boundedScalar }, optional: [] }),
  } satisfies Record<Event['kind'], Check>;
  const nativeCheck: Check = ({ value }) => record<Native>({ value, fields: {
    schemaVersion: scalar, runId: scalar, workerEpoch: scalar, byteOrder: scalar,
    limits: ({ value }) => record<Native['limits']>({ value, fields: { maxCalls: scalar, maxInvocationsPerCall: scalar, maxEvents: scalar, maxTextBytes: scalar, maxTensorBytes: scalar, maxTotalTensorBytes: scalar, maxTokensPerStreamEvent: scalar, maxTotalStreamTokens: scalar, maxTotalStreamTokenBytes: scalar }, optional: [] }),
    calls: array({ maximum: 32, check: ({ value }) => record<Native['calls'][number]>({ value, fields: { context: contextCheck, loadIdentity: loadIdentityCheck, outcome: scalar, invocations: array({ maximum: 8, check: ({ value }) => record<Native['calls'][number]['invocations'][number]>({ value, fields: { nativeInvocationOrdinal: scalar, stream: streamCheck }, optional: [] }) }) }, optional: [] }) }),
    events: array({ maximum: 4096, check: ({ value }) => {
      charge({ kind: 'events', amount: 1 });
      const kind = data({ value, key: 'kind' }); if (typeof kind !== 'string' || !Object.hasOwn(eventChecks, kind)) invalid(); eventChecks[kind as Event['kind']]({ value });
    } }),
    incompleteReasons: array({ check: scalar, maximum: 32 }), unobserved: array({ check: scalar, maximum: 32 }),
  }, optional: [] });
  const revisionSelectionCheck: Check = ({ value }) => record<{ kind: 'pinned' | 'discover-cached'; revision?: string }>({
    value, fields: { kind: scalar, revision: scalar }, optional: ['revision'],
  });
  const lifetimeCheck: Check = ({ value }) => record<GenerationCaptureClientLifetime>({ value, fields: { runId: scalar, workerEpoch: scalar, session: scalar, issuedCalls: array({ check: contextCheck, maximum: 32 }), loadRequests: array({ maximum: 32, check: ({ value }) => record<GenerationCaptureClientLifetime['loadRequests'][number]>({ value, fields: { requestedModelId: scalar, requestedRevision: scalar, revisionSelection: revisionSelectionCheck }, optional: ['revisionSelection'] }) }), incompleteReasons: array({ check: scalar, maximum: 5 }) }, optional: [] });
  const resultCheck: Check = ({ value }) => {
    const loadObservationCheck: Check = ({ value }) => {
      function inspect({ value, depth }: { value: unknown; depth: number }): void {
        if (depth > 8) invalid();
        if (value === undefined || typeof value === 'string' || typeof value === 'number') {
          scalar({ value }); return;
        }
        if (Array.isArray(value)) {
          array({ maximum: 256, check: ({ value }) => inspect({ value, depth: depth + 1 }) })({ value }); return;
        }
        if (value === null || typeof value !== 'object') invalid();
        const keys = Reflect.ownKeys(value);
        if (keys.length > 20) invalid();
        for (const key of keys) {
          if (typeof key !== 'string') invalid();
          inspect({ value: data({ value, key }), depth: depth + 1 });
        }
      }
      inspect({ value, depth: 0 });
      if (value !== undefined) productionLoadObservationSchema.parse(value);
    };
    switch (discriminant<GenerationCaptureReadResult['status']>({ value, key: 'status', variants: { captured: true, 'not-started': true, 'invalid-context': true, 'wrong-run': true, busy: true, 'already-taken': true } })) {
    case 'captured': record<Extract<GenerationCaptureReadResult, { status: 'captured' }>>({ value, fields: { status: scalar, capture: nativeCheck, loadObservation: loadObservationCheck }, optional: ['loadObservation'] }); break;
    case 'not-started': record<Extract<GenerationCaptureReadResult, { status: 'not-started' }>>({ value, fields: { status: scalar, loadObservation: loadObservationCheck }, optional: ['loadObservation'] }); break;
    case 'invalid-context': case 'wrong-run': case 'busy': case 'already-taken': record<{ status: string }>({ value, fields: { status: scalar }, optional: [] }); break;
    default: invalid();
    }
  };
  const collectionCheck: Check = ({ value }) => {
    switch (discriminant<Epoch['collection']['status']>({ value, key: 'status', variants: { 'not-requested': true, pending: true, returned: true, failed: true, unavailable: true } })) {
    case 'not-requested': case 'pending': record<Extract<Epoch['collection'], { status: 'not-requested' | 'pending' }>>({ value, fields: { status: scalar }, optional: [] }); break;
    case 'returned': record<Extract<Epoch['collection'], { status: 'returned' }>>({ value, fields: { status: scalar, result: resultCheck }, optional: [] }); break;
    case 'failed': case 'unavailable': record<Extract<Epoch['collection'], { status: 'failed' | 'unavailable' }>>({ value, fields: { status: scalar, reason: scalar }, optional: [] }); break;
    default: invalid();
    }
  };
  function preflight({ value }: { value: unknown }): ProductionProviderNativeCollectionSnapshot {
    record<ProductionProviderNativeCollectionSnapshot>({ value, fields: { format: scalar, runId: scalar, maximumWorkerEpochs: scalar, phase: scalar, unrecordedWorkerCreations: scalar, incompleteReasons: array({ check: scalar, maximum: 1 }), epochs: array({ maximum: 8, check: ({ value }) => {
      const before = { ...budget };
      try {
        checkEpoch({ value });
      } catch (error) {
        if (!(error instanceof ExportRefusal)) throw error;
        Object.assign(budget, before);
        const epoch = data({ value, key: 'workerEpoch' });
        if (typeof epoch !== 'number') invalid();
        const collection = data({ value, key: 'collection' });
        const result = data({ value: collection, key: 'result' });
        const capture = data({ value: result, key: 'capture' });
        // Validate the small identity/header independently. Refused payloads are
        // never parsed, hashed, copied, or claimed to be validated captures.
        const captureHeader = { ...(capture as Native), events: [] };
        const safeEpoch = { ...(value as Epoch), collection: { status: 'returned', result: { status: 'captured', capture: captureHeader } } };
        headersOnly = true;
        try {
          checkEpoch({ value: safeEpoch });
        } finally {
          headersOnly = false;
        }
        replacements.set(epoch, captureHeader);
        refusals.set(epoch, 'native-export-budget');
      }
    } }) }, optional: [] });
    const native = value as ProductionProviderNativeCollectionSnapshot;
    return { ...native, epochs: native.epochs.map(epoch => replacements.has(epoch.workerEpoch)
      ? { ...epoch, collection: { status: 'returned', result: { status: 'captured', capture: replacements.get(epoch.workerEpoch)! } } }
      : epoch) };
  }
  function checkEpoch({ value }: { value: unknown }): void {
    record<Epoch>({ value, fields: { workerEpoch: scalar, lifetime: ({ value }) => {
      switch (discriminant<Epoch['lifetime']['status']>({ value, key: 'status', variants: { observed: true, unavailable: true } })) {
      case 'observed': record<Extract<Epoch['lifetime'], { status: 'observed' }>>({ value, fields: { status: scalar, value: lifetimeCheck }, optional: [] }); break;
      case 'unavailable': record<Extract<Epoch['lifetime'], { status: 'unavailable' }>>({ value, fields: { status: scalar }, optional: [] }); break;
      default: invalid();
      }
    }, collection: collectionCheck }, optional: [] });
  }
  return { preflight, nativeCollectionSchema, refusals };
}

const publicKeys = new Set(['input_ids', 'attention_mask', 'decoder_input_ids', 'decoder_attention_mask', 'pixel_values', 'image_position_ids', 'image_grid_thw', 'video_grid_thw', 'original_sizes', 'reshaped_input_sizes', 'num_soft_tokens_per_image', 'past_key_values', 'max_new_tokens', 'temperature', 'top_p', 'do_sample', 'streamer', 'stopping_criteria', 'return_dict_in_generate']);
function hasUnknownNativeKeys({ capture }: { capture: Native }): boolean {
  return capture.events.some(event => (event.kind === 'inputs' && event.values.some(value => !publicKeys.has(value.name)))
    || (event.kind === 'settings' && event.value.kwargs.keys.values.some(key => !publicKeys.has(key))));
}
type Binary = { path: string; bytes: Uint8Array<ArrayBuffer>; byteLength: number; sha256: string };
const undefinedValue = { captureValue: 'undefined' as const };
function snapshots({ event }: { event: Event }): TensorSnapshot[] {
  switch (event.kind) {
  case 'inputs': return event.values.map(value => value.snapshot);
  case 'sequence': return [event.snapshot];
  case 'settings': case 'chunk': case 'native-call': case 'native-stream': return [];
  default: { const exhaustive: never = event; return exhaustive; }
  }
}
function sameContext({ left, right }: { left: Native['calls'][number]['context']; right: Native['calls'][number]['context'] }): boolean {
  const { runId, workerEpoch, requestId, generationCallId, ...rest } = left; rest satisfies Record<PropertyKey, never>;
  return runId === right.runId && workerEpoch === right.workerEpoch && requestId === right.requestId && generationCallId === right.generationCallId;
}

type CollectionProgress = {
  runId: string;
  maximumWorkerEpochs: number;
  unrecordedWorkerCreations: number;
  incompleteReasons: readonly string[];
  phase: ProductionProviderNativeCollectionSnapshot['phase'];
  epochs: readonly { collection: { status: Epoch['collection']['status'] | 'export-refused' } }[];
};
function validateCollectionProgress({ snapshot, provider }: { snapshot: CollectionProgress; provider: ProductionProviderCaptureSnapshot }): void {
  if (snapshot.runId !== provider.runId || snapshot.epochs.length > snapshot.maximumWorkerEpochs
    || (snapshot.unrecordedWorkerCreations > 0) !== snapshot.incompleteReasons.includes('epoch-limit')) invalid();
  switch (snapshot.phase) {
  case 'not-requested': if (snapshot.epochs.some(epoch => epoch.collection.status !== 'not-requested')) invalid(); break;
  case 'collecting': case 'finished': {
    if (provider.run.status !== 'completed' && provider.run.status !== 'stopped') invalid();
    let pending = 0;
    let remaining = false;
    for (const epoch of snapshot.epochs) {
      switch (epoch.collection.status) {
      case 'pending': if (remaining || ++pending > 1) invalid(); remaining = true; break;
      case 'not-requested': remaining = true; break;
      case 'returned': case 'failed': case 'unavailable': case 'export-refused': if (remaining) invalid(); break;
      default: { const exhaustive: never = epoch.collection.status; return exhaustive; }
      }
    }
    if ((snapshot.phase === 'finished' && remaining) || (snapshot.phase === 'collecting' && pending !== 1)) invalid();
    break;
  }
  default: { const exhaustive: never = snapshot.phase; return exhaustive; }
  }
}

function validateEpochLifetime({ epoch, index, provider }: { epoch: Pick<Epoch, 'workerEpoch' | 'lifetime'>; index: number; provider: ProductionProviderCaptureSnapshot }): GenerationCaptureClientLifetime | undefined {
  if (epoch.workerEpoch !== index + 1) invalid();
  switch (epoch.lifetime.status) {
  case 'unavailable': return undefined;
  case 'observed': {
    const lifetime = epoch.lifetime.value;
    if (lifetime.runId !== provider.runId || lifetime.workerEpoch !== epoch.workerEpoch
      || lifetime.issuedCalls.some((call, index) => call.runId !== provider.runId || call.workerEpoch !== epoch.workerEpoch || call.generationCallId !== index + 1
        || !provider.requests.some(request => request.requestId === call.requestId && request.status !== 'not-started'))
      || lifetime.loadRequests.some(load => load.requestedModelId !== provider.modelId)) invalid();
    return lifetime;
  }
  default: { const exhaustive: never = epoch.lifetime; return exhaustive; }
  }
}

function validateLoadObservation({ epoch, lifetime, provider }: { epoch: Epoch; lifetime: GenerationCaptureClientLifetime | undefined; provider: ProductionProviderCaptureSnapshot }): void {
  switch (epoch.collection.status) {
  case 'returned': break;
  case 'not-requested': case 'pending': case 'failed': case 'unavailable': return;
  default: { const exhaustive: never = epoch.collection; throw new Error('Unknown native collection: ' + exhaustive); }
  }
  const result = epoch.collection.result;
  if (result.status !== 'captured' && result.status !== 'not-started') return;
  const observation = result.loadObservation;
  if (observation === undefined) return;
  validateCorrelatedLoadObservation({ observation, lifetime, provider, workerEpoch: epoch.workerEpoch });
}

function validateCorrelatedLoadObservation({ observation, lifetime, provider, workerEpoch }: {
  observation: ProductionLoadObservation; lifetime: GenerationCaptureClientLifetime | undefined; provider: ProductionProviderCaptureSnapshot; workerEpoch: number;
}): void {
  if (lifetime === undefined) invalid();
  switch (lifetime.session) {
  case 'active': break;
  case 'inactive': return invalid();
  default: { const exhaustive: never = lifetime.session; throw new Error('Unknown receipt owner lifetime: ' + exhaustive); }
  }
  const load = lifetime.loadRequests[observation.loadOrdinal - 1];
  if (load === undefined || observation.owner.runId !== provider.runId || observation.owner.workerEpoch !== workerEpoch) invalid();
  switch (observation.outcome.status) {
  case 'accepted': {
    const receipt = observation.outcome.receipt;
    const revision = productionLoadReceiptRevisionOption({ option: receipt.loaderRevisionOption });
    if (receipt.modelId !== normalizeTransformersJsProductionModelId({ modelId: load.requestedModelId })) invalid();
    const selection = load.revisionSelection;
    if (selection === undefined) {
      // Historical captures requested one pinned namespace. Never reinterpret
      // those bytes as cache discovery merely because the new API supports it.
      if (revision !== load.requestedRevision) invalid();
    } else {
      switch (selection.kind) {
      case 'pinned':
        if (selection.revision !== load.requestedRevision || revision !== selection.revision) invalid();
        break;
      case 'discover-cached':
        if (load.requestedRevision !== undefined) invalid();
        // Discovery did not request a SHA; the actual accepted receipt owns it.
        break;
      default: { const exhaustive: never = selection; return exhaustive; }
      }
    }
    break;
  }
  case 'loading': case 'failed': case 'cleared': case 'not-recorded': break;
  default: { const exhaustive: never = observation.outcome; return exhaustive; }
  }
}

/** Read only the independently typed Load receipts from a retained native index.
 * Tensor/native event integrity remains the existing sidecar verifier's job. */
export function readProductionProviderLoadObservations({ json, provider }: { json: string; provider: ProductionProviderCaptureSnapshot }): ProductionLoadObservation[] {
  const envelope = nativeEvidenceEnvelopeSchema.parse(JSON.parse(z.string().max(PRODUCTION_PROVIDER_NATIVE_JSON_MAXIMUM_CHARACTERS).parse(json)) as unknown);
  validateCollectionProgress({ snapshot: envelope, provider });
  const observations: ProductionLoadObservation[] = [];
  for (const [index, epoch] of envelope.epochs.entries()) {
    const lifetime = decodeLifetime({ value: epoch.lifetime });
    const host = validateEpochLifetime({ epoch: { workerEpoch: epoch.workerEpoch, lifetime }, index, provider });
    switch (epoch.collection.status) {
    case 'returned': break;
    case 'not-requested': case 'pending': case 'failed': case 'unavailable': case 'export-refused': continue;
    default: { const exhaustive: never = epoch.collection; throw new Error('Unknown encoded native collection: ' + exhaustive); }
    }
    const result = z.object({ status: z.string(), loadObservation: productionLoadObservationSchema.optional() }).passthrough().parse(epoch.collection.result);
    if (result.loadObservation === undefined) continue;
    if (result.status !== 'captured' && result.status !== 'not-started') invalid();
    validateCorrelatedLoadObservation({ observation: result.loadObservation, lifetime: host, provider, workerEpoch: epoch.workerEpoch });
    observations.push(result.loadObservation);
  }
  return observations;
}

function validateCapturedCalls({ capture, lifetime, workerEpoch, provider }: { capture: Native; lifetime: GenerationCaptureClientLifetime | undefined; workerEpoch: number; provider: ProductionProviderCaptureSnapshot }): GenerationCaptureClientLifetime {
  if (lifetime === undefined || capture.runId !== provider.runId || capture.workerEpoch !== workerEpoch
    || capture.calls.some(call => !lifetime.issuedCalls.some(issued => sameContext({ left: call.context, right: issued })))) invalid();
  const successfulLoads = new Map<number, string>();
  for (const call of capture.calls) {
    switch (call.loadIdentity.status) {
    case 'not-observed': break;
    case 'ready': {
      if (call.loadIdentity.cleanModelId !== normalizeTransformersJsProductionModelId({ modelId: provider.modelId })) invalid();
      // The strict schema owns every primitive field and its canonical key order.
      // Comparing its full output also covers future fields, without invoking
      // arbitrary input serialization or interpreting an unresolved fact.
      const identity = JSON.stringify(productionLoadIdentitySchema.parse(call.loadIdentity));
      const previous = successfulLoads.get(call.loadIdentity.workerLoadOrdinal);
      if (previous !== undefined && previous !== identity) invalid();
      successfulLoads.set(call.loadIdentity.workerLoadOrdinal, identity);
      break;
    }
    default: { const exhaustive: never = call.loadIdentity; return exhaustive; }
    }
  }
  return lifetime;
}

/** The synchronous boundary must not carry source tensor views into hashing. */
function prepareNativeEvidence({ native, provider, maximumBinaryBytes }: { native: ProductionProviderNativeCollectionSnapshot; provider: ProductionProviderCaptureSnapshot; maximumBinaryBytes: number }) {
  try {
    const enclosingBinaryBytes = z.number().int().nonnegative().safe().parse(maximumBinaryBytes);
    const { preflight, nativeCollectionSchema, refusals } = createDescriptorChecks();
    const safeNative = preflight({ value: native });
    const modelId = data({ value: provider, key: 'modelId' });
    if (typeof modelId !== 'string') invalid();
    createProductionProviderCaptureEvidence({ capture: provider, runId: native.runId, modelId });
    const parsed = nativeCollectionSchema.parse(safeNative);
    validateCollectionProgress({ snapshot: parsed, provider });
    const binaries: Binary[] = [];
    const references = new Map<Binary, z.infer<typeof referenceSchema>>();
    let retainedBytes = 0;
    const epochs = parsed.epochs.map((epoch, index) => {
      const lifetime = validateEpochLifetime({ epoch, index, provider });
      validateLoadObservation({ epoch, lifetime, provider });
      const safeLifetime = lifetime === undefined ? epoch.lifetime : { status: 'observed' as const, value: { ...lifetime, loadRequests: lifetime.loadRequests.map(load => ({ ...load, requestedRevision: load.requestedRevision ?? undefinedValue })) } };
      const base = { workerEpoch: epoch.workerEpoch, lifetime: safeLifetime };
      const collection = epoch.collection;
      if (collection.status !== 'returned' || collection.result.status !== 'captured') return { ...base, collection };
      const capture = collection.result.capture;
      const capturedLifetime = validateCapturedCalls({ capture, lifetime, workerEpoch: epoch.workerEpoch, provider });
      const correlation = capturedLifetime.issuedCalls.map(context => ({ context, observation: capture.calls.some(call => sameContext({ left: call.context, right: context })) ? 'observed' : 'issued-not-observed' }));
      const refusal = refusals.get(epoch.workerEpoch);
      if (refusal !== undefined) return { ...base, correlation, collection: { status: 'export-refused', reason: refusal } };
      const unknownKey = hasUnknownNativeKeys({ capture });
      let bytes = 0;
      for (const event of capture.events) for (const snapshot of snapshots({ event })) {
        switch (snapshot.status) {
        case 'captured': bytes += snapshot.byteLength; break;
        case 'scalar': case 'image-sizes': case 'not-recorded': break;
        default: { const exhaustive: never = snapshot; return exhaustive; }
        }
      }
      if (unknownKey || bytes > maximumTensorBytes - retainedBytes) return { ...base, correlation, collection: { status: 'export-refused', reason: unknownKey ? 'unsupported-native-key' : 'run-tensor-byte-limit' } };
      // The enclosing ZIP budget is separate from recorder/run refusal. Exceeding
      // it rejects the export, without omitting a model or copying its tensors.
      if (bytes > enclosingBinaryBytes - retainedBytes) invalid();
      retainedBytes += bytes;
      function encodeTensor({ snapshot }: { snapshot: TensorSnapshot }) {
        switch (snapshot.status) {
        case 'captured': {
          const { bytes: source, status, dtype, dims, byteLength, ...rest } = snapshot;
          rest satisfies Record<PropertyKey, never>;
          const owned = byteView({ value: source }).slice();
          const binary: Binary = { path: `generation-native/tensors/${String(binaries.length + 1).padStart(6, '0')}.bin`, bytes: owned, byteLength: owned.byteLength, sha256: '' };
          binaries.push(binary);
          const reference = { path: binary.path, byteLength: binary.byteLength, sha256: '' };
          references.set(binary, reference);
          return { status, dtype, dims, byteLength, bytes: reference };
        }
        case 'scalar': case 'image-sizes': case 'not-recorded': return snapshot;
        default: { const exhaustive: never = snapshot; return exhaustive; }
        }
      }
      const events = capture.events.map(event => {
        switch (event.kind) {
        case 'inputs': {
          const { kind, identity, phase, values, ...rest } = event; rest satisfies Record<PropertyKey, never>;
          return { kind, identity, phase, values: values.map(({ name, snapshot, ...rest }) => {
            rest satisfies Record<PropertyKey, never>; return { name, snapshot: encodeTensor({ snapshot }) };
          }) };
        }
        case 'sequence': {
          const { kind, identity, resultShape, snapshot, ...rest } = event; rest satisfies Record<PropertyKey, never>;
          return { kind, identity, resultShape, snapshot: encodeTensor({ snapshot }) };
        }
        case 'settings': {
          const { kind, identity, value, ...rest } = event; rest satisfies Record<PropertyKey, never>;
          const { requested, budget, kwargs, ...unhandled } = value; unhandled satisfies Record<PropertyKey, never>;
          const { maxNewTokens, source, contextLimit, promptTokenCount, pastTokenCount, usedContextTokenCount, ...unhandledBudget } = budget;
          unhandledBudget satisfies Record<PropertyKey, never>;
          const optional = ({ key, value }: { key: keyof typeof budget; value: number | undefined }) => Object.hasOwn(budget, key)
            ? { [key]: value ?? undefinedValue } : {};
          return { kind, identity, value: { requested, kwargs, budget: { source, pastTokenCount,
            ...optional({ key: 'maxNewTokens', value: maxNewTokens }), ...optional({ key: 'contextLimit', value: contextLimit }),
            ...optional({ key: 'promptTokenCount', value: promptTokenCount }), ...optional({ key: 'usedContextTokenCount', value: usedContextTokenCount }),
          } } };
        }
        case 'native-stream': {
          const { kind, identity, operation, phase, streamCallOrdinal, detail, ...rest } = event; rest satisfies Record<PropertyKey, never>;
          return { kind, identity, operation, phase, streamCallOrdinal, detail };
        }
        case 'native-call': {
          const { kind, identity, phase, ...rest } = event; rest satisfies Record<PropertyKey, never>;
          return { kind, identity, phase };
        }
        case 'chunk': {
          const { kind, identity, phase, text, ...rest } = event; rest satisfies Record<PropertyKey, never>;
          return { kind, identity, phase, text };
        }
        default: { const exhaustive: never = event; return exhaustive; }
        }
      });
      const { schemaVersion, runId, workerEpoch, byteOrder, limits, calls, incompleteReasons, unobserved, events: _sourceEvents, ...rest } = capture;
      rest satisfies Record<PropertyKey, never>;
      return { ...base, correlation, collection: { status: 'returned', result: { status: 'captured', ...(collection.result.loadObservation === undefined ? {} : { loadObservation: collection.result.loadObservation }), capture: { schemaVersion, runId, workerEpoch, byteOrder, limits, calls, incompleteReasons, unobserved, events } } } };
    });
    const { format: sourceFormat, epochs: _sourceEpochs, ...metadata } = parsed;
    return {
      binaries, references,
      document: { format: 'production-provider-native-evidence-v1', sourceFormat, providerCapture: 'production-provider/capture.json', ...metadata, epochs,
        limitations: { replayEligibility: 'not-established', realModelSuccess: 'not-certified', providerAndNativeSettlement: 'independent-observations' },
      },
      summary: summarizeNativeRecording({ native: parsed, refusedEpochs: new Set(epochs.filter(epoch => epoch.collection.status === 'export-refused').map(epoch => epoch.workerEpoch)) }),
    };
  } catch {
    return invalid();
  }
}

async function sealPreparedNativeEvidence({ prepared }: { prepared: ReturnType<typeof prepareNativeEvidence> }): Promise<ProductionProviderNativeEvidenceSidecar> {
  try {
    const { binaries, references, document, summary, ...rest } = prepared;
    rest satisfies Record<PropertyKey, never>;
    // Only the owned plan crosses this await, not the source Provider/native
    // snapshots or parsed source tensor views. Pending hashing still owns its
    // copies; an adoption deadline is not immediate memory reclamation.
    for (const binary of binaries) {
      const digest = await crypto.subtle.digest('SHA-256', binary.bytes);
      binary.sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
      const reference = references.get(binary)!;
      reference.sha256 = binary.sha256;
      referenceSchema.parse(reference);
    }
    const json = JSON.stringify(document, undefined, 2) + '\n';
    if (json.length > PRODUCTION_PROVIDER_NATIVE_JSON_MAXIMUM_CHARACTERS) invalid();
    return freezeNativeSidecar({ evidence: {
      path: PRODUCTION_PROVIDER_NATIVE_EVIDENCE_PATH, json, binaries: binaries.map(binary => {
        const { path, bytes, byteLength, sha256, ...rest } = binary;
        rest satisfies Record<PropertyKey, never>;
        return { path, blob: new Blob([bytes]), byteLength, sha256 };
      }),
      reference: productionProviderNativeCaptureReferenceSchema.parse({ format: 'production-provider-native-reference-v1', path: PRODUCTION_PROVIDER_NATIVE_EVIDENCE_PATH }),
      summary,
    } });
  } catch {
    return invalid();
  }
}

/** Pure post-run export: no RPC, recording, Provider, Worker or storage authority. */
export function createProductionProviderNativeEvidence({ native, provider, maximumBinaryBytes }: { native: ProductionProviderNativeCollectionSnapshot; provider: ProductionProviderCaptureSnapshot; maximumBinaryBytes: number }): Promise<ProductionProviderNativeEvidenceSidecar> {
  try {
    return sealPreparedNativeEvidence({ prepared: prepareNativeEvidence({ native, provider, maximumBinaryBytes }) });
  } catch (error) {
    // Preserve the Promise-rejection API for synchronous admission failures.
    return Promise.reject(error);
  }
}

const encodedUndefinedSchema = z.object({ captureValue: z.literal('undefined') }).strict();
const correlationSchema = z.array(z.object({
  context: generationCaptureReadRequestSchema.extend({ requestId: z.string().min(1).max(128), generationCallId: z.number().int().positive() }),
  observation: z.enum(['observed', 'issued-not-observed']),
}).strict()).max(32);
const encodedCollectionSchema = z.union([
  waitingCollectionSchema, failedCollectionSchema, unavailableCollectionSchema,
  z.object({ status: z.literal('returned'), result: z.unknown() }).strict(),
  z.object({ status: z.literal('export-refused'), reason: z.enum(['native-export-budget', 'unsupported-native-key', 'run-tensor-byte-limit']) }).strict(),
]);
const encodedEpochSchema = z.object({ workerEpoch: epochSchema.shape.workerEpoch, lifetime: z.unknown(), collection: encodedCollectionSchema, correlation: correlationSchema.optional() }).strict();
const nativeEvidenceEnvelopeSchema = nativeCollectionSchema.omit({ format: true, epochs: true }).extend({
  format: z.literal('production-provider-native-evidence-v1'), sourceFormat: z.literal('production-provider-native-collection-v1'),
  providerCapture: z.literal('production-provider/capture.json'), epochs: z.array(encodedEpochSchema).max(8),
  limitations: z.object({ replayEligibility: z.literal('not-established'), realModelSuccess: z.literal('not-certified'), providerAndNativeSettlement: z.literal('independent-observations') }).strict(),
}).strict();
export const PRODUCTION_PROVIDER_NATIVE_JSON_MAXIMUM_CHARACTERS = 32 * 1024 * 1024;

// Containers below originate exclusively in this helper's JSON.parse. Preserve
// unknown keys until the authoritative native schema can reject them, rather
// than stripping extensions during reference/undefined decoding.
function jsonRecord({ value }: { value: unknown }): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function jsonArray({ value, maximum }: { value: unknown; maximum: number }): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value;
}
function decodeOptionalNumber({ value }: { value: unknown }): unknown {
  if (typeof value === 'object' && value !== null) {
    encodedUndefinedSchema.parse(value); return undefined;
  }
  return value;
}
function decodeLifetime({ value }: { value: unknown }): z.output<typeof epochSchema>['lifetime'] {
  const lifetime = jsonRecord({ value });
  switch (lifetime.status) {
  case 'unavailable': return epochSchema.shape.lifetime.parse(lifetime);
  case 'observed': {
    const record = jsonRecord({ value: lifetime.value });
    const loadRequests = jsonArray({ value: record.loadRequests, maximum: 32 }).map(value => {
      const load = jsonRecord({ value });
      if (!Object.hasOwn(load, 'requestedRevision')) invalid();
      const revision = load.requestedRevision;
      if (typeof revision === 'object' && revision !== null) encodedUndefinedSchema.parse(revision);
      return { ...load, requestedRevision: typeof revision === 'object' && revision !== null ? undefined : revision };
    });
    return epochSchema.shape.lifetime.parse({ ...lifetime, value: { ...record, loadRequests } });
  }
  default: return invalid();
  }
}

/**
 * Verify a native index using a ZIP-owned reader. readBinary must validate the
 * supplied reference against manifest length/hash and return those exact bytes;
 * this helper additionally checks ordinary backing/length and all native shapes.
 * No model, network, OPFS or additional capture operation is available here.
 */
export async function verifyProductionProviderNativeEvidence({ json, provider, readBinary }: {
  json: string; provider: ProductionProviderCaptureSnapshot;
  readBinary: ({ reference }: { reference: z.infer<typeof nativeBinaryReferenceSchema> }) => Promise<Uint8Array<ArrayBuffer>>;
}): Promise<{ referencedPaths: string[]; summary: ProductionProviderNativeEvidenceSidecar['summary'] }> {
  try {
    const modelId = data({ value: provider, key: 'modelId' });
    const runId = data({ value: provider, key: 'runId' });
    if (typeof modelId !== 'string' || typeof runId !== 'string') invalid();
    // Own the validated Provider view before any reader await can run caller code.
    const providerJson = createProductionProviderCaptureEvidence({ capture: provider, runId, modelId }).json;
    const validatedProvider = readProductionProviderCaptureEvidence({ json: providerJson, runId, modelId });
    const boundedJson = z.string().max(PRODUCTION_PROVIDER_NATIVE_JSON_MAXIMUM_CHARACTERS).parse(json);
    const envelope = nativeEvidenceEnvelopeSchema.parse(JSON.parse(boundedJson) as unknown);
    validateCollectionProgress({ snapshot: envelope, provider: validatedProvider });
    const pending: Array<{ reference: z.infer<typeof nativeBinaryReferenceSchema>; target: Record<string, unknown> }> = [];
    let totalBytes = 0;
    let totalEvents = 0;
    function decodeTensor({ value }: { value: unknown }): unknown {
      const snapshot = jsonRecord({ value });
      const status = discriminant<TensorSnapshot['status']>({ value: snapshot, key: 'status', variants: { scalar: true, 'image-sizes': true, 'not-recorded': true, captured: true } });
      switch (status) {
      case 'scalar': case 'image-sizes': case 'not-recorded': return snapshot;
      case 'captured': {
        const reference = nativeBinaryReferenceSchema.parse(snapshot.bytes);
        const expectedPath = `generation-native/tensors/${String(pending.length + 1).padStart(6, '0')}.bin`;
        if (reference.path !== expectedPath || snapshot.byteLength !== reference.byteLength) invalid();
        totalBytes += reference.byteLength;
        if (totalBytes > maximumTensorBytes) invalid();
        const target = { ...snapshot };
        pending.push({ reference, target });
        return target;
      }
      default: { const exhaustive: never = status; return exhaustive; }
      }
    }
    function decodeEvent({ value }: { value: unknown }): unknown {
      const event = jsonRecord({ value });
      const kind = discriminant<Event['kind']>({ value: event, key: 'kind', variants: { inputs: true, sequence: true, settings: true, 'native-stream': true, 'native-call': true, chunk: true } });
      switch (kind) {
      case 'inputs': return { ...event, values: jsonArray({ value: event.values, maximum: 64 }).map(value => {
        const input = jsonRecord({ value }); return { ...input, snapshot: decodeTensor({ value: input.snapshot }) };
      }) };
      case 'sequence': return { ...event, snapshot: decodeTensor({ value: event.snapshot }) };
      case 'settings': {
        const settings = jsonRecord({ value: event.value });
        const budget = { ...jsonRecord({ value: settings.budget }) };
        for (const key of ['maxNewTokens', 'contextLimit', 'promptTokenCount', 'usedContextTokenCount']) {
          if (Object.hasOwn(budget, key)) budget[key] = decodeOptionalNumber({ value: budget[key] });
        }
        return { ...event, value: { ...settings, budget } };
      }
      case 'native-stream': case 'native-call': case 'chunk': return event;
      default: { const exhaustive: never = kind; return exhaustive; }
      }
    }
    const decodedEpochs = envelope.epochs.map((epoch, index) => {
      const lifetime = decodeLifetime({ value: epoch.lifetime });
      const host = validateEpochLifetime({ epoch: { workerEpoch: epoch.workerEpoch, lifetime }, index, provider: validatedProvider });
      const collection = epoch.collection;
      const base = { workerEpoch: epoch.workerEpoch, lifetime };
      const checkCorrelation = ({ capture }: { capture: Native | undefined }): void => {
        if (host === undefined || epoch.correlation === undefined || epoch.correlation.length !== host.issuedCalls.length) invalid();
        for (const [index, correlation] of epoch.correlation.entries()) {
          if (!sameContext({ left: correlation.context, right: host.issuedCalls[index]! })) invalid();
          if (capture !== undefined) {
            const observed = capture.calls.some(call => sameContext({ left: call.context, right: correlation.context }));
            if (correlation.observation !== (observed ? 'observed' : 'issued-not-observed')) invalid();
          }
        }
      };
      switch (collection.status) {
      case 'export-refused':
        checkCorrelation({ capture: undefined });
        // A placeholder only for shared structural preflight. No native result
        // is invented; progress was checked against the real refused status.
        return { ...base, collection: { status: 'not-requested' as const } };
      case 'returned': {
        const result = jsonRecord({ value: collection.result });
        if (result.status !== 'captured') {
          if (epoch.correlation !== undefined) invalid();
          return { ...base, collection: { status: 'returned' as const, result: generationCaptureReadResultSchema.parse(result) } };
        }
        const returned = z.object({ status: z.literal('captured'), capture: z.unknown(), loadObservation: productionLoadObservationSchema.optional() }).strict().parse(result);
        const capture = jsonRecord({ value: returned.capture });
        const header = generationCaptureReadResultSchema.parse({ ...returned, capture: { ...capture, events: [] } });
        switch (header.status) {
        case 'captured':
          validateCapturedCalls({ capture: header.capture, lifetime: host, workerEpoch: epoch.workerEpoch, provider: validatedProvider });
          checkCorrelation({ capture: header.capture });
          break;
        case 'not-started': case 'already-taken': case 'wrong-run': case 'busy': case 'invalid-context': return invalid();
        default: { const exhaustive: never = header; return exhaustive; }
        }
        const events = jsonArray({ value: capture.events, maximum: 4096 });
        totalEvents += events.length;
        if (totalEvents > 4096) invalid();
        return { ...base, collection: { status: 'returned' as const, result: { ...returned, capture: { ...capture, events: events.map(value => decodeEvent({ value })) } } } };
      }
      case 'not-requested': case 'pending': case 'failed': case 'unavailable':
        if (epoch.correlation !== undefined) invalid();
        return { ...base, collection };
      default: { const exhaustive: never = collection; return exhaustive; }
      }
    });
    // Ordinal references and aggregate byte/event limits are checked before I/O.
    // The shared preflight below also checks expanded text/token/node budgets.
    for (const item of pending) {
      const bytes = byteView({ value: await readBinary({ reference: { ...item.reference } }) });
      if (bytes.byteLength !== item.reference.byteLength) invalid();
      item.target.bytes = bytes;
    }
    const { format: _format, sourceFormat, providerCapture: _providerCapture, limitations: _limitations, epochs: _epochs,
      runId: decodedRunId, maximumWorkerEpochs, phase, unrecordedWorkerCreations, incompleteReasons, ...unhandledEnvelope } = envelope;
    unhandledEnvelope satisfies Record<PropertyKey, never>;
    const decoded = { format: sourceFormat, runId: decodedRunId, maximumWorkerEpochs,
      phase, unrecordedWorkerCreations, incompleteReasons, epochs: decodedEpochs };
    const checks = createDescriptorChecks();
    const checked = checks.preflight({ value: decoded });
    if (checks.refusals.size !== 0) invalid();
    const validated = nativeCollectionSchema.parse(checked);
    for (const epoch of validated.epochs) {
      const lifetime = (() => {
        switch (epoch.lifetime.status) {
        case 'observed': return epoch.lifetime.value;
        case 'unavailable': return undefined;
        default: { const exhaustive: never = epoch.lifetime; throw new Error('Unknown native lifetime: ' + exhaustive); }
        }
      })();
      validateLoadObservation({ epoch, lifetime, provider: validatedProvider });
      if (epoch.collection.status === 'returned' && epoch.collection.result.status === 'captured' && hasUnknownNativeKeys({ capture: epoch.collection.result.capture })) invalid();
    }
    return { referencedPaths: pending.map(item => item.reference.path), summary: summarizeNativeRecording({ native: validated, refusedEpochs: new Set(envelope.epochs.filter(epoch => epoch.collection.status === 'export-refused').map(epoch => epoch.workerEpoch)) }) };
  } catch {
    return invalid();
  }
}

const nativeSidecarSchema = z.object({
  path: z.literal(PRODUCTION_PROVIDER_NATIVE_EVIDENCE_PATH),
  json: z.string().max(PRODUCTION_PROVIDER_NATIVE_JSON_MAXIMUM_CHARACTERS),
  reference: productionProviderNativeCaptureReferenceSchema,
  summary: nativeRecordingSummarySchema,
  binaries: z.array(nativeBinaryReferenceSchema.extend({ blob: z.custom<Blob>(value => {
    try {
      nativeBlobSize({ value }); return true;
    } catch {
      return false;
    }
  }) }).strict()).max(4096 * 64),
}).strict();

function nativeBlobSize({ value }: { value: unknown }): number {
  // Blob is an opaque immutable leaf. Ignore attached properties and invoke no
  // instance getter, iterator, arrayBuffer, slice or serialization hook.
  if (typeof value !== 'object' || value === null) invalid();
  // The intrinsic enforces the Blob internal brand, including genuine Blobs
  // from another realm. A matching public prototype alone proves nothing.
  return Reflect.apply(Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!, value, []) as number;
}

function parseNativeSidecar({ evidence }: { evidence: ProductionProviderNativeEvidenceSidecar }): z.infer<typeof nativeSidecarSchema> {
  record<ProductionProviderNativeEvidenceSidecar>({ value: evidence, optional: [], fields: {
    path: scalar, json: scalar,
    reference: ({ value }) => record<ProductionProviderNativeEvidenceSidecar['reference']>({ value, fields: { format: scalar, path: scalar }, optional: [] }),
    summary: ({ value }) => record<ProductionProviderNativeEvidenceSidecar['summary']>({ value, fields: {
      phase: scalar, refusedEpochCount: scalar, recording: scalar, capturedCallCount: scalar, enteredNativeInvocationCount: scalar, issuedNotObservedCallCount: scalar,
      unavailableEpochCount: scalar, incompleteEpochCount: scalar, unobservedLoadCount: scalar, incompleteInvocationCount: scalar, unrecordedValueCount: scalar,
    }, optional: [] }),
    binaries: array({ maximum: 4096 * 64, check: ({ value }) => record<ProductionProviderNativeEvidenceSidecar['binaries'][number]>({ value, optional: [], fields: {
      path: scalar, byteLength: scalar, sha256: scalar, blob: ({ value }) => {
        nativeBlobSize({ value });
      },
    } }) }),
  } });
  const parsed = nativeSidecarSchema.parse(evidence);
  const { path: _path, json: _json, reference: _reference, summary, binaries, ...unhandledSidecar } = parsed;
  unhandledSidecar satisfies Record<PropertyKey, never>;
  const { phase: _phase, refusedEpochCount: _refusedEpochCount, recording: _recording,
    capturedCallCount: _capturedCallCount, enteredNativeInvocationCount: _enteredNativeInvocationCount, issuedNotObservedCallCount: _issuedNotObservedCallCount,
    unavailableEpochCount: _unavailableEpochCount, incompleteEpochCount: _incompleteEpochCount,
    unobservedLoadCount: _unobservedLoadCount, incompleteInvocationCount: _incompleteInvocationCount, unrecordedValueCount: _unrecordedValueCount, ...unhandledSummary } = summary;
  unhandledSummary satisfies Record<PropertyKey, never>;
  let bytes = 0;
  for (const [index, binary] of binaries.entries()) {
    const { path, blob, byteLength, sha256: _sha256, ...unhandledBinary } = binary;
    unhandledBinary satisfies Record<PropertyKey, never>;
    if (path !== `generation-native/tensors/${String(index + 1).padStart(6, '0')}.bin`
      || nativeBlobSize({ value: blob }) !== byteLength) invalid();
    bytes += byteLength;
    if (bytes > PRODUCTION_PROVIDER_NATIVE_RUN_BINARY_BYTES) invalid();
  }
  return parsed;
}

function freezeNativeSidecar({ evidence }: { evidence: ProductionProviderNativeEvidenceSidecar }): ProductionProviderNativeEvidenceSidecar {
  const { path, json, reference, summary, binaries, ...rest } = evidence;
  rest satisfies Record<PropertyKey, never>;
  return Object.freeze({ path, json, reference: Object.freeze({ ...reference }), summary: Object.freeze({ ...summary }),
    binaries: Object.freeze(binaries.map(binary => {
      const { path, blob, byteLength, sha256, ...rest } = binary;
      rest satisfies Record<PropertyKey, never>;
      // A fresh ordinary Blob wrapper cannot retain caller-attached methods.
      // Its immutable byte storage may be shared; subsequent ZIP reads still copy.
      const owned = Reflect.apply(Blob.prototype.slice, blob, [0, byteLength]) as Blob;
      return Object.freeze({ path, blob: Object.freeze(owned), byteLength, sha256 });
    })),
  });
}

/** Header/Blob-size admission only: no Blob body read, digest or native decoding. */
export function measureProductionProviderNativeEvidenceSidecar({ evidence }: { evidence: ProductionProviderNativeEvidenceSidecar }): { binaryBytes: number; jsonCharacters: number } {
  try {
    const parsed = parseNativeSidecar({ evidence });
    return { binaryBytes: parsed.binaries.reduce((total, binary) => total + binary.byteLength, 0), jsonCharacters: parsed.json.length };
  } catch {
    return invalid();
  }
}

/** Validate a retained sidecar without recollecting or re-encoding a raw capture. */
export async function verifyProductionProviderNativeEvidenceSidecar({ evidence, provider, maximumBinaryBytes }: {
  evidence: ProductionProviderNativeEvidenceSidecar; provider: ProductionProviderCaptureSnapshot; maximumBinaryBytes: number;
}): Promise<ProductionProviderNativeEvidenceSidecar> {
  try {
    const parsed = parseNativeSidecar({ evidence });
    const maximum = z.number().int().nonnegative().safe().parse(maximumBinaryBytes);
    if (parsed.binaries.reduce((total, binary) => total + binary.byteLength, 0) > maximum) invalid();
    const index = nativeEvidenceEnvelopeSchema.parse(JSON.parse(parsed.json) as unknown);
    if (index.phase !== parsed.summary.phase || index.epochs.filter(epoch => epoch.collection.status === 'export-refused').length !== parsed.summary.refusedEpochCount) invalid();
    const owned = freezeNativeSidecar({ evidence: parsed });
    const binariesByPath = new Map(owned.binaries.map(binary => [binary.path, binary]));
    const verified = await verifyProductionProviderNativeEvidence({ json: owned.json, provider, readBinary: async ({ reference }) => {
      const binary = binariesByPath.get(reference.path);
      if (binary === undefined || binary.byteLength !== reference.byteLength || binary.sha256 !== reference.sha256) invalid();
      const bytes = new Uint8Array(await Reflect.apply(Blob.prototype.arrayBuffer, binary.blob, []) as ArrayBuffer);
      if (bytes.byteLength !== binary.byteLength) invalid();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
      if (sha256 !== binary.sha256) invalid();
      return bytes;
    } });
    if (verified.referencedPaths.length !== owned.binaries.length) invalid();
    if (JSON.stringify(nativeRecordingSummarySchema.parse(owned.summary)) !== JSON.stringify(nativeRecordingSummarySchema.parse(verified.summary))) invalid();
    return owned;
  } catch {
    return invalid();
  }
}

export const TEST_ONLY = {
  prepareNativeEvidence,
};
