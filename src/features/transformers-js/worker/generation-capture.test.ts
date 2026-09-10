// @vitest-environment node
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { GenerationInvocationObservation } from '@/features/transformers-js/generation-strategies';
import { getProductionTransformersArtifact, importProductionTransformersArtifact } from '@/features/transformers-js/runtime/fixtures/production-transformers-artifact';
import { createGenerationCapture, generationCaptureContextSchema, generationCaptureTakeResultSchema, GENERATION_CAPTURE_IMAGE_SIZE_FIELD_BYTES, GENERATION_CAPTURE_IMAGE_SIZE_SERIALIZED_FIELD_BYTES, GENERATION_CAPTURE_IMAGE_SIZE_TOTAL_BYTES } from './generation-capture';
import { productionLoadIdentitySchema } from './load-identity';

type Runtime = typeof import('@huggingface/transformers');
let runtime: Runtime;
const fetch = vi.fn(() => {
  throw new Error('External network forbidden in generation capture tests');
});
beforeAll(async () => {
  vi.stubGlobal('fetch', fetch);
  const artifact = await getProductionTransformersArtifact();
  expect(artifact.originalBundleSha256).toBe('25e0cbdf5df922996299fcd2cf835101ba979b134389a0dcc54f92022ca7e0ff');
  expect(artifact.transformedBundleSha256).toBe('875b33675dcf7b646f7f39d2680d2612040b1eb570f865a537aea1118658b731');
  // The browser bundle intentionally contains no Node backend. Select its
  // actual browser route while evaluating it, as the Production replay does.
  // This is test platform setup, not a Tensor/runtime implementation replacement.
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'process')!;
  const originalProcess = globalThis.process;
  Object.defineProperty(globalThis, 'process', { configurable: true, writable: true, value: { ...originalProcess, release: { ...originalProcess.release, name: 'browser-test' } } });
  try {
    runtime = await importProductionTransformersArtifact({ moduleUrl: `${artifact.moduleUrl}?capture=tensor-layout` }) as Runtime;
  } finally {
    Object.defineProperty(globalThis, 'process', descriptor);
  }
}, 30_000);
afterAll(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

const run = { runId: 'synthetic-run', workerEpoch: 1 };
const limits = { maxCalls: 4, maxInvocationsPerCall: 2, maxEvents: 20, maxTextBytes: 100, maxTensorBytes: 128, maxTotalTensorBytes: 256, maxTokensPerStreamEvent: 4096, maxTotalStreamTokens: 16384, maxTotalStreamTokenBytes: 262144 };
const context = { ...run, requestId: 'synthetic-request', generationCallId: 1 };
const unobservedLoad = { status: 'not-observed', reason: 'no-completed-load' } as const;
function fixture({ overrides }: { overrides: Partial<typeof limits> }) {
  const capture = createGenerationCapture({ run, limits: { ...limits, ...overrides }, tensorClass: runtime.Tensor });
  const call = capture.beginCall({ context, loadIdentity: unobservedLoad });
  if (!call) throw new Error('Expected a recording call');
  const invocation = call.beginInvocation();
  if (!invocation) throw new Error('Expected a recording invocation');
  return { capture, call, invocation };
}
function take({ capture }: { capture: ReturnType<typeof createGenerationCapture> }) {
  const result = capture.take({ run });
  expect(result.status).toBe('captured');
  if (result.status !== 'captured') throw new Error('Expected captured result');
  return result.capture;
}
const setting: GenerationInvocationObservation = Object.freeze({
  requested: Object.freeze({ maxCompletionTokens: Object.freeze({ status: 'value', value: 16 }), temperature: Object.freeze({ status: 'undefined' }), topP: Object.freeze({ status: 'omitted' }) }),
  budget: Object.freeze({ maxNewTokens: 3, source: 'explicit', contextLimit: 5, promptTokenCount: 2, pastTokenCount: 0, usedContextTokenCount: 2 }),
  kwargs: Object.freeze({
    keys: Object.freeze({ status: 'complete', totalCount: 1, values: Object.freeze(['max_new_tokens']), incompleteReasons: Object.freeze([]) }),
    maxNewTokens: Object.freeze({ status: 'value', value: 3 }), temperature: Object.freeze({ status: 'value', value: 0.6 }),
    topP: Object.freeze({ status: 'value', value: 0.9 }), doSample: Object.freeze({ status: 'value', value: true }), returnDictInGenerate: Object.freeze({ status: 'value', value: true }),
  }),
});

describe('Worker-local capture using actual Production bundle Tensor objects', () => {
  it.each([
    ['empty', []], ['zero', [[0, 1]]], ['negative', [[1, -1]]], ['fraction', [[1, 1.5]]],
    ['NaN', [[1, NaN]]], ['infinity', [[1, Infinity]]], ['unsafe integer', [[1, Number.MAX_SAFE_INTEGER + 1]]],
    ['one column', [[1]]], ['three columns', [[1, 2, 3]]], ['too many rows', Array.from({ length: 9 }, () => [1, 1])],
    ['row hole', [new Array(2)]], ['outer hole', new Array(1)], ['typed view', [Uint32Array.of(1, 2)]],
    ['extra row property', [Object.assign([1, 2], { extra: 1 })]], ['extra outer property', Object.assign([[1, 2]], { extra: 1 })],
  ])('does not record invalid image sizes: %s', (_label, value) => {
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.recordInputs({ phase: 'native-kwargs', inputs: { original_sizes: value } });
    call.finish({ outcome: 'fulfilled' });
    const result = take({ capture });
    expect(result.events[0]).toMatchObject({ values: [{ name: 'original_sizes', snapshot: { status: 'not-recorded', reason: 'invalid-data' } }] });
    expect(result.incompleteReasons).toContain('unrecorded-value');
  });

  it('never evaluates image-size getters at the field, row or dimension boundary', () => {
    const getter = vi.fn(() => 1);
    const row = [1, 2];
    Object.defineProperty(row, '0', { get: getter });
    const matrix = [[1, 2]];
    Object.defineProperty(matrix, '0', { get: getter });
    const { capture, call, invocation } = fixture({ overrides: {} });
    const inputs = { original_sizes: [[1, 1]] };
    Object.defineProperty(inputs, 'original_sizes', { get: getter });
    invocation.recordInputs({ phase: 'native-kwargs', inputs });
    invocation.recordInputs({ phase: 'native-kwargs', inputs: { original_sizes: [row], reshaped_input_sizes: matrix } });
    call.finish({ outcome: 'fulfilled' });
    expect(take({ capture }).incompleteReasons).toContain('unrecorded-value');
    expect(getter).not.toHaveBeenCalled();
  });

  it('reserves bounded pretty-JSON bytes for repeated image metadata across native invocations', () => {
    const { capture, call, invocation } = fixture({ overrides: { maxEvents: 64 } });
    const values = Array.from({ length: 8 }, () => [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
    const field = { name: 'reshaped_input_sizes', snapshot: { status: 'image-sizes', values } };
    const pretty = JSON.stringify(field, undefined, 2);
    expect(new TextEncoder().encode(JSON.stringify(field)).byteLength).toBeLessThanOrEqual(GENERATION_CAPTURE_IMAGE_SIZE_FIELD_BYTES);
    expect(pretty.length + 32 * pretty.split('\n').length + 1).toBeLessThanOrEqual(GENERATION_CAPTURE_IMAGE_SIZE_SERIALIZED_FIELD_BYTES);
    const count = GENERATION_CAPTURE_IMAGE_SIZE_TOTAL_BYTES / GENERATION_CAPTURE_IMAGE_SIZE_SERIALIZED_FIELD_BYTES;
    for (let index = 0; index < count; index++) invocation.recordInputs({ phase: 'pre-budget', inputs: { original_sizes: values } });
    const nextInvocation = call.beginInvocation();
    if (!nextInvocation) throw new Error('Expected second native invocation');
    nextInvocation.recordInputs({ phase: 'native-kwargs', inputs: { reshaped_input_sizes: values } });
    call.finish({ outcome: 'fulfilled' });
    const result = take({ capture });
    expect(result.events.at(-1)).toMatchObject({ values: [{ snapshot: { status: 'not-recorded', reason: 'metadata-limit' } }] });
    expect(result.events.slice(0, count).every(event => event.kind === 'inputs' && event.values[0]?.snapshot.status === 'image-sizes')).toBe(true);
    expect(result.incompleteReasons).toEqual(['metadata-limit', 'unrecorded-value']);
    expect(values).toEqual(Array.from({ length: 8 }, () => [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]));
    const forged = structuredClone(result);
    const last = forged.events.at(-1);
    if (last?.kind !== 'inputs') throw new Error('Expected last inputs');
    Reflect.set(last.values[0]!, 'snapshot', field.snapshot);
    expect(generationCaptureTakeResultSchema.safeParse({ status: 'captured', capture: forged }).success).toBe(false);
  });

  it('rejects forged metadata tags, keys and invalid matrices on capture receipt', () => {
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.recordInputs({ phase: 'native-kwargs', inputs: { original_sizes: [[1, 2]] } });
    call.finish({ outcome: 'fulfilled' });
    const source = take({ capture });
    for (const name of ['input_ids', 'num_soft_tokens_per_image', 'private_metadata']) {
      const forged = structuredClone(source);
      const event = forged.events[0];
      if (event?.kind !== 'inputs') throw new Error('Expected inputs');
      event.values[0]!.name = name;
      expect(generationCaptureTakeResultSchema.safeParse({ status: 'captured', capture: forged }).success).toBe(false);
    }
    const event = source.events[0];
    if (event?.kind !== 'inputs') throw new Error('Expected inputs');
    const getter = vi.fn(() => 1);
    const row = [1, 2];
    Object.defineProperty(row, '0', { get: getter });
    Reflect.set(event.values[0]!.snapshot, 'values', [row]);
    expect(generationCaptureTakeResultSchema.safeParse({ status: 'captured', capture: source }).success).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
  it('captures ordered image size metadata separately from tensors without retaining mutable input', () => {
    const { capture, call, invocation } = fixture({ overrides: {} });
    const original = [[1, 2], [3, 4]];
    invocation.recordInputs({ phase: 'native-kwargs', inputs: { original_sizes: original, reshaped_input_sizes: [[256, 512], [768, 1024]] } });
    original[0]![0] = 999;
    call.finish({ outcome: 'fulfilled' });
    const result = take({ capture });
    expect(result.events[0]).toMatchObject({ values: [
      { name: 'original_sizes', snapshot: { status: 'image-sizes', values: [[1, 2], [3, 4]] } },
      { name: 'reshaped_input_sizes', snapshot: { status: 'image-sizes', values: [[256, 512], [768, 1024]] } },
    ] });
    expect(result.incompleteReasons).toEqual([]);
  });
  it('copies a completed Load identity into each call independently of later source mutation', () => {
    const identity = productionLoadIdentitySchema.parse({
      status: 'ready', workerLoadOrdinal: 1, requestedModelId: 'synthetic/model', requestedRevision: { status: 'omitted' },
      cleanModelId: 'synthetic/model', autoClass: 'AutoModelForCausalLM', processor: 'tokenizer', selectedCandidate: { device: 'wasm', dtype: 'q4' },
      resolvedRevision: { status: 'not-observed' }, sessionExecutionProvider: { status: 'not-observed' },
    });
    const expected = structuredClone(identity);
    const capture = createGenerationCapture({ run, limits, tensorClass: runtime.Tensor });
    const call = capture.beginCall({ context, loadIdentity: identity });
    if (!call || identity.status !== 'ready') throw new Error('Expected ready Load and recording call');
    identity.selectedCandidate.dtype = 'q4f16';
    call.finish({ outcome: 'rejected' });
    expect(take({ capture }).calls[0]?.loadIdentity).toEqual(expected);
  });

  it('rejects a received call that omits the mandatory Load observation state', () => {
    const { capture, call } = fixture({ overrides: {} });
    call.finish({ outcome: 'fulfilled' });
    const result = { status: 'captured', capture: take({ capture }) };
    Reflect.deleteProperty(result.capture.calls[0]!, 'loadIdentity');
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects received ready Load metadata whose normalized model identity disagrees', () => {
    const { capture, call } = fixture({ overrides: {} });
    call.finish({ outcome: 'fulfilled' });
    const result = { status: 'captured', capture: take({ capture }) };
    Reflect.set(result.capture.calls[0]!, 'loadIdentity', {
      status: 'ready', workerLoadOrdinal: 1, requestedModelId: 'synthetic/model', requestedRevision: { status: 'omitted' },
      cleanModelId: 'other/model', autoClass: 'AutoModelForCausalLM', processor: 'tokenizer', selectedCandidate: { device: 'wasm', dtype: 'q4' },
      resolvedRevision: { status: 'not-observed' }, sessionExecutionProvider: { status: 'not-observed' },
    });
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('copies offset int64 IDs and float32 pixels without rounding or sharing source buffers', () => {
    const originalIds = BigInt64Array.of(-1n, 9007199254740993n, 7n, -2n);
    const ids = new runtime.Tensor('int64', originalIds.subarray(1, 3), [1, 2]);
    const pixels = new runtime.Tensor('float32', Float32Array.of(0.25, -0.5), [1, 2]);
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.recordInputs({ phase: 'native-kwargs', inputs: { input_ids: ids, pixel_values: pixels, num_soft_tokens_per_image: [256] } });
    originalIds[1] = 99n;
    (pixels.data as Float32Array)[0] = 1;
    call.finish({ outcome: 'fulfilled' });
    const result = take({ capture });
    expect(result.byteOrder).toBe(new Uint8Array(Uint16Array.of(0x0102).buffer)[0] === 2 ? 'little-endian' : 'big-endian');
    expect(result.incompleteReasons).toEqual([]);
    expect(result.unobserved).toEqual(['native-stop-cause', 'native-forward-input', 'kv-bytes']);
    expect(result.calls[0]?.invocations[0]?.stream).toEqual({ status: 'not-attempted' });
    const event = result.events[0];
    if (event?.kind !== 'inputs') throw new Error('Expected input event');
    const idSnapshot = event.values[0]?.snapshot;
    const pixelSnapshot = event.values[1]?.snapshot;
    if (idSnapshot?.status !== 'captured' || pixelSnapshot?.status !== 'captured') throw new Error('Actual CPU tensors were not captured');
    expect(idSnapshot.dtype).toBe('int64');
    expect(idSnapshot.dims).toEqual([1, 2]);
    expect(Array.from(new BigInt64Array(idSnapshot.bytes.buffer))).toEqual([9007199254740993n, 7n]);
    expect(Array.from(new Float32Array(pixelSnapshot.bytes.buffer))).toEqual([0.25, -0.5]);
    expect(idSnapshot.bytes.buffer).not.toBe(originalIds.buffer);
    expect(event.values[2]?.snapshot).toEqual({ status: 'scalar', values: [256] });
    const moved = structuredClone(idSnapshot.bytes, { transfer: [idSnapshot.bytes.buffer] });
    expect(idSnapshot.bytes.byteLength).toBe(0);
    expect(moved.byteLength).toBe(16);
    expect(originalIds.byteLength).toBe(32);
    expect(originalIds[1]).toBe(99n);
    invocation.recordInputs({ phase: 'native-kwargs', inputs: { input_ids: ids } });
    expect(capture.take({ run })).toEqual({ status: 'already-taken' });
  });

  it('records both direct Tensor and return-dictionary sequences using actual native Tensor layouts', () => {
    const result = new runtime.Tensor('int64', BigInt64Array.of(2n, 3n), [1, 2]);
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.recordSequence({ result });
    invocation.recordSequence({ result: { sequences: result } });
    call.finish({ outcome: 'fulfilled' });
    const events = take({ capture }).events;
    expect(events.map(event => event.kind === 'sequence' && event.resultShape)).toEqual(['tensor', 'dictionary']);
    for (const event of events) {
      if (event.kind !== 'sequence' || event.snapshot.status !== 'captured') throw new Error('Missing native sequence capture');
      expect(Array.from(new BigInt64Array(event.snapshot.bytes.buffer))).toEqual([2n, 3n]);
    }
  });

  it('does not call Tensor public getters, inspect KV fields, or read CPU data in a GPU-marked layout', () => {
    const cpu = new runtime.Tensor('float32', Float32Array.of(0.5), [1]);
    const gpu = new runtime.Tensor('float32', Float32Array.of(1), [1]);
    const publicGetter = vi.fn(() => {
      throw new Error('Public Tensor getter must not run');
    });
    Object.defineProperty(cpu, 'data', { get: publicGetter });
    Object.defineProperty(cpu, 'location', { get: publicGetter });
    // Actual runtime Tensor with an instance-only GPU layout counterexample;
    // this does not allocate a GPU buffer or claim native GPU execution.
    const ort = Object.getOwnPropertyDescriptor(gpu, 'ort_tensor')!.value as object;
    Object.defineProperty(ort, 'dataLocation', { value: 'gpu-buffer' });
    Object.defineProperty(ort, 'cpuData', { get: publicGetter });
    const inputs = { input_ids: cpu, pixel_values: gpu };
    Object.defineProperty(inputs, 'past_key_values', { enumerable: true, get: publicGetter });
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.recordInputs({ phase: 'native-kwargs', inputs });
    call.finish({ outcome: 'fulfilled' });
    const event = take({ capture }).events[0];
    if (event?.kind !== 'inputs') throw new Error('Expected inputs');
    expect(event.values.map(value => value.snapshot.status)).toEqual(['captured', 'not-recorded', 'not-recorded']);
    expect(event.values[1]?.snapshot).toEqual({ status: 'not-recorded', reason: 'not-cpu' });
    expect(event.values[2]?.snapshot).toEqual({ status: 'not-recorded', reason: 'excluded-field' });
    expect(publicGetter).not.toHaveBeenCalled();
  });

  it('rejects SharedArrayBuffer-backed CPU snapshots instead of claiming a stable byte capture', () => {
    const values = new Float32Array(new SharedArrayBuffer(4));
    const tensor = new runtime.Tensor('float32', values, [1]);
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.recordInputs({ phase: 'native-kwargs', inputs: { pixel_values: tensor } });
    call.finish({ outcome: 'fulfilled' });
    const event = take({ capture }).events[0];
    expect(event?.kind === 'inputs' && event.values[0]?.snapshot).toEqual({ status: 'not-recorded', reason: 'shared-buffer' });
  });

  it('retains partial input, settings, and stream records on rejection without changing the immutable settings source', () => {
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.recordInputs({ phase: 'pre-budget', inputs: { input_ids: new runtime.Tensor('int64', BigInt64Array.of(1n, 2n), [1, 2]) } });
    invocation.recordSettings({ observation: setting });
    invocation.recordChunk({ phase: 'strategy-output', chunk: '' });
    invocation.recordChunk({ phase: 'worker-send', chunk: 'partial ' });
    call.finish({ outcome: 'rejected' });
    const result = take({ capture });
    expect(result.calls[0]?.outcome).toBe('rejected');
    expect(result.events.map(event => event.kind)).toEqual(['inputs', 'settings', 'chunk', 'chunk']);
    const settings = result.events[1];
    if (settings?.kind !== 'settings') throw new Error('Expected settings');
    expect(settings.value).toEqual(setting);
    settings.value.budget.maxNewTokens = 99;
    expect(setting.budget.maxNewTokens).toBe(3);
    expect(Object.isFrozen(setting.kwargs.keys.values)).toBe(true);
  });

  it('keeps request/call/native ordinals distinct and refuses busy or wrong-epoch take without discarding records', () => {
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.recordChunk({ phase: 'strategy-output', chunk: 'a' });
    expect(capture.take({ run })).toEqual({ status: 'busy' });
    expect(capture.take({ run: { ...run, workerEpoch: 2 } })).toEqual({ status: 'wrong-run' });
    call.beginInvocation()!.recordChunk({ phase: 'strategy-output', chunk: 'b' });
    call.finish({ outcome: 'fulfilled' });
    const toolFollowup = capture.beginCall({ context: { ...context, generationCallId: 2 }, loadIdentity: unobservedLoad })!;
    toolFollowup.beginInvocation()!.recordChunk({ phase: 'strategy-output', chunk: 'c' });
    toolFollowup.finish({ outcome: 'fulfilled' });
    const nextRequest = capture.beginCall({ context: { ...context, requestId: 'second-request', generationCallId: 3 }, loadIdentity: unobservedLoad })!;
    nextRequest.beginInvocation()!.recordChunk({ phase: 'strategy-output', chunk: 'd' });
    nextRequest.finish({ outcome: 'fulfilled' });
    expect(take({ capture }).events.map(event => [event.identity.requestId, event.identity.generationCallId, event.identity.nativeInvocationOrdinal]))
      .toEqual([['synthetic-request', 1, 1], ['synthetic-request', 1, 2], ['synthetic-request', 2, 1], ['second-request', 3, 1]]);
  });

  it('enforces per-tensor and retained-run byte limits before copying oversized inputs', () => {
    const { capture, call, invocation } = fixture({ overrides: { maxTensorBytes: 8, maxTotalTensorBytes: 8 } });
    invocation.recordInputs({ phase: 'native-kwargs', inputs: {
      input_ids: new runtime.Tensor('int64', BigInt64Array.of(1n, 2n), [1, 2]),
      pixel_values: new runtime.Tensor('float32', Float32Array.of(1), [1]),
      attention_mask: new runtime.Tensor('int64', BigInt64Array.of(1n), [1]),
    } });
    call.finish({ outcome: 'fulfilled' });
    const result = take({ capture });
    const event = result.events[0];
    if (event?.kind !== 'inputs') throw new Error('Expected inputs');
    expect(event.values.map(value => value.snapshot.status === 'not-recorded' ? value.snapshot.reason : value.snapshot.status)).toEqual(['tensor-limit', 'captured', 'total-tensor-limit']);
    expect(result.incompleteReasons).toContain('tensor-limit');
    expect(result.incompleteReasons).toContain('total-tensor-limit');
  });

  it('bounds event/text/call/invocation growth and preserves normal caller execution after overflow', () => {
    const { capture, call, invocation } = fixture({ overrides: { maxCalls: 1, maxInvocationsPerCall: 1, maxEvents: 2, maxTextBytes: 3 } });
    invocation.recordChunk({ phase: 'strategy-output', chunk: '日本' });
    invocation.recordChunk({ phase: 'strategy-output', chunk: 'abc' });
    invocation.recordChunk({ phase: 'worker-send', chunk: '' });
    invocation.recordChunk({ phase: 'worker-send', chunk: '' });
    expect(call.beginInvocation()).toBeUndefined();
    call.finish({ outcome: 'fulfilled' });
    expect(capture.beginCall({ context: { ...context, generationCallId: 2 }, loadIdentity: unobservedLoad })).toBeUndefined();
    const result = take({ capture });
    expect(result.events).toHaveLength(2);
    expect(new Set(result.incompleteReasons)).toEqual(new Set(['text-limit', 'event-limit', 'invocation-limit', 'call-limit']));
  });

  it('contains hostile input snapshot failures and does not evaluate accessor-valued inputs', () => {
    const { capture, call, invocation } = fixture({ overrides: {} });
    const getter = vi.fn(() => {
      throw new Error('Synthetic accessor');
    });
    const inputs = Object.defineProperty({}, 'input_ids', { enumerable: true, get: getter });
    invocation.recordInputs({ phase: 'native-kwargs', inputs });
    invocation.recordInputs({ phase: 'native-kwargs', inputs: new Proxy({}, { ownKeys() {
      throw new Error('Synthetic proxy');
    } }) });
    invocation.recordSequence({ result: Object.defineProperty({}, 'sequences', { get: getter }) });
    call.finish({ outcome: 'rejected' });
    const result = take({ capture });
    expect(getter).not.toHaveBeenCalled();
    expect(result.incompleteReasons).toContain('snapshot-error');
    expect(result.events).toHaveLength(2);
  });
});

describe('capture receive schemas reject forged or ambiguous data', () => {
  function validResult() {
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.recordInputs({ phase: 'native-kwargs', inputs: { input_ids: new runtime.Tensor('int64', BigInt64Array.of(1n), [1]) } });
    invocation.recordSettings({ observation: setting });
    call.finish({ outcome: 'fulfilled' });
    return { status: 'captured' as const, capture: take({ capture }) };
  }
  function capturedInput({ result }: { result: ReturnType<typeof validResult> }) {
    const event = result.capture.events[0];
    if (event?.kind !== 'inputs') throw new Error('Expected input event');
    const value = event.values[0];
    if (value?.snapshot.status !== 'captured') throw new Error('Expected captured tensor');
    return { event, value, snapshot: value.snapshot };
  }

  it('rejects a foreign call run even without events', () => {
    const result = validResult();
    result.capture.events = [];
    result.capture.calls[0]!.context.runId = 'different';
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects a foreign worker epoch even without events', () => {
    const result = validResult();
    result.capture.events = [];
    result.capture.calls[0]!.context.workerEpoch = 2;
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects duplicate generation call identities even without events', () => {
    const result = validResult();
    result.capture.events = [];
    result.capture.calls.push(structuredClone(result.capture.calls[0]!));
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects a captured result containing an active call even without events', () => {
    const result = validResult();
    result.capture.events = [];
    result.capture.calls[0]!.outcome = 'active';
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects dimensions that disagree with the captured byte length', () => {
    const result = validResult();
    capturedInput({ result }).snapshot.dims = [2];
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects a dtype whose element width disagrees with the captured bytes', () => {
    const result = validResult();
    capturedInput({ result }).snapshot.dtype = 'float32';
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects dimension multiplication overflow', () => {
    const result = validResult();
    capturedInput({ result }).snapshot.dims = [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects a byte buffer whose actual length disagrees with its metadata', () => {
    const result = validResult();
    capturedInput({ result }).snapshot.bytes = new Uint8Array(4);
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects received SharedArrayBuffer-backed bytes even when shape and lengths match', () => {
    const result = validResult();
    const snapshot = capturedInput({ result }).snapshot;
    Object.defineProperty(snapshot, 'bytes', { value: new Uint8Array(new SharedArrayBuffer(snapshot.byteLength)) });
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects captured tensor bytes under an excluded KV field name', () => {
    const result = validResult();
    capturedInput({ result }).value.name = 'past_key_values';
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects duplicate input field names', () => {
    const result = validResult();
    const { event, value } = capturedInput({ result });
    event.values.push(structuredClone(value));
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects a native invocation ordinal exceeding the configured per-call limit', () => {
    const result = validResult();
    capturedInput({ result }).event.identity.nativeInvocationOrdinal = 3;
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects an event associated with an unrelated request', () => {
    const result = validResult();
    capturedInput({ result }).event.identity.requestId = 'unrelated';
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects settings that no longer match the invocation observation contract', () => {
    const result = validResult();
    Reflect.set(result.capture.events[1]!, 'value', { unknown: true });
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects invalid incoming context and excessive configured capture capacities', () => {
    expect(generationCaptureContextSchema.safeParse({ ...context, requestId: 'x'.repeat(129) }).success).toBe(false);
    expect(() => createGenerationCapture({ run, tensorClass: runtime.Tensor, limits: { ...limits, maxTotalTensorBytes: 65 * 1024 * 1024 } })).toThrow();
    const { capture, call } = fixture({ overrides: {} });
    expect(capture.beginCall({ context: { ...context, unexpected: true }, loadIdentity: unobservedLoad })).toBeUndefined();
    call.finish({ outcome: 'fulfilled' });
    expect(take({ capture }).incompleteReasons).toContain('invalid-context');
  });
});

describe('native stream token recording and receive limits', () => {
  function validStreamResult() {
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.setNativeStreamAvailability({ availability: { status: 'available', restoration: 'pending' } });
    invocation.recordNativeStream({ operation: 'put', phase: 'entering', streamCallOrdinal: 1, args: [[[1n, 2n]]] });
    invocation.setNativeStreamAvailability({ availability: { status: 'available', restoration: 'restored' } });
    call.finish({ outcome: 'fulfilled' });
    const result = { status: 'captured' as const, capture: take({ capture }) };
    const event = result.capture.events[0];
    if (event?.kind !== 'native-stream' || event.detail.kind !== 'tokens') throw new Error('Expected recorded token group');
    return { result, event, tokens: event.detail };
  }

  it('rejects received token groups exceeding the configured per-event capacity', () => {
    const { result } = validStreamResult();
    result.capture.limits.maxTokensPerStreamEvent = 1;
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects received token groups exceeding the configured run token count', () => {
    const { result } = validStreamResult();
    result.capture.limits.maxTotalStreamTokens = 1;
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects received token strings exceeding the configured run byte capacity', () => {
    const { result } = validStreamResult();
    result.capture.limits.maxTotalStreamTokenBytes = 1;
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects a received decimal token that cannot preserve bigint identity', () => {
    const { result, tokens } = validStreamResult();
    tokens.groups[0]![0] = '1.5';
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects a received integer token outside the recorded signed 64-bit range', () => {
    const { result, tokens } = validStreamResult();
    tokens.groups[0]![0] = '9223372036854775808';
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects received stream events whose invocation hook was unavailable', () => {
    const { result } = validStreamResult();
    result.capture.calls[0]!.invocations[0]!.stream = { status: 'unavailable', reason: 'already-owned' };
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects a received put payload relabeled as an end event', () => {
    const { result, event } = validStreamResult();
    event.operation = 'end';
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects duplicate per-call invocation identities even without events', () => {
    const { result } = validStreamResult();
    result.capture.events = [];
    result.capture.calls[0]!.invocations.push(structuredClone(result.capture.calls[0]!.invocations[0]!));
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('rejects finalized text that exceeds the received UTF-8 text budget', () => {
    const { result, event } = validStreamResult();
    event.operation = 'on_finalized_text';
    event.detail = { kind: 'finalized-text', text: '日本', streamEnd: false };
    result.capture.limits.maxTextBytes = 3;
    expect(generationCaptureTakeResultSchema.safeParse(result).success).toBe(false);
  });

  it('keeps detached bigint groups and finalized text with their original stream call ordinals', () => {
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.setNativeStreamAvailability({ availability: { status: 'available', restoration: 'pending' } });
    const groups = [[9007199254740993n, 7n], [8n]];
    invocation.recordNativeStream({ operation: 'put', phase: 'entering', streamCallOrdinal: 1, args: [groups] });
    groups[0]![0] = 99n;
    invocation.recordNativeStream({ operation: 'on_finalized_text', phase: 'entering', streamCallOrdinal: 2, args: ['', true] });
    invocation.setNativeStreamAvailability({ availability: { status: 'available', restoration: 'restored' } });
    call.finish({ outcome: 'fulfilled' });
    const result = take({ capture });
    expect(result.calls[0]?.invocations).toEqual([{ nativeInvocationOrdinal: 1, stream: { status: 'available', restoration: 'restored' } }]);
    expect(result.events.map(event => event.kind === 'native-stream' && [event.streamCallOrdinal, event.detail])).toEqual([
      [1, { kind: 'tokens', tokenType: 'bigint', groups: [['9007199254740993', '7'], ['8']] }],
      [2, { kind: 'finalized-text', text: '', streamEnd: true }],
    ]);
    expect(result.unobserved).toContain('native-stop-cause');
  });

  it('records per-invocation unavailable separately from a boundary never attempted', () => {
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.setNativeStreamAvailability({ availability: { status: 'unavailable', reason: 'method-descriptor' } });
    call.beginInvocation();
    call.finish({ outcome: 'rejected' });
    expect(take({ capture }).calls[0]?.invocations).toEqual([
      { nativeInvocationOrdinal: 1, stream: { status: 'unavailable', reason: 'method-descriptor' } },
      { nativeInvocationOrdinal: 2, stream: { status: 'not-attempted' } },
    ]);
  });

  it('bounds tokens per put without truncating the original argument or claiming a complete snapshot', () => {
    const { capture, call, invocation } = fixture({ overrides: { maxTokensPerStreamEvent: 1 } });
    invocation.setNativeStreamAvailability({ availability: { status: 'available', restoration: 'pending' } });
    const tokens = [[1n, 2n]];
    invocation.recordNativeStream({ operation: 'put', phase: 'entering', streamCallOrdinal: 1, args: [tokens] });
    call.finish({ outcome: 'fulfilled' });
    const result = take({ capture });
    expect(tokens).toEqual([[1n, 2n]]);
    expect(result.events[0]).toMatchObject({ detail: { kind: 'not-recorded', reason: 'stream-token-limit' } });
    expect(result.incompleteReasons).toContain('stream-token-limit');
  });

  it('bounds total token count across separate stream puts', () => {
    const { capture, call, invocation } = fixture({ overrides: { maxTotalStreamTokens: 1 } });
    invocation.setNativeStreamAvailability({ availability: { status: 'available', restoration: 'pending' } });
    invocation.recordNativeStream({ operation: 'put', phase: 'entering', streamCallOrdinal: 1, args: [[[1n]]] });
    invocation.recordNativeStream({ operation: 'put', phase: 'entering', streamCallOrdinal: 2, args: [[[2n]]] });
    call.finish({ outcome: 'fulfilled' });
    const result = take({ capture });
    expect(result.events[1]).toMatchObject({ detail: { kind: 'not-recorded', reason: 'stream-total-token-limit' } });
  });

  it('bounds decimal token bytes independently of the token count', () => {
    const { capture, call, invocation } = fixture({ overrides: { maxTotalStreamTokenBytes: 1 } });
    invocation.setNativeStreamAvailability({ availability: { status: 'available', restoration: 'pending' } });
    invocation.recordNativeStream({ operation: 'put', phase: 'entering', streamCallOrdinal: 1, args: [[[10n]]] });
    call.finish({ outcome: 'fulfilled' });
    expect(take({ capture }).events[0]).toMatchObject({ detail: { kind: 'not-recorded', reason: 'stream-token-byte-limit' } });
  });

  it('does not coerce number tokens or evaluate accessor-valued token elements', () => {
    const { capture, call, invocation } = fixture({ overrides: {} });
    invocation.setNativeStreamAvailability({ availability: { status: 'available', restoration: 'pending' } });
    const getter = vi.fn(() => {
      throw new Error('Token accessor must not run');
    });
    const row = Object.defineProperty([1n], '0', { get: getter });
    invocation.recordNativeStream({ operation: 'put', phase: 'entering', streamCallOrdinal: 1, args: [[[1]]] });
    invocation.recordNativeStream({ operation: 'put', phase: 'entering', streamCallOrdinal: 2, args: [[row]] });
    call.finish({ outcome: 'fulfilled' });
    expect(getter).not.toHaveBeenCalled();
    expect(take({ capture }).events.map(event => event.kind === 'native-stream' && event.detail)).toEqual([
      { kind: 'not-recorded', reason: 'stream-token-type' }, { kind: 'not-recorded', reason: 'stream-token-type' },
    ]);
  });

  it('shares the bounded UTF-8 text budget between finalized text and outgoing chunks', () => {
    const { capture, call, invocation } = fixture({ overrides: { maxTextBytes: 3 } });
    invocation.setNativeStreamAvailability({ availability: { status: 'available', restoration: 'pending' } });
    invocation.recordNativeStream({ operation: 'on_finalized_text', phase: 'entering', streamCallOrdinal: 1, args: ['日', false] });
    invocation.recordChunk({ phase: 'worker-send', chunk: 'a' });
    call.finish({ outcome: 'fulfilled' });
    const result = take({ capture });
    expect(result.events).toHaveLength(1);
    expect(result.incompleteReasons).toContain('text-limit');
  });
});
