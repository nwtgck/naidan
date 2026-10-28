import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { Q8KernelDiagnosticAdapter, Q8KernelDiagnosticResult, Q8KernelDiagnosticVariant } from '@/features/llama-cpp-browser/runtime/q8-kernel-diagnostic';
import { beginGpuProfileMeasurement } from '@/features/llama-cpp-browser/runtime/gpu-profiler';
import { q8KernelBenchmarkSchema, q8KernelBenchmarkProgressSchema, q8KernelProfileQualified, q8KernelShapes, q8KernelVariants, type Q8KernelBenchmark, type Q8KernelBenchmarkProgress, type Q8KernelShape, type Q8KernelSample } from '@/features/llama-cpp-browser/performance/q8-kernel-schema';

const transferBytes = 64 * 1024;
const fixtureSeed = 0x6d2b79f5;
type Shape = readonly [number, number];
type NativeCall = { report: Q8KernelDiagnosticResult, wallMs: number };
type BenchmarkInput = {
  core: Core, diagnostic: Q8KernelDiagnosticAdapter, signal: AbortSignal | undefined,
  onProgress: ({ progress }: { progress: Q8KernelBenchmarkProgress }) => void,
};

async function sha256({ bytes }: { bytes: Uint8Array<ArrayBuffer> }): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
}

/** Self-authored Q8_0 blocks. Every product is an integer / 256 and every
 * possible partial integer sum is below 2^24. This is an exact dyadic fixture,
 * not an accuracy claim about arbitrary quantized model weights. */
function createFixture({ k, m }: { k: number, m: number }) {
  if (!Number.isInteger(k) || k < 32 || k > 16384 || k % 32 || !Number.isInteger(m) || m < 1 || m > 65536 || k / 32 * 34 * m >= 64 * 1024 * 1024 || k * 64 >= 2 ** 24) {
    throw new RangeError('Invalid Q8 benchmark fixture shape');
  }
  const seed = (fixtureSeed ^ k ^ (m << 16)) >>> 0;
  let state = seed;
  function integer(): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % 17 - 8;
  }
  const input = new Uint8Array(k * 4), inputView = new DataView(input.buffer), integers = new Int8Array(k);
  for (let column = 0; column < k; column++) {
    integers[column] = integer();
    inputView.setFloat32(column * 4, integers[column]! / 16, true);
  }
  const weights = new Uint8Array(k / 32 * 34 * m), expected = new Uint8Array(m * 4), output = new DataView(expected.buffer);
  for (let row = 0; row < m; row++) {
    let sum = 0;
    for (let block = 0; block < k / 32; block++) {
      const offset = (row * k / 32 + block) * 34;
      weights[offset] = 0;
      weights[offset + 1] = 0x2c; // fp16 1/16, little endian.
      for (let lane = 0; lane < 32; lane++) {
        const quant = integer();
        weights[offset + 2 + lane] = quant & 255;
        sum += quant * integers[block * 32 + lane]!;
      }
    }
    output.setFloat32(row * 4, sum / 256, true);
  }
  return { seed, weights, input, expected, maximumAbsoluteIntegerSum: k * 64 };
}

function identity({ report }: { report: Q8KernelShape['variants'][number]['prepare']['report'] }): string {
  const { phase: _phase, dispatches: _dispatches, nativeWallMs: _nativeWallMs, status: _status, ...tuple } = report;
  return JSON.stringify(tuple);
}

