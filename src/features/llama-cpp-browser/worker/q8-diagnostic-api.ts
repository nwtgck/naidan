import { q8KernelDiagnosticSchemaAsset } from 'virtual:llama-cpp-browser-core/availability';
import { gpuProfilingProfile } from '@/features/llama-cpp-browser/types';
import { loadRuntime } from '@/features/llama-cpp-browser/runtime/load-runtime';
import { beginGpuMeasurement, readGpuRequests } from '@/features/llama-cpp-browser/runtime/webgpu-request-diagnostics';
import { q8DiagnosticWorkerRequestSchema, q8DiagnosticWorkerResultSchema, type Q8DiagnosticWorkerApi, type Q8DiagnosticClient } from '@/features/llama-cpp-browser/performance/q8-diagnostic-worker-types';
import { runQ8KernelBenchmark } from './q8-kernel-benchmark';

/** One request owns this entire Worker. Its client terminates the Worker on
 * every outcome, including a native trap or a still-pending JSPI suspension. */
export function createQ8DiagnosticWorkerApi({ onProgress }: { onProgress: Parameters<Q8DiagnosticClient['run']>[0]['onProgress'] }): Q8DiagnosticWorkerApi {
  let used = false;
  return {
    async run({ request }) {
      const accepted = q8DiagnosticWorkerRequestSchema.parse(request);
      if (used) {
        throw new Error('Q8 diagnostic Worker has already been used');
      }
      used = true;
      const asset = q8KernelDiagnosticSchemaAsset;
      if (asset === undefined) {
        return { status: 'unavailable', reason: 'artifact' };
      }
      if (accepted.schemaAssetSha256 !== asset.sha256) {
        throw new Error('Q8 diagnostic Worker asset identity mismatch');
      }
      const started = performance.now();
      const finishMeasurement = beginGpuMeasurement({ now: () => performance.now() });
      try {
        const core = await loadRuntime({ profile: gpuProfilingProfile, assetBaseURL: accepted.assetBaseURL });
        const diagnostic = await core.createQ8KernelDiagnostic();
        if (!diagnostic) {
          return { status: 'unavailable', reason: 'native-exports' };
        }
        // Record the binary-selected target identity separately from the build's
        // published metadata-view identity; no second schema fetch is needed.
        const compiledSchemaSha256 = core.abiFingerprint;
        const setupWallMs = performance.now() - started;
        const benchmark = await runQ8KernelBenchmark({ core, diagnostic, signal: undefined, onProgress });
        return q8DiagnosticWorkerResultSchema.parse({ status: 'completed', schemaAssetSha256: asset.sha256, compiledSchemaSha256, setupWallMs, gpuRequests: readGpuRequests({ core }), benchmark });
      } finally {
        // Pure JS observation cleanup. Native objects are never freed here after
        // an unknown failure: the owner disposes the whole Worker instead.
        finishMeasurement();
      }
    },
  };
}

export const TEST_ONLY = {
};
