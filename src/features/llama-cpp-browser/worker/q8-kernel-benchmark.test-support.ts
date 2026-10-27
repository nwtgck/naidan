import type { Core } from '@/features/llama-cpp-browser/runtime/core';
import type { Q8KernelDiagnosticAdapter, Q8KernelDiagnosticResult, Q8KernelDiagnosticVariant } from '@/features/llama-cpp-browser/runtime/q8-kernel-diagnostic';
import { createGpuProfileFixture } from '@/features/llama-cpp-browser/runtime/gpu-profiler.test-support';

export function createBenchmarkFixture({ base }: { base: Core }) {
  const contexts = new Set<bigint>(), buffers = new Set<bigint>(), backends = new Set<bigint>(), allocations = new Set<bigint>();
  const events: string[] = [];
  const tensors = new Map<bigint, { k: number, m: number }>();
  const operations = new Map<bigint, { weights: bigint, vector: bigint }>();
  const gpu = createGpuProfileFixture();
  const state: {
    unsupported: Set<Q8KernelDiagnosticVariant>, delay: Promise<void> | undefined, fail: boolean, corrupt: boolean,
    timestamps: 'measured' | 'quantized' | 'unavailable', calls: { variant: Q8KernelDiagnosticVariant, phase: string, repetitions: number }[],
    onInvoke: (() => void) | undefined, cleanupTrap: boolean,
    corruptAtRepetitions: number | undefined, readbackDelay: Promise<void> | undefined, onReadback: (() => void) | undefined,
  } = { unsupported: new Set(), delay: undefined, fail: false, corrupt: false, timestamps: 'measured', calls: [], onInvoke: undefined, cleanupTrap: false, corruptAtRepetitions: undefined, readbackDelay: undefined, onReadback: undefined };
  const own = ({ bytes }: { bytes: number }) => {
    const pointer = base.alloc({ bytes });
    allocations.add(pointer);
    return pointer;
  };
  const free = ({ pointer }: { pointer: bigint }) => {
    events.push('free-host');
    allocations.delete(pointer);
    base.free({ pointer });
  };
  const core = {
    ...base,
    alloc: ({ bytes }: { bytes: number | bigint }) => own({ bytes: Number(bytes) }),
    allocRecord: ({ name }: { name: string }) => {
      const pointer = base.allocRecord({ name });
      allocations.add(pointer);
      return pointer;
    },
    utf8: ({ text }: { text: string }) => {
      const pointer = base.utf8({ text });
      allocations.add(pointer);
      return pointer;
    },
    free,
    api: {
      ...base.api,

      async ggml_backend_init_by_name(_name: bigint, _params: bigint) {
        events.push('backend-init');
        const pointer = await base.api.ggml_backend_cpu_init();
        backends.add(pointer);
        return pointer;
      },

      async ggml_init(params: bigint) {
        const pointer = await base.api.ggml_init(params);
        contexts.add(pointer);
        events.push('context-init');
        return pointer;
      },

      async ggml_new_tensor_2d(context: bigint, type: number, k: bigint, m: bigint) {
        const tensor = await base.api.ggml_new_tensor_2d(context, type, k, m);
        tensors.set(tensor, { k: Number(k), m: Number(m) });
        return tensor;
      },

      async ggml_mul_mat(context: bigint, weights: bigint, vector: bigint) {
        const dst = await base.api.ggml_mul_mat(context, weights, vector);
        operations.set(dst, { weights, vector });
        return dst;
      },

      async ggml_backend_alloc_ctx_tensors(context: bigint, backend: bigint) {
        const buffer = await base.api.ggml_backend_alloc_ctx_tensors(context, backend);
        buffers.add(buffer);
        events.push('buffer-init');
        return buffer;
      },

      async ggml_backend_tensor_set(tensor: bigint, pointer: bigint, offset: bigint, length: bigint) {
        events.push('upload');
        await base.api.ggml_backend_tensor_set(tensor, pointer, offset, length);
      },

      async ggml_backend_tensor_get_async(_backend: bigint, tensor: bigint, pointer: bigint, offset: bigint, length: bigint) {
        events.push('readback');
        state.onReadback?.();
        if (state.readbackDelay) {
          await state.readbackDelay;
        }
        await base.api.ggml_backend_tensor_get(tensor, pointer, offset, length);
      },

      async ggml_backend_buffer_free(pointer: bigint) {
        events.push('free-buffer');
        if (state.cleanupTrap) {
          throw new Error('cleanup trap');
        }
        buffers.delete(pointer);
        await base.api.ggml_backend_buffer_free(pointer);
      },

      async ggml_free(pointer: bigint) {
        events.push('free-context');
        contexts.delete(pointer);
        await base.api.ggml_free(pointer);
      },

      async ggml_backend_free(pointer: bigint) {
        events.push('free-backend');
        backends.delete(pointer);
        await base.api.ggml_backend_free(pointer);
      },
    },
  } satisfies Core;
  const diagnostic: Q8KernelDiagnosticAdapter = {
    async run({ dst, variant, phase, repetitions }) {
      events.push(`run-${phase}-${repetitions}`);
      state.calls.push({ variant, phase, repetitions });
      state.onInvoke?.();
      if (state.delay) {
        await state.delay;
      }
      if (state.fail) {
        throw new Error('unexpected native failure');
      }
      const unsupported = state.unsupported.has(variant);
      const independent = variant.startsWith('independent') || variant === 'auto';
      const rows = variant.endsWith('r1') ? 1 : variant.endsWith('r2') || variant === 'auto' ? 2 : 4;
      const report: Q8KernelDiagnosticResult = {
        status: unsupported ? 'unsupported' : 'ok',
        variant,
        phase,
        algorithm: unsupported ? 'none' : independent ? 'independent' : 'cooperative',
        workgroupSize: unsupported ? 0 : ({ auto: 128, 'cooperative-wg256-r4': 256, 'independent-wg128-r4': 128, 'independent-wg128-r1': 128, 'independent-wg128-r2': 128, 'cooperative-wg128-r2': 128 }[variant]),
        logicalSubgroupSize: !unsupported && independent ? 8 : 0,
        realMinSubgroupSize: unsupported ? 0 : 8,
        realMaxSubgroupSize: unsupported ? 0 : 8,
        rowsPerTile: unsupported ? 0 : rows,
        outputsPerWorkgroup: unsupported ? 0 : independent ? rows * 16 : rows,
        cooperativeSubgroupReduction: !unsupported && !independent,
        grid: unsupported ? { x: 0, y: 0, z: 0 } : { x: 1, y: 1, z: 1 },
        dispatches: !unsupported && phase === 'execute' ? repetitions : 0,
        codegenRevision: unsupported ? 0 : 1,
        shaderSha256: unsupported ? undefined : 'a'.repeat(64),
        nativeWallMs: 0.5,
      };
      if (phase === 'execute' && !unsupported) {
        const { weights, vector } = operations.get(dst)!;
        const { k, m } = tensors.get(weights)!;
        const weightLength = Number(await base.api.ggml_nbytes(weights));
        const transfer = base.alloc({ bytes: Math.max(weightLength, k * 4, m * 4) });
        try {
          await base.api.ggml_backend_tensor_get(weights, transfer, 0n, BigInt(weightLength));
          const weightBytes = base.bytes({ pointer: transfer, length: weightLength }).slice();
          await base.api.ggml_backend_tensor_get(vector, transfer, 0n, BigInt(k * 4));
          const input = new DataView(base.bytes({ pointer: transfer, length: k * 4 }).slice().buffer);
          const result = new Uint8Array(m * 4), output = new DataView(result.buffer);
          const half = new DataView(weightBytes.buffer);
          for (let row = 0; row < m; row++) {
            let sum = 0;
            for (let column = 0; column < k; column++) {
              const block = (row * k / 32 + Math.floor(column / 32)) * 34;
              const bits = half.getUint16(block, true), exponent = (bits >>> 10) & 31, mantissa = bits & 1023;
              const scale = (bits & 0x8000 ? -1 : 1) * (exponent ? 1 + mantissa / 1024 : mantissa / 1024) * 2 ** (exponent ? exponent - 15 : -14);
              const byte = weightBytes[block + 2 + column % 32]!, quant = byte < 128 ? byte : byte - 256;
              sum += quant * scale * input.getFloat32(column * 4, true);
            }
            output.setFloat32(row * 4, sum, true);
          }
          if (state.corrupt || state.corruptAtRepetitions === repetitions) {
            result[0] = result[0]! ^ 1;
          }
          base.bytes({ pointer: transfer, length: result.length }).set(result);
          await base.api.ggml_backend_tensor_set(dst, transfer, 0n, BigInt(result.length));
        } finally {
          base.free({ pointer: transfer });
        }
        if (repetitions === 32 && state.timestamps !== 'unavailable') {
          for (let i = 0; i < repetitions; i++) {
            const query = gpu.query({ values: { quantized: [1000000n, 1000000n], measured: [1000000n, 3000000n] }[state.timestamps] });
            gpu.pass({ querySet: query }).end();
            gpu.read({ querySet: query });
          }
        }
      }
      return report;
    },
  };
  return {
    core,
    diagnostic,
    state,
    events,
    allocations,
    buffers,
    contexts,
    backends,
    async [Symbol.asyncDispose]() {
      // Test-only CPU resources after all simulated native work settles. The
      // production owner deliberately skips these frees after an unsafe failure.
      for (const buffer of buffers) {
        await base.api.ggml_backend_buffer_free(buffer);
      }
      for (const context of contexts) {
        await base.api.ggml_free(context);
      }
      for (const pointer of allocations) {
        base.free({ pointer });
      }
      for (const backend of backends) {
        await base.api.ggml_backend_free(backend);
      }
    },
  };
}