async function runBenchmark({ input, shapes, validate }: { input: BenchmarkInput, shapes: readonly Shape[], validate: ({ result }: { result: Q8KernelBenchmark }) => Q8KernelBenchmark }): Promise<Q8KernelBenchmark> {
  const { core, diagnostic, signal, onProgress } = input;
  const cancelled = Symbol('Q8 benchmark cancellation');
  let safeToCleanup = true;
  let backend = 0n;
  let completedSamples = 0;
  const result: Q8KernelBenchmark = { version: 1, fixtureId: 'q8-dyadic-v1', status: 'complete', repetitions: 32, rounds: 4, shapes: [] };
  const boundary = (): void => {
    if (signal?.aborted) {
      throw cancelled;
    }
  };
  const native = async <T>({ call }: { call: () => Promise<T> }): Promise<T> => {
    safeToCleanup = false;
    const value = await call();
    safeToCleanup = true;
    return value;
  };
  const nativeSync = <T>({ call }: { call: () => T }): T => {
    safeToCleanup = false;
    const value = call();
    safeToCleanup = true;
    return value;
  };
  const progress = ({ shapeIndex, phase }: { shapeIndex: number, phase: Q8KernelBenchmarkProgress['phase'] }) => {
    onProgress({ progress: q8KernelBenchmarkProgressSchema.parse({ shapeIndex, shapeCount: 8, phase, completedSamples, totalSamples: 192 }) });
  };
  const fail = ({ message }: { message: string }): never => {
    safeToCleanup = false;
    throw new Error(message);
  };
  const unsupported = ({ report }: { report: Q8KernelShape['variants'][number]['prepare']['report'] }): boolean => {
    switch (report.status) {
    case 'ok': return false;
    case 'unsupported': return true;
    case 'unavailable': case 'bad-request': case 'not-prepared': case 'busy': return fail({ message: `Unexpected Q8 native status: ${report.status}` });
    default: {
      const exhaustive: never = report.status;
      throw new Error(`Unhandled Q8 native status: ${exhaustive}`);
    }
    }
  };
  try {
    boundary();
    await native({ call: () => core.api.ggml_backend_load_all() });
    boundary();
    const name = nativeSync({ call: () => core.utf8({ text: 'WebGPU' }) });
    try {
      backend = await native({ call: () => core.api.ggml_backend_init_by_name(name, 0n) });
    } finally {
      if (safeToCleanup) {
        nativeSync({ call: () => core.free({ pointer: name }) });
      }
    }
    if (!backend) {
      fail({ message: 'Q8 diagnostic WebGPU backend initialization failed' });
    }
    boundary();
    for (const [shapeIndex, [k, m]] of shapes.entries()) {
      boundary();
      progress({ shapeIndex, phase: 'preparing' });
      const fixture = createFixture({ k, m });
      const shape: Q8KernelShape = {
        k,
        m,
        fixture: {
          seed: fixture.seed,
          weightBytes: fixture.weights.length,
          inputBytes: fixture.input.length,
          outputBytes: fixture.expected.length,
          weightSha256: await sha256({ bytes: fixture.weights }),
          inputSha256: await sha256({ bytes: fixture.input }),
          expectedSha256: await sha256({ bytes: fixture.expected }),
          maximumAbsoluteIntegerSum: fixture.maximumAbsoluteIntegerSum,
        },
        variants: [],
        samples: [],
      };
      result.shapes.push(shape);
      boundary();
      let context = 0n, buffer = 0n;
      const owned: bigint[] = [];
      try {
        const params = nativeSync({ call: () => core.allocRecord({ name: 'ggml_init_params' }) });
        owned.push(params);
        nativeSync({ call: () => core.setField({ name: 'ggml_init_params', pointer: params, field: 'mem_size', value: 1024n * 1024n }) });
        nativeSync({ call: () => core.setField({ name: 'ggml_init_params', pointer: params, field: 'mem_buffer', value: 0n }) });
        nativeSync({ call: () => core.setField({ name: 'ggml_init_params', pointer: params, field: 'no_alloc', value: 1 }) });
        context = await native({ call: () => core.api.ggml_init(params) });
        if (!context) {
          fail({ message: 'Q8 diagnostic ggml context allocation failed' });
        }
        const weights = await native({ call: () => core.api.ggml_new_tensor_2d(context, core.constant({ name: 'GGML_TYPE_Q8_0' }), BigInt(k), BigInt(m)) });
        const vector = await native({ call: () => core.api.ggml_new_tensor_2d(context, core.constant({ name: 'GGML_TYPE_F32' }), BigInt(k), 1n) });
        const dst = await native({ call: () => core.api.ggml_mul_mat(context, weights, vector) });
        const graph = await native({ call: () => core.api.ggml_new_graph_custom(context, 16n, 0) });
        await native({ call: () => core.api.ggml_build_forward_expand(graph, dst) });
        if (await native({ call: () => core.api.ggml_graph_n_nodes(graph) }) !== 1) {
          fail({ message: 'Unexpected Q8 diagnostic graph' });
        }
        buffer = await native({ call: () => core.api.ggml_backend_alloc_ctx_tensors(context, backend) });
        if (!buffer) {
          fail({ message: 'Q8 diagnostic tensor allocation failed' });
        }
        const transfer = nativeSync({ call: () => core.alloc({ bytes: transferBytes + 32 }) });
        owned.push(transfer);
        const upload = async ({ tensor, data }: { tensor: bigint, data: Uint8Array }): Promise<void> => {
          if (await native({ call: () => core.api.ggml_nbytes(tensor) }) !== BigInt(data.length)) {
            fail({ message: 'Unexpected Q8 tensor byte count' });
          }
          for (let offset = 0; offset < data.length; offset += transferBytes) {
            boundary();
            const chunk = data.subarray(offset, offset + transferBytes);
            core.bytes({ pointer: transfer, length: chunk.length }).set(chunk);
            await native({ call: () => core.api.ggml_backend_tensor_set(tensor, transfer, BigInt(offset), BigInt(chunk.length)) });
          }
        };
        await upload({ tensor: weights, data: fixture.weights });
        await upload({ tensor: vector, data: fixture.input });
        const download = async ({ tensor, data }: { tensor: bigint, data: Uint8Array }): Promise<Uint8Array<ArrayBuffer>> => {
          const captured = data.length <= transferBytes ? new Uint8Array(data.length) : new Uint8Array(0);
          for (let offset = 0; offset < data.length; offset += transferBytes) {
            boundary();
            const length = Math.min(transferBytes, data.length - offset);
            core.bytes({ pointer: transfer, length: length + 32 }).fill(0xcc);
            await native({ call: () => core.api.ggml_backend_tensor_get_async(backend, tensor, transfer + 16n, BigInt(offset), BigInt(length)) });
            boundary();
            const actual = core.bytes({ pointer: transfer + 16n, length });
            const guards = core.bytes({ pointer: transfer, length: 16 }).every(value => value === 0xcc)
              && core.bytes({ pointer: transfer + 16n + BigInt(length), length: 16 }).every(value => value === 0xcc);
            if (!guards || actual.some((value, index) => value !== data[offset + index])) {
              fail({ message: 'Q8 diagnostic exact bytes or readback guard mismatch' });
            }
            if (captured.length) {
              captured.set(actual, offset);
            }
          }
          return captured;
        };
        const invoke = async ({ variant, phase, repetitions }: { variant: Q8KernelDiagnosticVariant, phase: 'prepare' | 'execute', repetitions: number }): Promise<NativeCall> => {
          boundary();
          const started = performance.now();
          const report = await native({ call: () => diagnostic.run({ backend, dst, variant, phase, repetitions }) });
          if (report.status !== 'ok' && report.status !== 'unsupported') {
            fail({ message: `Unexpected Q8 native status: ${report.status}` });
          }
          return { report, wallMs: performance.now() - started };
        };
        const ready = new Map<Q8KernelDiagnosticVariant, string>();
        for (const variant of q8KernelVariants) {
          progress({ shapeIndex, phase: 'preparing' });
          const prepared = { variant, prepare: await invoke({ variant, phase: 'prepare', repetitions: 0 }) } as Q8KernelShape['variants'][number];
          shape.variants.push(prepared);
          boundary();
          if (unsupported({ report: prepared.prepare.report })) {
            result.status = 'partial';
          }
        }
        for (const prepared of shape.variants) {
          const { variant } = prepared;
          if (unsupported({ report: prepared.prepare.report })) {
            continue;
          }
          progress({ shapeIndex, phase: 'warming' });
          const warmup = { call: await invoke({ variant, phase: 'execute', repetitions: 1 }) } as NonNullable<typeof prepared.warmup>;
          prepared.warmup = warmup;
          boundary();
          if (unsupported({ report: warmup.call.report })) {
            result.status = 'partial';
            continue;
          }
          if (identity({ report: prepared.prepare.report }) !== identity({ report: warmup.call.report })) {
            fail({ message: 'Q8 warmup shader or launch identity changed' });
          }
          const readbackStarted = performance.now();
          const actual = await download({ tensor: dst, data: fixture.expected });
          warmup.readbackMs = performance.now() - readbackStarted;
          warmup.exact = { words: m, mismatches: 0, expectedSha256: shape.fixture.expectedSha256, actualSha256: await sha256({ bytes: actual }), guards: true };
          ready.set(variant, identity({ report: prepared.prepare.report }));
          boundary();
        }
        for (let round = 0; round < 4; round++) {
          const order = round % 2 ? [...q8KernelVariants].reverse() : [...q8KernelVariants];
          for (const [position, variant] of order.entries()) {
            if (!ready.has(variant)) {
              continue;
            }
            boundary();
            progress({ shapeIndex, phase: 'measuring' });
            const measurement = beginGpuProfileMeasurement();
            let sample: NativeCall;
            let gpuProfile: ReturnType<typeof measurement.finish>;
            try {
              sample = await invoke({ variant, phase: 'execute', repetitions: 32 });
            } finally {
              gpuProfile = measurement.finish();
            }
            if (sample.report.status !== 'ok' || identity({ report: sample.report }) !== ready.get(variant)) {
              fail({ message: 'Q8 measured shader or launch identity changed' });
            }
            const complete = q8KernelProfileQualified({ profile: gpuProfile });
            const timingStatus: Q8KernelSample['timingStatus'] = complete ? gpuProfile.zeroDurationPasses ? 'quantized' : 'measured' : gpuProfile.measuredPasses ? 'partial' : 'unavailable';
            boundary();
            const readbackStarted = performance.now();
            const actual = await download({ tensor: dst, data: fixture.expected });
            const readbackMs = performance.now() - readbackStarted;
            const exact = { words: m, mismatches: 0 as const, expectedSha256: shape.fixture.expectedSha256, actualSha256: await sha256({ bytes: actual }), guards: true as const };
            boundary();
            shape.samples.push({ variant, round, position, ...sample, gpuProfile, timingStatus, gpuMsPerDispatch: complete ? gpuProfile.totalGpuMs / 32 : undefined, readbackMs, exact });
            completedSamples++;
            boundary();
          }
        }
        progress({ shapeIndex, phase: 'verifying' });
        await download({ tensor: weights, data: fixture.weights });
        boundary();
        await download({ tensor: vector, data: fixture.input });
        shape.inputsUnchanged = {
          weights: true,
          input: true,
          guards: true,
          weightBytes: fixture.weights.length,
          inputBytes: fixture.input.length,
          weightSha256: shape.fixture.weightSha256,
          inputSha256: shape.fixture.inputSha256,
        };
        boundary();
      } finally {
        if (safeToCleanup) {
          if (buffer) {
            await native({ call: () => core.api.ggml_backend_buffer_free(buffer) });
          }
          if (context) {
            await native({ call: () => core.api.ggml_free(context) });
          }
          for (const pointer of owned.reverse()) {
            nativeSync({ call: () => core.free({ pointer }) });
          }
        }
      }
    }
  } catch (error) {
    if (error !== cancelled) {
      throw error;
    }
    result.status = 'cancelled';
  } finally {
    if (backend && safeToCleanup) {
      await native({ call: () => core.api.ggml_backend_free(backend) });
    }
  }
  return validate({ result });
}

/** Explicit, dedicated-Worker measurement only. The caller always terminates
 * that Worker afterward. Unexpected native failure deliberately skips frees. */
export function runQ8KernelBenchmark({ core, diagnostic, signal, onProgress }: {
  core: Core, diagnostic: Q8KernelDiagnosticAdapter, signal: AbortSignal | undefined,
  onProgress: ({ progress }: { progress: Q8KernelBenchmarkProgress }) => void,
}): Promise<Q8KernelBenchmark> {
  return runBenchmark({ input: { core, diagnostic, signal, onProgress }, shapes: q8KernelShapes, validate: ({ result }) => q8KernelBenchmarkSchema.parse(result) });
}

export const TEST_ONLY = {
  createFixture,
  runBenchmark,
};
