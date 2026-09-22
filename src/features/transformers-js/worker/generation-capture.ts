// eslint-disable-next-line no-restricted-imports -- The Worker supplies its actual runtime class; this is a type-only dependency.
import type { Tensor } from '@huggingface/transformers';
import { z } from 'zod';
import type { GenerationInvocationObservation } from '@/features/transformers-js/generation-strategies';
import type { NativeStreamAvailability, NativeStreamRecorder } from './native-streamer-capture';
import { freezeProductionLoadIdentity, productionLoadIdentitySchema, type ProductionLoadIdentity } from './load-identity';

const boundedId = z.string().min(1).max(128);
export const GENERATION_CAPTURE_IMAGE_SIZE_FIELD_BYTES = 512;
export const GENERATION_CAPTURE_IMAGE_SIZE_SERIALIZED_FIELD_BYTES = 2048;
export const GENERATION_CAPTURE_IMAGE_SIZE_TOTAL_BYTES = 64 * 1024;
const imageSizeFields = new Set(['original_sizes', 'reshaped_input_sizes']);

/** Only the reviewed processor's tiny size matrices, never arbitrary JSON. */
function readImageSizes({ value }: { value: unknown }): Array<[number, number]> | undefined {
  function arrayLength({ value, maximum }: { value: unknown; maximum: number }): number | undefined {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = ownValue({ object: value, key: 'length' });
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 1 || length > maximum
      || Reflect.ownKeys(value).length !== length + 1) return undefined;
    return length;
  }
  const length = arrayLength({ value, maximum: 8 });
  if (length === undefined || !Array.isArray(value)) return undefined;
  const values: Array<[number, number]> = [];
  for (let index = 0; index < length; index++) {
    const row = ownValue({ object: value, key: String(index) });
    if (arrayLength({ value: row, maximum: 2 }) !== 2 || !Array.isArray(row)) return undefined;
    const height = ownValue({ object: row, key: '0' });
    const width = ownValue({ object: row, key: '1' });
    if (typeof height !== 'number' || !Number.isSafeInteger(height) || height <= 0
      || typeof width !== 'number' || !Number.isSafeInteger(width) || width <= 0) return undefined;
    values.push([height, width]);
  }
  return values;
}
function imageSizeFieldBytes({ name, values }: { name: string; values: Array<[number, number]> }): number {
  // All permitted names, tags, punctuation and safe positive decimal integers
  // are ASCII, so this character count is the exact UTF-8 JSON byte count.
  // The native envelope indents an input field by 18 spaces. Reserve 32 per
  // line plus its separator, including all nested matrix punctuation. The
  // maximum 8-row safe-integer field costs 1932 bytes, below 2048. Keep this
  // bound covered by the real native JSON export test if nesting changes.
  return JSON.stringify({ name, snapshot: { status: 'image-sizes', values } }).length;
}
export const generationCaptureContextSchema = z.object({
  runId: boundedId, workerEpoch: z.number().int().positive(),
  requestId: boundedId, generationCallId: z.number().int().positive(),
}).strict();
export const generationCaptureLimitsSchema = z.object({
  maxCalls: z.number().int().min(1).max(32),
  maxInvocationsPerCall: z.number().int().min(1).max(8),
  maxEvents: z.number().int().min(1).max(4096),
  maxTextBytes: z.number().int().min(1).max(256 * 1024),
  maxTensorBytes: z.number().int().min(1).max(16 * 1024 * 1024),
  maxTotalTensorBytes: z.number().int().min(1).max(64 * 1024 * 1024),
  maxTokensPerStreamEvent: z.number().int().min(1).max(65_536),
  maxTotalStreamTokens: z.number().int().min(1).max(262_144),
  maxTotalStreamTokenBytes: z.number().int().min(1).max(8 * 1024 * 1024),
}).strict();
const runIdentitySchema = generationCaptureContextSchema.pick({ runId: true, workerEpoch: true });
const invocationIdentitySchema = generationCaptureContextSchema.extend({ nativeInvocationOrdinal: z.number().int().min(1).max(8) });
const streamMissingReasonSchema = z.enum(['stream-token-shape', 'stream-token-type', 'stream-token-limit', 'stream-total-token-limit', 'stream-token-byte-limit', 'stream-finalized-shape', 'text-limit']);
const incompleteReasonSchema = z.enum([
  'call-limit', 'invocation-limit', 'event-limit', 'tensor-limit', 'total-tensor-limit',
  'input-key-limit', 'invalid-context', 'wrong-run', 'duplicate-call', 'overlapping-calls',
  'late-recording', 'snapshot-error', 'unrecorded-value', 'limits-mismatch',
  'stream-hook-failed', 'metadata-limit', ...streamMissingReasonSchema.options,
]);
const streamAvailabilitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not-attempted') }).strict(),
  z.object({ status: z.literal('available'), restoration: z.enum(['pending', 'restored', 'failed', 'ownership-lost']) }).strict(),
  z.object({ status: z.literal('unavailable'), reason: z.enum(['already-owned', 'unsupported-instance', 'method-descriptor', 'not-extensible', 'install-failed']) }).strict(),
]) satisfies z.ZodType<NativeStreamAvailability>;
const callSchema = z.object({
  context: generationCaptureContextSchema,
  loadIdentity: productionLoadIdentitySchema,
  outcome: z.enum(['active', 'fulfilled', 'rejected']),
  invocations: z.array(z.object({ nativeInvocationOrdinal: z.number().int().min(1).max(8), stream: streamAvailabilitySchema }).strict()).max(8),
}).strict();
const streamTokenSchema = z.string().max(20).regex(/^(?:0|-?[1-9][0-9]*)$/).refine(value => {
  try {
    const token = BigInt(value); return token >= -(1n << 63n) && token < (1n << 63n);
  } catch {
    return false;
  }
});
const streamDetailSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tokens'), tokenType: z.literal('bigint'), groups: z.array(z.array(streamTokenSchema).max(65_536)).max(8) }).strict()
    .refine(value => value.groups.reduce((count, row) => count + row.length, 0) <= 65_536),
  z.object({ kind: z.literal('finalized-text'), text: z.string().max(256 * 1024), streamEnd: z.boolean() }).strict(),
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('not-recorded'), reason: streamMissingReasonSchema }).strict(),
]);
const missingReasonSchema = z.enum([
  'excluded-field', 'accessor', 'missing', 'not-runtime-tensor', 'unknown-layout', 'not-cpu',
  'unsupported-dtype', 'invalid-shape', 'invalid-data', 'shared-buffer', 'tensor-limit', 'total-tensor-limit', 'metadata-limit',
]);
const capturedTensorSchema = z.object({
  status: z.literal('captured'), dtype: z.enum(['float32', 'float64', 'float16', 'int64', 'uint64', 'int32', 'uint32', 'int16', 'uint16', 'int8', 'uint8', 'bool']),
  dims: z.array(z.number().int().nonnegative()).max(8),
  byteLength: z.number().int().nonnegative().max(16 * 1024 * 1024),
  bytes: z.instanceof(Uint8Array),
}).strict().refine(value => {
  // Structured-clone input is untrusted too. A matching Uint8Array shape does
  // not establish that its backing storage is ordinary, non-shared memory.
  try {
    const buffer = Reflect.apply(arrayBufferGetter, value.bytes, []);
    Reflect.apply(ordinaryBufferLengthGetter, buffer, []);
  } catch {
    return false;
  }
  let elements = 1;
  for (const dimension of value.dims) {
    elements *= dimension;
    if (!Number.isSafeInteger(elements)) return false;
  }
  return value.dims.every(Number.isSafeInteger)
    && elements * dtypeLayouts[value.dtype][1] === value.byteLength
    && value.bytes.byteLength === value.byteLength;
}, 'Tensor shape, dtype and byte length mismatch');
const snapshotSchema = z.discriminatedUnion('status', [
  capturedTensorSchema,
  z.object({ status: z.literal('scalar'), values: z.array(z.number().finite()).max(8) }).strict(),
  z.object({ status: z.literal('image-sizes'), values: z.preprocess(value => readImageSizes({ value }), z.array(z.tuple([z.number().int().positive().safe(), z.number().int().positive().safe()])).min(1).max(8)) }).strict(),
  z.object({ status: z.literal('not-recorded'), reason: missingReasonSchema }).strict(),
]);
type Snapshot = z.infer<typeof snapshotSchema>;
const propertySchema = z.discriminatedUnion('status', [
  z.object({ status: z.enum(['omitted', 'undefined', 'null']) }).strict(),
  z.object({ status: z.literal('value'), value: z.union([z.number().finite(), z.boolean()]) }).strict(),
  z.object({ status: z.literal('not-recorded'), reason: z.enum(['accessor', 'unsupported-value', 'non-finite-number']) }).strict(),
]);
const settingsSchema = z.object({
  requested: z.object({ maxCompletionTokens: propertySchema, temperature: propertySchema, topP: propertySchema }).strict(),
  budget: z.object({
    maxNewTokens: z.number().finite().optional(), source: z.enum(['explicit', 'model-context', 'transformers-default']),
    contextLimit: z.number().finite().optional(), promptTokenCount: z.number().finite().optional(),
    pastTokenCount: z.number().finite(), usedContextTokenCount: z.number().finite().optional(),
  }).strict(),
  kwargs: z.object({
    keys: z.object({
      status: z.enum(['complete', 'incomplete']), totalCount: z.number().int().nonnegative(),
      values: z.array(z.string().max(128)).max(64),
      incompleteReasons: z.array(z.enum(['key-count-limit', 'key-length-limit', 'symbol-key'])).max(3),
    }).strict(),
    maxNewTokens: propertySchema, temperature: propertySchema, topP: propertySchema,
    doSample: propertySchema, returnDictInGenerate: propertySchema,
  }).strict(),
}).strict();
const eventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native-stream'), identity: invocationIdentitySchema, operation: z.enum(['put', 'end', 'on_finalized_text']),
    phase: z.enum(['entering', 'returned', 'threw']), streamCallOrdinal: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), detail: streamDetailSchema }).strict(),
  // An ordinal identifies a boundary attempt. Only entering confirms that the
  // actual native call was reached; a budget failure can have inputs alone.
  z.object({ kind: z.literal('native-call'), identity: invocationIdentitySchema, phase: z.enum(['entering', 'fulfilled', 'rejected']) }).strict(),
  z.object({ kind: z.literal('inputs'), identity: invocationIdentitySchema, phase: z.enum(['full-conversation', 'pre-budget', 'native-kwargs']), values: z.array(z.object({ name: z.string().max(128), snapshot: snapshotSchema }).strict()).max(64) }).strict(),
  z.object({ kind: z.literal('sequence'), identity: invocationIdentitySchema, resultShape: z.enum(['tensor', 'dictionary', 'unknown']), snapshot: snapshotSchema }).strict(),
  z.object({ kind: z.literal('settings'), identity: invocationIdentitySchema, value: settingsSchema }).strict(),
  z.object({ kind: z.literal('chunk'), identity: invocationIdentitySchema, phase: z.enum(['strategy-output', 'worker-send', 'strategy-raw']), text: z.string().max(256 * 1024) }).strict(),
]);
type Event = z.infer<typeof eventSchema>;
const captureSchema = runIdentitySchema.extend({
  schemaVersion: z.literal(1), byteOrder: z.enum(['little-endian', 'big-endian']), limits: generationCaptureLimitsSchema,
  calls: z.array(callSchema).max(32),
  events: z.array(eventSchema).max(4096),
  incompleteReasons: z.array(incompleteReasonSchema).max(incompleteReasonSchema.options.length),
  unobserved: z.tuple([z.literal('native-stop-cause'), z.literal('native-forward-input'), z.literal('kv-bytes')]),
}).strict().superRefine((capture, context) => {
  let tensorBytes = 0;
  let textBytes = 0;
  let streamTokens = 0;
  let streamTokenBytes = 0;
  let metadataBytes = 0;
  if (capture.calls.length > capture.limits.maxCalls || capture.events.length > capture.limits.maxEvents) {
    context.addIssue({ code: 'custom', message: 'Capture exceeds configured count limits' });
  }
  const callIds = new Set<number>();
  for (const call of capture.calls) {
    if (call.context.runId !== capture.runId || call.context.workerEpoch !== capture.workerEpoch || callIds.has(call.context.generationCallId) || call.outcome === 'active') {
      context.addIssue({ code: 'custom', message: 'Capture call identity or outcome mismatch' });
    }
    callIds.add(call.context.generationCallId);
    if (call.invocations.length > capture.limits.maxInvocationsPerCall
      || new Set(call.invocations.map(invocation => invocation.nativeInvocationOrdinal)).size !== call.invocations.length
      || call.invocations.some(invocation => invocation.nativeInvocationOrdinal > capture.limits.maxInvocationsPerCall)) {
      context.addIssue({ code: 'custom', message: 'Capture invocation identity mismatch' });
    }
  }
  for (const event of capture.events) {
    if (event.identity.runId !== capture.runId || event.identity.workerEpoch !== capture.workerEpoch
      || event.identity.nativeInvocationOrdinal > capture.limits.maxInvocationsPerCall
      || !capture.calls.some(call => call.context.requestId === event.identity.requestId && call.context.generationCallId === event.identity.generationCallId
        && call.invocations.some(invocation => invocation.nativeInvocationOrdinal === event.identity.nativeInvocationOrdinal))) {
      context.addIssue({ code: 'custom', message: 'Capture event identity mismatch' });
    }
    let snapshots: Snapshot[];
    switch (event.kind) {
    case 'native-stream': {
      const invocation = capture.calls.find(call => call.context.generationCallId === event.identity.generationCallId)?.invocations.find(item => item.nativeInvocationOrdinal === event.identity.nativeInvocationOrdinal);
      const streamStatus = invocation?.stream.status;
      switch (streamStatus) {
      case 'available': break;
      case undefined: case 'not-attempted': case 'unavailable': context.addIssue({ code: 'custom', message: 'Stream events require an available invocation hook' }); break;
      default: { const _ex: never = streamStatus; throw new Error(String(_ex)); }
      }
      const detail = event.detail;
      switch (detail.kind) {
      case 'tokens': {
        if (event.phase !== 'entering' || event.operation !== 'put') context.addIssue({ code: 'custom', message: 'Unexpected put payload' });
        const count = detail.groups.reduce((total, row) => total + row.length, 0);
        if (count > capture.limits.maxTokensPerStreamEvent) context.addIssue({ code: 'custom', message: 'Stream event exceeds token limit' });
        streamTokens += count;
        for (const row of detail.groups) for (const token of row) streamTokenBytes += token.length;
        break;
      }
      case 'finalized-text':
        if (event.phase !== 'entering' || event.operation !== 'on_finalized_text') context.addIssue({ code: 'custom', message: 'Unexpected finalized-text payload' });
        textBytes += new TextEncoder().encode(detail.text).byteLength;
        break;
      case 'none':
        if (event.phase === 'entering' && event.operation !== 'end') context.addIssue({ code: 'custom', message: 'Missing entering stream payload' });
        break;
      case 'not-recorded':
        if (event.phase !== 'entering' || event.operation === 'end') context.addIssue({ code: 'custom', message: 'Unexpected missing stream payload' });
        break;
      default: { const _ex: never = detail; throw new Error(String(_ex)); }
      }
      snapshots = [];
      break;
    }
    case 'inputs': {
      const names = new Set<string>();
      for (const { name, snapshot } of event.values) {
        if (names.has(name)) {
          context.addIssue({ code: 'custom', message: 'Duplicate or unsupported input snapshot field' });
        }
        switch (snapshot.status) {
        case 'captured':
          if (!tensorFields.has(name)) context.addIssue({ code: 'custom', message: 'Unsupported tensor input field' });
          break;
        case 'scalar':
          if (name !== 'num_soft_tokens_per_image') context.addIssue({ code: 'custom', message: 'Unsupported scalar input field' });
          break;
        case 'image-sizes': {
          if (!imageSizeFields.has(name)) context.addIssue({ code: 'custom', message: 'Unsupported image size input field' });
          const bytes = imageSizeFieldBytes({ name, values: snapshot.values });
          if (bytes > GENERATION_CAPTURE_IMAGE_SIZE_FIELD_BYTES) context.addIssue({ code: 'custom', message: 'Image size field exceeds byte limit' });
          metadataBytes += GENERATION_CAPTURE_IMAGE_SIZE_SERIALIZED_FIELD_BYTES;
          break;
        }
        case 'not-recorded': break;
        default: { const _ex: never = snapshot; throw new Error(String(_ex)); }
        }
        names.add(name);
      }
      snapshots = event.values.map(value => value.snapshot);
      break;
    }
    case 'sequence':
      if (event.snapshot.status === 'scalar' || event.snapshot.status === 'image-sizes' || (event.snapshot.status === 'captured' && event.resultShape === 'unknown')) {
        context.addIssue({ code: 'custom', message: 'Invalid sequence snapshot shape' });
      }
      snapshots = [event.snapshot];
      break;
    case 'settings': case 'native-call': snapshots = []; break;
    case 'chunk':
      textBytes += new TextEncoder().encode(event.text).byteLength;
      snapshots = [];
      break;
    default: { const _ex: never = event; throw new Error(String(_ex)); }
    }
    for (const snapshot of snapshots) {
      switch (snapshot.status) {
      case 'captured':
        tensorBytes += snapshot.byteLength;
        if (snapshot.byteLength > capture.limits.maxTensorBytes) context.addIssue({ code: 'custom', message: 'Capture exceeds configured tensor limit' });
        break;
      case 'scalar': case 'image-sizes': case 'not-recorded': break;
      default: { const _ex: never = snapshot; throw new Error(String(_ex)); }
      }
    }
  }
  if (tensorBytes > capture.limits.maxTotalTensorBytes || textBytes > capture.limits.maxTextBytes) {
    context.addIssue({ code: 'custom', message: 'Capture exceeds configured byte limits' });
  }
  if (streamTokens > capture.limits.maxTotalStreamTokens || streamTokenBytes > capture.limits.maxTotalStreamTokenBytes) {
    context.addIssue({ code: 'custom', message: 'Capture exceeds stream token capacity' });
  }
  if (metadataBytes > GENERATION_CAPTURE_IMAGE_SIZE_TOTAL_BYTES) context.addIssue({ code: 'custom', message: 'Capture exceeds image size byte limit' });
});

