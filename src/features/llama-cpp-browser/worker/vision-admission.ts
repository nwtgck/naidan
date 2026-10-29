import { captureVisionStorageObservation } from '@/features/llama-cpp-browser/runtime/vision-bf16-storage-schema';
import { visionAdmissionSchema, type VisionAdmission } from '@/features/llama-cpp-browser/performance/vision-admission-schema';
import { errorCode, type Progress } from '@/features/llama-cpp-browser/types';
import { createVisionMeasurement } from './vision-measurement';
import { unavailableVisionDiagnostic, type VisionDiagnostic } from '@/features/llama-cpp-browser/performance/vision-diagnostic-schema';
import { prepareSession } from './session';
import type { WorkerPrepareInput } from './types';

/** No image bytes are sent until the selected, loaded projector is admitted. */
export async function prepareVisionMeasurement({ request, signal, onProgress, now }: { request: WorkerPrepareInput, signal: AbortSignal, onProgress: ({ progress }: { progress: Progress }) => void, now: () => number }): Promise<VisionAdmission> {
  const started = now();
  const observation = createVisionMeasurement({ directory: request.resolvedModel.directory, now });
  let decision: { status: 'ready', capability: 'native-vision' | 'unknown-attempted-native' } | { status: 'skipped', reason: 'missing-projector' | 'native-no-vision' } | { status: 'failed', error: ReturnType<typeof errorCode> };
  try {
    signal.throwIfAborted();
    if (!request.resolvedModel.directory.projectorFile) {
      decision = { status: 'skipped', reason: 'missing-projector' };
    } else {
      const session = await prepareSession({ request: { ...request, measurement: { sequence: 'fresh', observation: 'vision' } }, signal, onProgress });
      signal.throwIfAborted();
      if (session.projectorStorage) {
        const preference = request.options.visionBf16Storage;
        observation.recordStorage({ value: captureVisionStorageObservation({ value: session.projectorStorage, preference }) });
      }
      if (session.projector === 0n) {
        throw new Error('Projector initialization produced no context');
      }
      // The native query is authoritative; a companion filename is not a vision capability.
      if (typeof session.core.api.mtmd_support_vision !== 'function') {
        decision = { status: 'ready', capability: 'unknown-attempted-native' };
      } else {
        const supported = await session.core.api.mtmd_support_vision(session.projector);
        signal.throwIfAborted();
        if (supported !== 0 && supported !== 1) {
          throw new Error('Invalid native vision capability');
        }
        decision = supported === 1 ? { status: 'ready', capability: 'native-vision' } : { status: 'skipped', reason: 'native-no-vision' };
      }
    }
  } catch (error) {
    // Failed initialization/encoding is never reclassified as an unsupported model.
    decision = { status: 'failed', error: errorCode({ error }) };
  }
  const outcome = (() => {
    switch (decision.status) {
    case 'ready': case 'skipped': return 'completed';
    case 'failed': return signal.aborted ? 'aborted' : 'failed';
    default: {
      const exhaustive: never = decision;
      throw new Error(String(exhaustive));
    }
    }
  })();
  let diagnostic: VisionDiagnostic;
  try {
    diagnostic = observation.finish({ outcome });
  } catch {
    diagnostic = unavailableVisionDiagnostic({ outcome });
  }
  return visionAdmissionSchema.parse({ version: 1, ...decision, elapsedMs: Math.max(0, now() - started), diagnostic });
}

export const TEST_ONLY = {
};
