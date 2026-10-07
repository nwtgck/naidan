import { createImageExecutionPlan } from '@/features/image-generation/execution/plan';
import { copyImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
import type { ImageClient } from '@/features/stable-diffusion-cpp-browser/worker/types';
import type { Request } from '@/features/stable-diffusion-cpp-browser/types';
import type { ImageDiagnosticListener } from '@/features/stable-diffusion-cpp-browser/diagnostics';
import type { ImageGenerationSnapshot } from '@/features/image-generation/history/snapshot';
import type { PreparedImageExecution, ImageExecutionOutcome } from '@/features/image-generation/execution/types';

/** The local adapter alone sees native requests and retained-model state.
 * The caller owns presentation, history and each job's cancellation handle. */
export function prepareLocalImageExecution({ request, snapshot, client, onDiagnostic, onModelResident }: {
  request: Request,
  snapshot: ImageGenerationSnapshot,
  client: () => ImageClient,
  onDiagnostic: ImageDiagnosticListener,
  onModelResident: ({ resident }: { resident: boolean }) => void,
}): PreparedImageExecution {
  // request was schema-projected before this boundary. Copy mutable settings;
  // File objects are immutable and intentionally not cloned or serialized.
  const captured = { ...request, parameters: { ...request.parameters }, preview: { ...request.preview },
    models: request.models.map(model => ({ ...model, companions: model.companions?.map(file => ({ ...file })) })),
    loras: request.loras.map(lora => ({ ...lora })),
    imageInputs: { ...request.imageInputs, referenceImages: [...request.imageInputs.referenceImages] },
  };
  return createImageExecutionPlan({
    snapshot, copySnapshot: copyImageGenerationSnapshot,
    start({ seed, signal, onProgress, onPreview }) {
      let owner: ImageClient | undefined;
      const result = (async (): Promise<ImageExecutionOutcome> => {
        try {
          signal.throwIfAborted();
          owner = client();
          const output = await owner.generate({ request: { ...captured, parameters: { ...captured.parameters, seed } }, signal, onProgress, onPreview, onDiagnostic });
          if ('cancelled' in output) {
            onModelResident({ resident: output.modelResident });
            return { status: 'cancelled' };
          }
          onModelResident({ resident: true });
          // Cancellation can race a native success reply. Keep real cache
          // bookkeeping, but never publish that cancelled job as a success.
          if (signal.aborted) return { status: 'cancelled' };
          return { status: 'completed', output };
        } catch (error) {
          if (signal.aborted) return { status: 'cancelled' };
          return { status: 'failed', message: (error instanceof Error ? error.message : String(error)).slice(-32768) };
        }
      })();
      return {
        result,
        cancel() {
          owner?.cancel();
        },
        updatePreview({ settings }) {
          owner?.updatePreview({ settings });
        },
      };
    },
  });
}
export const TEST_ONLY = {
};