/** Parse context on receipt and parse take results on both sides of the future RPC. */
export const generationCaptureTakeResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('captured'), capture: captureSchema }).strict(),
  z.object({ status: z.enum(['wrong-run', 'invalid-context', 'busy', 'already-taken']) }).strict(),
]);

function ownValue({ object, key }: { object: object; key: PropertyKey }): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return undefined;
  return descriptor.value as unknown;
}

const tensorFields = new Set(['input_ids', 'attention_mask', 'decoder_input_ids', 'decoder_attention_mask', 'pixel_values', 'image_position_ids', 'image_grid_thw', 'video_grid_thw']);
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const arrayBufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const arrayOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const arrayLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const arrayTagGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const ordinaryBufferLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const nativeByteOrder = new Uint8Array(Uint16Array.of(0x0102).buffer)[0] === 2 ? 'little-endian' : 'big-endian';
const dtypeLayouts = {
  float32: ['Float32Array', 4], float64: ['Float64Array', 8], float16: ['Uint16Array', 2],
  int64: ['BigInt64Array', 8], uint64: ['BigUint64Array', 8], int32: ['Int32Array', 4], uint32: ['Uint32Array', 4],
  int16: ['Int16Array', 2], uint16: ['Uint16Array', 2], int8: ['Int8Array', 1], uint8: ['Uint8Array', 1], bool: ['Uint8Array', 1],
} as const;

/**
 * Worker-local recording only. No RPC, storage, GPU readback or native execution.
 * Byte buffers are private owned copies until a successful one-shot take moves
 * ownership to the caller. They are not frozen or part of the immutable settings event.
 */
export function createGenerationCapture({ run, limits: rawLimits, tensorClass }: {
  run: unknown; limits: unknown; tensorClass: typeof Tensor;
}) {
  const runIdentity = runIdentitySchema.parse(run);
  const limits = generationCaptureLimitsSchema.parse(rawLimits);
  let events: Event[] = [];
  const calls = new Map<number, z.infer<typeof callSchema>>();
  const incompleteReasons = new Set<z.infer<typeof incompleteReasonSchema>>();
  let taken = false;
  let retainedTensorBytes = 0;
  let retainedTextBytes = 0;
  let retainedStreamTokens = 0;
  let retainedStreamTokenBytes = 0;
  let retainedMetadataBytes = 0;
  function streamMissing({ reason }: { reason: z.infer<typeof streamMissingReasonSchema> }): z.infer<typeof streamDetailSchema> {
    incompleteReasons.add(reason);
    return { kind: 'not-recorded', reason };
  }
  function snapshotStream({ operation, phase, args }: Parameters<NativeStreamRecorder['recordNativeStream']>[0]): z.infer<typeof streamDetailSchema> {
    if (phase !== 'entering' || operation === 'end') return { kind: 'none' };
    switch (operation) {
    case 'put': {
      const value = ownValue({ object: args, key: '0' });
      if (!Array.isArray(value)) return streamMissing({ reason: 'stream-token-shape' });
      const rowCount = ownValue({ object: value, key: 'length' });
      if (typeof rowCount !== 'number' || !Number.isSafeInteger(rowCount) || rowCount < 0 || rowCount > 8) return streamMissing({ reason: 'stream-token-shape' });
      const groups: string[][] = [];
      let count = 0;
      let bytes = 0;
      for (let rowIndex = 0; rowIndex < rowCount; ++rowIndex) {
        const row = ownValue({ object: value, key: String(rowIndex) });
        if (!Array.isArray(row)) return streamMissing({ reason: 'stream-token-shape' });
        const tokenCount = ownValue({ object: row, key: 'length' });
        if (typeof tokenCount !== 'number' || !Number.isSafeInteger(tokenCount) || tokenCount < 0) return streamMissing({ reason: 'stream-token-shape' });
        count += tokenCount;
        if (count > limits.maxTokensPerStreamEvent) return streamMissing({ reason: 'stream-token-limit' });
        if (count > limits.maxTotalStreamTokens - retainedStreamTokens) return streamMissing({ reason: 'stream-total-token-limit' });
        const tokens: string[] = [];
        for (let index = 0; index < tokenCount; ++index) {
          const token = ownValue({ object: row, key: String(index) });
          if (typeof token !== 'bigint' || token < -(1n << 63n) || token >= (1n << 63n)) return streamMissing({ reason: 'stream-token-type' });
          const encoded = token.toString();
          bytes += encoded.length;
          if (bytes > limits.maxTotalStreamTokenBytes - retainedStreamTokenBytes) return streamMissing({ reason: 'stream-token-byte-limit' });
          tokens.push(encoded);
        }
        groups.push(tokens);
      }
      retainedStreamTokens += count;
      retainedStreamTokenBytes += bytes;
      return { kind: 'tokens', tokenType: 'bigint', groups };
    }
    case 'on_finalized_text': {
      const text = ownValue({ object: args, key: '0' });
      const streamEnd = ownValue({ object: args, key: '1' });
      if (typeof text !== 'string' || typeof streamEnd !== 'boolean') return streamMissing({ reason: 'stream-finalized-shape' });
      if (text.length > limits.maxTextBytes - retainedTextBytes) return streamMissing({ reason: 'text-limit' });
      const bytes = new TextEncoder().encode(text).byteLength;
      if (bytes > limits.maxTextBytes - retainedTextBytes) return streamMissing({ reason: 'text-limit' });
      retainedTextBytes += bytes;
      return { kind: 'finalized-text', text, streamEnd };
    }
    default: { const _ex: never = operation; throw new Error(String(_ex)); }
    }
  }
  function missing({ reason }: { reason: z.infer<typeof missingReasonSchema> }): Snapshot {
    switch (reason) {
    case 'excluded-field': break;
    case 'accessor': case 'missing': case 'not-runtime-tensor': case 'unknown-layout': case 'not-cpu':
    case 'unsupported-dtype': case 'invalid-shape': case 'invalid-data': case 'shared-buffer':
    case 'tensor-limit': case 'total-tensor-limit': case 'metadata-limit':
      incompleteReasons.add('unrecorded-value');
      break;
    default: { const _ex: never = reason; throw new Error(String(_ex)); }
    }
    return { status: 'not-recorded', reason };
  }
  function snapshotTensor({ value }: { value: unknown }): Snapshot {
    if (!(value instanceof tensorClass)) return missing({ reason: 'not-runtime-tensor' });
    // TJS 4.2.0 Tensor is a Proxy over an own ort_tensor. Read only the reviewed
    // ORT own data layout; never invoke .data/getData() or arbitrary getters.
    const ort = ownValue({ object: value, key: 'ort_tensor' });
    if (ort === null || typeof ort !== 'object') return missing({ reason: 'unknown-layout' });
    const location = ownValue({ object: ort, key: 'dataLocation' });
    if (location !== 'cpu') return missing({ reason: 'not-cpu' });
    const dtype = ownValue({ object: ort, key: 'type' });
    if (typeof dtype !== 'string' || !Object.hasOwn(dtypeLayouts, dtype)) return missing({ reason: 'unsupported-dtype' });
    const layout = dtypeLayouts[dtype as keyof typeof dtypeLayouts];
    const rawDims = ownValue({ object: ort, key: 'dims' });
    if (!Array.isArray(rawDims)) return missing({ reason: 'invalid-shape' });
    const rank = ownValue({ object: rawDims, key: 'length' });
    if (typeof rank !== 'number' || rank > 8) return missing({ reason: 'invalid-shape' });
    const dims: number[] = [];
    let elements = 1;
    for (let index = 0; index < rank; ++index) {
      const dimension = ownValue({ object: rawDims, key: String(index) });
      if (typeof dimension !== 'number' || !Number.isSafeInteger(dimension) || dimension < 0) return missing({ reason: 'invalid-shape' });
      dims.push(dimension);
      elements *= dimension;
      if (!Number.isSafeInteger(elements)) return missing({ reason: 'invalid-shape' });
    }
    const byteLength = elements * layout[1];
    if (!Number.isSafeInteger(byteLength)) return missing({ reason: 'invalid-shape' });
    if (byteLength > limits.maxTensorBytes) {
      incompleteReasons.add('tensor-limit'); return missing({ reason: 'tensor-limit' });
    }
    if (byteLength > limits.maxTotalTensorBytes - retainedTensorBytes) {
      incompleteReasons.add('total-tensor-limit'); return missing({ reason: 'total-tensor-limit' });
    }
    const data = ownValue({ object: ort, key: 'cpuData' });
    if (!ArrayBuffer.isView(data) || Reflect.apply(arrayTagGetter, data, []) !== layout[0]) return missing({ reason: 'invalid-data' });
    const actualBytes = Reflect.apply(arrayLengthGetter, data, []) as number;
    if (actualBytes !== byteLength) return missing({ reason: 'invalid-data' });
    const buffer = Reflect.apply(arrayBufferGetter, data, []) as ArrayBuffer;
    try {
      Reflect.apply(ordinaryBufferLengthGetter, buffer, []);
    } catch {
      return missing({ reason: 'shared-buffer' });
    }
    const offset = Reflect.apply(arrayOffsetGetter, data, []) as number;
    const bytes = new Uint8Array(buffer, offset, byteLength).slice();
    retainedTensorBytes += byteLength;
    return { status: 'captured', dtype: dtype as keyof typeof dtypeLayouts, dims, byteLength, bytes };
  }
  function snapshotInput({ inputs, name }: { inputs: object; name: string }): Snapshot {
    // The allowlist excludes KV, weights, and arbitrary object contents before
    // reading a descriptor, even when an excluded field has a hostile getter.
    if (!tensorFields.has(name) && !imageSizeFields.has(name) && name !== 'num_soft_tokens_per_image') return missing({ reason: 'excluded-field' });
    const descriptor = Object.getOwnPropertyDescriptor(inputs, name);
    if (descriptor === undefined) return missing({ reason: 'missing' });
    if (!Object.hasOwn(descriptor, 'value')) return missing({ reason: 'accessor' });
    const value: unknown = descriptor.value;
    if (imageSizeFields.has(name)) {
      const values = readImageSizes({ value });
      if (values === undefined) return missing({ reason: 'invalid-data' });
      const bytes = imageSizeFieldBytes({ name, values });
      if (bytes > GENERATION_CAPTURE_IMAGE_SIZE_FIELD_BYTES || GENERATION_CAPTURE_IMAGE_SIZE_SERIALIZED_FIELD_BYTES > GENERATION_CAPTURE_IMAGE_SIZE_TOTAL_BYTES - retainedMetadataBytes) {
        incompleteReasons.add('metadata-limit');
        return missing({ reason: 'metadata-limit' });
      }
      retainedMetadataBytes += GENERATION_CAPTURE_IMAGE_SIZE_SERIALIZED_FIELD_BYTES;
      return { status: 'image-sizes', values };
    }
    if (name !== 'num_soft_tokens_per_image') return snapshotTensor({ value });
    if (!Array.isArray(value)) return missing({ reason: 'invalid-data' });
    const length = ownValue({ object: value, key: 'length' });
    if (typeof length !== 'number' || length > 8) return missing({ reason: 'invalid-data' });
    const values: number[] = [];
    for (let index = 0; index < length; ++index) {
      const scalar = ownValue({ object: value, key: String(index) });
      if (typeof scalar !== 'number' || !Number.isFinite(scalar)) return missing({ reason: 'invalid-data' });
      values.push(scalar);
    }
    return { status: 'scalar', values };
  }

  return {
    noteIncomplete({ reason }: { reason: z.infer<typeof incompleteReasonSchema> }) {
      if (!taken) incompleteReasons.add(reason);
    },
    beginCall({ context: rawContext, loadIdentity }: { context: unknown; loadIdentity: ProductionLoadIdentity }) {
      if (taken) return undefined;
      const parsed = generationCaptureContextSchema.safeParse(rawContext);
      if (!parsed.success) {
        incompleteReasons.add('invalid-context'); return undefined;
      }
      const context = parsed.data;
      if (context.runId !== runIdentity.runId || context.workerEpoch !== runIdentity.workerEpoch) {
        incompleteReasons.add('wrong-run'); return undefined;
      }
      if (calls.has(context.generationCallId)) {
        incompleteReasons.add('duplicate-call'); return undefined;
      }
      if (calls.size >= limits.maxCalls) {
        incompleteReasons.add('call-limit'); return undefined;
      }
      if ([...calls.values()].some(call => call.outcome === 'active')) incompleteReasons.add('overlapping-calls');
      const parsedLoad = productionLoadIdentitySchema.safeParse(loadIdentity);
      const ownedLoad = freezeProductionLoadIdentity({ identity: parsedLoad.success ? parsedLoad.data : { status: 'not-observed', reason: 'recording-failed' } });
      const call: z.infer<typeof callSchema> = { context, loadIdentity: ownedLoad, outcome: 'active', invocations: [] };
      calls.set(context.generationCallId, call);
      let invocationCount = 0;
      let currentChunkRecorder: (({ phase, chunk }: { phase: 'strategy-output' | 'worker-send' | 'strategy-raw'; chunk: string }) => void) | undefined;
      function append({ create }: { create: () => Event | undefined }) {
        if (taken) return;
        switch (call.outcome) {
        case 'active': break;
        case 'fulfilled': case 'rejected': incompleteReasons.add('late-recording'); return;
        default: { const _ex: never = call.outcome; throw new Error(String(_ex)); }
        }
        if (events.length >= limits.maxEvents) {
          incompleteReasons.add('event-limit'); return;
        }
        try {
          const event = create();
          if (event !== undefined) events.push(event);
        } catch {
          incompleteReasons.add('snapshot-error');
        }
      }
      return {
        beginInvocation() {
          if (taken || call.outcome !== 'active') return undefined;
          if (invocationCount >= limits.maxInvocationsPerCall) {
            incompleteReasons.add('invocation-limit'); return undefined;
          }
          const identity = { ...context, nativeInvocationOrdinal: ++invocationCount };
          const invocationState: z.infer<typeof callSchema>['invocations'][number] = { nativeInvocationOrdinal: invocationCount, stream: { status: 'not-attempted' } };
          call.invocations.push(invocationState);
          const invocation = {
            setNativeStreamAvailability({ availability }: { availability: NativeStreamAvailability }) {
              if (taken || call.outcome !== 'active') return;
              recordGenerationCapture({ record: () => {
                invocationState.stream = streamAvailabilitySchema.parse(availability);
                if (availability.status === 'unavailable' || (availability.status === 'available' && availability.restoration !== 'pending' && availability.restoration !== 'restored')) {
                  incompleteReasons.add('stream-hook-failed');
                }
              } });
            },
            recordNativeStream({ operation, phase, streamCallOrdinal, args }: Parameters<NativeStreamRecorder['recordNativeStream']>[0]) {
              append({ create: () => {
                if (invocationState.stream.status !== 'available' || !Number.isSafeInteger(streamCallOrdinal) || streamCallOrdinal <= 0) throw new Error('Invalid stream recording identity');
                return { kind: 'native-stream', identity, operation, phase, streamCallOrdinal, detail: snapshotStream({ operation, phase, streamCallOrdinal, args }) };
              } });
            },
            recordNativeCall({ phase }: { phase: 'entering' | 'fulfilled' | 'rejected' }) {
              append({ create: () => ({ kind: 'native-call', identity, phase }) });
            },
            recordInputs({ phase, inputs }: { phase: 'full-conversation' | 'pre-budget' | 'native-kwargs'; inputs: Record<string, unknown> }) {
              append({ create: () => {
                const values: Extract<Event, { kind: 'inputs' }>['values'] = [];
                for (const name of Reflect.ownKeys(inputs)) {
                  if (typeof name !== 'string' || name.length > 128 || values.length >= 64) {
                    incompleteReasons.add('input-key-limit'); continue;
                  }
                  values.push({ name, snapshot: snapshotInput({ inputs, name }) });
                }
                return { kind: 'inputs', identity, phase, values };
              } });
            },
            recordSettings({ observation }: { observation: GenerationInvocationObservation }) {
              append({ create: () => ({ kind: 'settings', identity, value: settingsSchema.parse(observation) }) });
            },
            recordSequence({ result }: { result: unknown }) {
              append({ create: () => {
                let resultShape: Extract<Event, { kind: 'sequence' }>['resultShape'];
                let value: unknown;
                if (result instanceof tensorClass) {
                  resultShape = 'tensor';
                  value = result;
                } else if (result !== null && typeof result === 'object') {
                  resultShape = 'dictionary';
                  value = ownValue({ object: result, key: 'sequences' });
                } else {
                  resultShape = 'unknown';
                  value = undefined;
                }
                return { kind: 'sequence', identity, resultShape, snapshot: snapshotTensor({ value }) };
              } });
            },
            recordChunk({ phase, chunk }: { phase: 'strategy-output' | 'worker-send' | 'strategy-raw'; chunk: string }) {
              append({ create: () => {
                const remaining = limits.maxTextBytes - retainedTextBytes;
                if (chunk.length > remaining) {
                  incompleteReasons.add('text-limit'); return undefined;
                }
                const byteLength = new TextEncoder().encode(chunk).byteLength;
                if (byteLength > remaining) {
                  incompleteReasons.add('text-limit'); return undefined;
                }
                retainedTextBytes += byteLength;
                return { kind: 'chunk', identity, phase, text: chunk };
              } });
            },
          };
          currentChunkRecorder = invocation.recordChunk;
          return invocation;
        },
        recordChunk({ phase, chunk }: { phase: 'strategy-output' | 'worker-send' | 'strategy-raw'; chunk: string }) {
          currentChunkRecorder?.({ phase, chunk });
        },
        finish({ outcome }: { outcome: 'fulfilled' | 'rejected' }) {
          if (!taken && call.outcome === 'active') call.outcome = outcome;
        },
      };
    },
    take({ run: requestedRun }: { run: unknown }): z.infer<typeof generationCaptureTakeResultSchema> {
      const parsed = runIdentitySchema.safeParse(requestedRun);
      if (!parsed.success) return { status: 'invalid-context' };
      if (parsed.data.runId !== runIdentity.runId || parsed.data.workerEpoch !== runIdentity.workerEpoch) return { status: 'wrong-run' };
      if (taken) return { status: 'already-taken' };
      if ([...calls.values()].some(call => call.outcome === 'active')) return { status: 'busy' };
      const result = generationCaptureTakeResultSchema.parse({
        status: 'captured', capture: {
          ...runIdentity, schemaVersion: 1, byteOrder: nativeByteOrder, limits, calls: [...calls.values()], events,
          incompleteReasons: [...incompleteReasons],
          unobserved: ['native-stop-cause', 'native-forward-input', 'kv-bytes'],
        },
      });
      // Parsing copies structural records, not Uint8Array contents. Move those
      // owned buffers out once, then retire every recorder handle before return.
      taken = true;
      events = [];
      calls.clear();
      retainedTensorBytes = 0;
      retainedTextBytes = 0;
      retainedStreamTokens = 0;
      retainedStreamTokenBytes = 0;
      return result;
    },
  };
}

export type GenerationCaptureCall = NonNullable<ReturnType<ReturnType<typeof createGenerationCapture>['beginCall']>>;

/** Synchronous diagnostic containment, never an acknowledgement or drain. */
export function recordGenerationCapture({ record }: { record: () => void }): void {
  try {
    record();
  } catch { /* Recording must not replace a native result or error. */ }
}

export const TEST_ONLY = {
};
